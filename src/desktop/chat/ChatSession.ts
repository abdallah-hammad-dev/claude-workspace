import { spawn } from "node:child_process";
import {
  query,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type SlashCommand,
  type McpServerConfig,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { readAppliedSettings, type AppliedSettings } from "./applied-settings";

export interface SessionInit {
  commands: SlashCommand[];
  models: ModelInfo[];
}

export interface ChatSessionOptions {
  cwd: string;
  claudePath: string;
  env: Record<string, string | undefined>;
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  /** Unset = Claude Code's default for the model. */
  effort?: EffortLevel;
  permissionMode: PermissionMode;
  resume?: string;
  appendSystemPrompt: string;
  canUseTool: CanUseTool;
  onMessage(msg: SDKMessage): void;
  /** The Claude Code process ended (error set if it wasn't a clean close). */
  onEnd(error?: Error): void;
}

/**
 * One Claude Code conversation over the Agent SDK in streaming-input mode
 * (needed for interrupt / setModel / setPermissionMode). No DOM here.
 */
export class ChatSession {
  sessionId: string | null;
  private q: Query | null = null;
  private input: InputQueue<SDKUserMessage> | null = null;
  private abort: AbortController | null = null;
  private stderrTail: string[] = [];
  private closed = false;
  private init: Promise<SessionInit | null> | null = null;

  constructor(private opts: ChatSessionOptions) {
    this.sessionId = opts.resume ?? null;
  }

  get running(): boolean {
    return !!this.q;
  }

  /** Start Claude Code without sending anything (commands and models become available in ~1 s). */
  warmup(): void {
    if (!this.closed && !this.q) this.start();
  }

  /** Slash commands and models Claude Code reported at startup; null if the process isn't running. */
  initialization(): Promise<SessionInit | null> {
    if (!this.q) return Promise.resolve(null);
    const q = this.q;
    this.init ??= q.initializationResult().then(
      (r) => ({ commands: r.commands, models: r.models }),
      () => null,
    );
    return this.init;
  }

  /** The model and effort Claude Code really uses (null if unknown or not running). */
  applied(): Promise<AppliedSettings | null> {
    return this.q ? readAppliedSettings(this.q) : Promise.resolve(null);
  }

  send(content: string | ContentBlockParam[]): void {
    if (this.closed) throw new Error("session closed");
    if (!this.q) this.start();
    this.input!.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt();
  }

  async setModel(model: string | undefined): Promise<void> {
    this.opts = { ...this.opts, model };
    await this.q?.setModel(model);
  }

  /** Undefined goes back to the model's default level. */
  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    this.opts = { ...this.opts, effort };
    await this.q?.applyFlagSettings({ effortLevel: effort ?? null });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.opts = { ...this.opts, permissionMode: mode };
    await this.q?.setPermissionMode(mode);
  }

  close(): void {
    this.closed = true;
    this.input?.end();
    this.q?.close();
    this.abort?.abort();
    this.q = null;
  }

  private start(): void {
    const o = this.opts;
    this.input = new InputQueue();
    this.abort = new AbortController();
    this.init = null;
    this.stderrTail = [];
    this.q = query({
      prompt: this.input,
      options: {
        cwd: o.cwd,
        pathToClaudeCodeExecutable: o.claudePath,
        env: o.env,
        // Same CLAUDE.md, skills, hooks, permissions and .mcp.json as `claude` in a terminal.
        settingSources: ["user", "project", "local"],
        systemPrompt: { type: "preset", preset: "claude_code", append: o.appendSystemPrompt },
        mcpServers: o.mcpServers,
        includePartialMessages: true,
        permissionMode: o.permissionMode,
        model: o.model,
        effort: o.effort,
        resume: this.sessionId ?? undefined,
        canUseTool: o.canUseTool,
        abortController: this.abort,
        spawnClaudeCodeProcess: (s) => this.spawn(s),
      },
    });
    void this.pump(this.q);
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if ("session_id" in msg && typeof msg.session_id === "string") this.sessionId = msg.session_id;
        this.opts.onMessage(msg);
      }
      if (this.q === q) this.q = null;
      this.opts.onEnd();
    } catch (e) {
      if (this.q === q) this.q = null;
      const tail = this.stderrTail.join("").trim().split("\n").slice(-8).join("\n");
      const base = e instanceof Error ? e.message : String(e);
      this.opts.onEnd(this.closed ? undefined : new Error(tail ? `${base}\n${tail}` : base));
    }
  }

  /**
   * Spawn without passing `signal` to Node: Electron's renderer has a different
   * AbortSignal realm and Node's instanceof checks fail (pattern from Claudian).
   */
  private spawn(s: SpawnOptions): SpawnedProcess {
    const child = spawn(s.command, s.args, {
      cwd: s.cwd,
      env: s.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr?.on("data", (d: Buffer) => {
      this.stderrTail.push(d.toString());
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });
    const signal = (s as SpawnOptions & { signal?: AbortSignal }).signal;
    if (signal) {
      const kill = () => child.kill("SIGTERM");
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
    return child;
  }
}

/** Async iterable the SDK pulls user messages from. */
export class InputQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
