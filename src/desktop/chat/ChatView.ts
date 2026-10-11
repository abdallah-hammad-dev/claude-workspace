import {
  getSessionMessages,
  listSessions,
  type McpServerConfig,
  type ModelInfo,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSessionInfo,
  type SDKSystemMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { ItemView, Menu, Notice, setIcon, setTooltip, type App, type Plugin, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { ContextEngine } from "../../core/context/ContextEngine";
import type { ActiveContext, Disposer, Logger } from "../../core/module-api";
import type { ModuleRegistry } from "../../core/ModuleRegistry";
import type { ChatPrefs, EffortLevel } from "../../core/settings";
import type { HostState, ServedContext } from "../McpHost";
import { ChatSession } from "./ChatSession";
import { EFFORTS, parseLocalCommand } from "./local-commands";
import { SessionPickerModal, sessionTitle } from "./modals";
import { PromptDock } from "./PromptDock";
import { filterCommands, filterFiles, InlineSuggest, mentionQuery, slashQuery } from "./suggest";
import { Transcript, type UserBubble } from "./Transcript";

export const CHAT_VIEW_TYPE = "claude-workspace-chat";

/** Appended to Claude Code's own system prompt. Keep short; documented in README. */
export const SYSTEM_PROMPT_APPEND =
  "You are running inside Obsidian, in the user's vault (the working directory). Before each user message " +
  "you get an <obsidian_context> block describing what they are looking at right now; it is generated " +
  "automatically, not typed by the user. Use the mcp__obsidian__* tools to act on live Obsidian views " +
  "(e.g. excalidraw_* for open drawings) and obsidian_open_file to show the user a file.";

type Mode = ChatPrefs["permissionMode"];

export const MODES: { value: Mode; label: string; icon: string; desc: string }[] = [
  { value: "default", label: "Ask before edits", icon: "shield-check", desc: "Asks before editing files or running commands" },
  { value: "acceptEdits", label: "Accept edits", icon: "file-pen", desc: "Edits files without asking; still asks before commands" },
  { value: "plan", label: "Plan", icon: "map", desc: "Explores and proposes a plan; changes nothing until you approve" },
  { value: "auto", label: "Auto", icon: "sparkles", desc: "Claude Code decides what is safe to do without asking" },
  { value: "bypassPermissions", label: "Bypass permissions", icon: "shield-alert", desc: "Never asks. Only for throwaway vaults" },
];

interface ModelChoice {
  value: string;
  label: string;
  desc: string;
  /** Effort levels the model accepts; [] = no effort control, undefined = unknown. */
  efforts?: EffortLevel[];
}

const FALLBACK_MODELS: ModelChoice[] = [
  { value: "", label: "Default", desc: "Claude Code's default model" },
  { value: "opus", label: "Opus", desc: "Most capable" },
  { value: "sonnet", label: "Sonnet", desc: "Fast and capable" },
  { value: "haiku", label: "Haiku", desc: "Fastest" },
];

interface Attachment {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  name: string;
}

export interface ChatHost {
  app: App;
  plugin: Plugin;
  vaultPath: string;
  engine: ContextEngine;
  registry: ModuleRegistry;
  prefs(): ChatPrefs;
  savePrefs(p: Partial<ChatPrefs>): Promise<void>;
  resolveClaude(): string | null;
  spawnEnv(claudePath: string): Record<string, string | undefined>;
  mcpServers(): Record<string, McpServerConfig>;
  serverState(): HostState;
  isInstalled(): Promise<boolean>;
  install(): Promise<void>;
  onContextServed(fn: (s: ServedContext) => void): Disposer;
  openSettings(): void;
  log: Logger;
}

/** Thin UI over the Agent SDK. Context comes from the vault's hook, never from here. */
export class ChatView extends ItemView {
  private session: ChatSession | null = null;
  private transcript!: Transcript;
  private dock!: PromptDock;
  private suggest!: InlineSuggest;
  private scroller!: HTMLElement;
  private emptyEl!: HTMLElement;
  private workingEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private headerTitleEl!: HTMLElement;
  private contextRowEl!: HTMLElement;
  private contextPreviewEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modeBtn!: HTMLButtonElement;
  private modelBtn!: HTMLButtonElement;
  private effortBtn!: HTMLButtonElement;
  private usageEl!: HTMLElement;
  private attachments: Attachment[] = [];
  private busy = false;
  private stickToBottom = true;
  /** Messages waiting for the hook's context (in send order). */
  private pendingBubbles: UserBubble[] = [];
  /** The hook answered at least once in this conversation. */
  private servedOnce = false;
  private resumeId: string | null = null;
  private contextWindow = 0;
  private lastContextTokens = 0;
  private costUsd = 0;
  private models: ModelChoice[] = FALLBACK_MODELS;
  private commands: SlashCommand[] | null = null;
  private lastCtx: ActiveContext | null = null;
  private disposers: Disposer[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: ChatHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return CHAT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Claude";
  }
  override getIcon(): string {
    return "bot";
  }

  override getState(): Record<string, unknown> {
    return { ...super.getState(), sessionId: this.session?.sessionId ?? this.resumeId };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const id = (state as { sessionId?: unknown } | null)?.sessionId;
    if (typeof id === "string" && id !== this.session?.sessionId) await this.resume(id);
    await super.setState(state, result);
  }

  override async onOpen(): Promise<void> {
    try {
      this.build();
    } catch (e) {
      // Never leave a blank panel: show what broke (also written to debug.log).
      this.host.log.error("chat view failed to open", e);
      this.contentEl.empty();
      const box = this.contentEl.createDiv({ cls: "cw-fatal" });
      box.createEl("h4", { text: "The Claude chat panel failed to load" });
      box.createEl("pre", { text: e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e) });
      box.createEl("p", { text: "This is a bug in the Claude Workspace plugin, not in Obsidian. The details are also in .obsidian/plugins/claude-workspace/debug.log." });
    }
  }

  private build(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("cw-chat");

    const header = root.createDiv({ cls: "cw-header" });
    this.headerTitleEl = header.createDiv({ cls: "cw-title", text: "New conversation" });
    this.iconButton(header, "history", "Resume a conversation", () => void this.pickSession());
    this.iconButton(header, "square-pen", "New conversation", () => this.newConversation());

    this.bannerEl = root.createDiv({ cls: "cw-banner" });

    this.scroller = root.createDiv({ cls: "cw-messages is-empty" });
    this.scroller.addEventListener("scroll", () => {
      const s = this.scroller;
      this.stickToBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 48;
    });
    this.emptyEl = this.scroller.createDiv({ cls: "cw-empty" });
    this.transcript = new Transcript(this.app, this, this.scroller.createDiv({ cls: "cw-transcript" }), this.host.vaultPath, () =>
      this.scrollToBottom(),
    );
    this.workingEl = this.scroller.createDiv({ cls: "cw-working" });
    for (let i = 0; i < 3; i++) this.workingEl.createSpan({ cls: "cw-working-dot" });
    this.workingEl.createSpan({ cls: "cw-working-text", text: "Claude is working" });

    this.dock = new PromptDock(root.createDiv(), {
      app: this.app,
      component: this,
      vaultPath: this.host.vaultPath,
      onChange: (pending) => this.onDockChange(pending),
      onModeChosen: (mode) => void this.applyMode(mode as Mode, false),
    });

    const composer = root.createDiv({ cls: "cw-composer" });
    this.suggest = new InlineSuggest(composer);
    const box = composer.createDiv({ cls: "cw-input-box" });
    this.contextRowEl = box.createDiv({ cls: "cw-context-row" });
    this.contextPreviewEl = box.createEl("pre", { cls: "cw-context-preview" });
    this.contextPreviewEl.hide();
    this.attachmentsEl = box.createDiv({ cls: "cw-attachments" });
    this.input = box.createEl("textarea", { cls: "cw-input", attr: { rows: "1" } });
    const footer = box.createDiv({ cls: "cw-input-footer" });
    this.modeBtn = footer.createEl("button", { cls: "cw-footer-btn" });
    this.modelBtn = footer.createEl("button", { cls: "cw-footer-btn" });
    this.effortBtn = footer.createEl("button", { cls: "cw-footer-btn" });
    footer.createDiv({ cls: "cw-spacer" });
    this.usageEl = footer.createDiv({ cls: "cw-usage" });
    this.sendBtn = footer.createEl("button", { cls: "cw-send" });

    this.modeBtn.onclick = () => this.openModeMenu();
    this.modelBtn.onclick = () => this.openModelMenu();
    this.effortBtn.onclick = () => this.openEffortMenu();
    this.sendBtn.onclick = () => (this.isStopMode() ? void this.stop() : this.submit());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("focus", () => this.warm());
    this.input.addEventListener("blur", () => window.setTimeout(() => this.suggest.hide(), 150));
    this.input.addEventListener("paste", (e) => this.onPaste(e));
    box.addEventListener("click", (e) => {
      if (e.target === box) this.input.focus();
    });
    composer.addEventListener("dragover", (e) => e.preventDefault());
    composer.addEventListener("drop", (e) => this.onDrop(e));

    this.disposers.push(this.host.engine.onChange(() => void this.refreshContext()));
    this.disposers.push(this.host.onContextServed((s) => this.onServed(s)));
    this.updatePlaceholder();
    this.updateModeButton();
    this.updateModelButton();
    this.updateEffortButton();
    this.updateSendButton();
    this.updateUsage();
    this.renderEmpty();
    void this.refreshContext();
    void this.refreshBanner();
  }

  override async onClose(): Promise<void> {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.dock?.cancelAll();
    this.session?.close();
    this.session = null;
  }

  // ───────────────────────── sending ─────────────────────────

  private submit(): void {
    const text = this.input.value.trim();

    // A card is waiting: the text answers it ("do this instead").
    if (this.dock.pending) {
      if (!text) return;
      this.showTranscript();
      this.transcript.addUser(text, { expectContext: false, label: "Instead" });
      this.clearInput();
      this.dock.answerWithText(text);
      return;
    }
    if (!text && !this.attachments.length) return;
    if (!this.attachments.length && this.runLocalCommand(text)) {
      this.clearInput();
      return;
    }

    const claudePath = this.host.resolveClaude();
    if (!claudePath) {
      void this.refreshBanner();
      new Notice("Claude Code executable not found. Set it in the plugin settings.");
      return;
    }
    const session = this.ensureSession(claudePath);
    const content: ContentBlockParam[] = this.attachments.map((a) => ({
      type: "image",
      source: { type: "base64", media_type: a.mediaType, data: a.data },
    }));
    if (text) content.push({ type: "text", text });

    this.showTranscript();
    const isCommand = text.startsWith("/");
    const bubble = this.transcript.addUser(text, { images: this.attachments.length, expectContext: !isCommand });
    if (!isCommand) this.pendingBubbles.push(bubble);
    if (this.headerTitleEl.getText() === "New conversation" && text && !isCommand) {
      this.headerTitleEl.setText(text.length > 60 ? `${text.slice(0, 60)}…` : text);
    }
    this.clearInput();
    this.stickToBottom = true;
    this.setBusy(true);
    try {
      session.send(content.length === 1 && text ? text : content);
    } catch (e) {
      this.transcript.addNote(`Could not send: ${e instanceof Error ? e.message : String(e)}`, "error");
      this.setBusy(false);
    }
  }

  private ensureSession(claudePath: string): ChatSession {
    if (this.session) return this.session;
    const prefs = this.host.prefs();
    this.session = new ChatSession({
      cwd: this.host.vaultPath,
      claudePath,
      env: this.host.spawnEnv(claudePath),
      mcpServers: this.host.mcpServers(),
      model: prefs.model || undefined,
      effort: prefs.effort || undefined,
      permissionMode: prefs.permissionMode,
      resume: this.resumeId ?? undefined,
      appendSystemPrompt: SYSTEM_PROMPT_APPEND,
      canUseTool: (toolName, input, opts) =>
        toolName === "AskUserQuestion" ? this.dock.askQuestions(input, opts.signal) : this.dock.askPermission({ toolName, input, ...opts }),
      onMessage: (m) => this.onMessage(m),
      onEnd: (err) => this.onSessionEnd(err),
    });
    return this.session;
  }

  /** Start Claude Code in the background so slash commands and models are ready. */
  private warm(): void {
    if (this.session && this.commands) return;
    const claudePath = this.host.resolveClaude();
    if (!claudePath) return;
    const session = this.ensureSession(claudePath);
    session.warmup();
    void session.initialization().then((init) => {
      if (!init || session !== this.session) return;
      this.commands = init.commands;
      this.models = toModelChoices(init.models);
      this.updateModelButton();
      this.updateEffortButton();
      if (this.suggest.isOpen) this.onInput();
    });
  }

  /** `/clear`, `/effort` and `/model` are handled here; returns false to send the text to Claude Code. */
  private runLocalCommand(text: string): boolean {
    const cmd = parseLocalCommand(text);
    if (!cmd) return false;
    switch (cmd.kind) {
      case "clear":
        this.newConversation();
        break;
      case "effort":
        if (cmd.level !== null) void this.changeEffort(cmd.level);
        else {
          if (cmd.arg) new Notice(`Unknown effort level "${cmd.arg}". Use low, medium, high, xhigh, max or auto.`);
          this.openEffortMenu();
        }
        break;
      case "model": {
        if (!cmd.arg) {
          this.openModelMenu();
          break;
        }
        const a = cmd.arg.toLowerCase();
        const match = this.models.find((m) => m.value.toLowerCase() === a || m.label.toLowerCase() === a);
        void this.changeModel(a === "default" ? "" : (match?.value ?? cmd.arg));
        break;
      }
    }
    return true;
  }

  private async stop(): Promise<void> {
    try {
      await this.session?.interrupt();
    } catch (e) {
      this.host.log.warn("interrupt failed", e instanceof Error ? e.message : e);
    }
  }

  // ───────────────────────── SDK messages ─────────────────────────

  private onMessage(m: SDKMessage): void {
    switch (m.type) {
      case "stream_event":
        this.transcript.onStreamEvent(m);
        break;
      case "assistant":
        this.transcript.onAssistant(m);
        if (!m.parent_tool_use_id) this.trackUsage(m.message.usage);
        if (m.error) this.transcript.addNote(`API error: ${m.error}`, "error");
        break;
      case "user":
        this.transcript.onUser(m);
        break;
      case "result":
        this.onResult(m);
        break;
      case "system":
        this.onSystem(m);
        break;
      default:
        break;
    }
  }

  private onSystem(m: SDKMessage & { type: "system" }): void {
    switch (m.subtype) {
      case "init":
        this.onInit(m);
        break;
      case "compact_boundary":
        this.transcript.addNote("Conversation compacted", "divider");
        break;
      case "api_retry": {
        const r = m as { attempt?: number; max_retries?: number };
        this.transcript.addNote(`API error, retrying (${r.attempt}/${r.max_retries})…`);
        break;
      }
      case "local_command_output":
      case "informational": {
        const content = (m as { content?: unknown }).content;
        if (typeof content === "string" && content.trim()) this.transcript.addNote(content);
        break;
      }
      default:
        break;
    }
  }

  private onInit(m: SDKSystemMessage): void {
    const obsidian = m.mcp_servers.find((s) => s.name === "obsidian");
    if (!obsidian) this.transcript.addNote("The Obsidian MCP server isn't connected; Obsidian tools are unavailable.", "error");
    else if (obsidian.status !== "connected") {
      this.transcript.addNote(`Obsidian MCP server: ${obsidian.status}. Check the port in settings.`, "error");
    }
  }

  private onResult(m: SDKResultMessage): void {
    this.transcript.endTurn();
    if (m.subtype !== "success") {
      const errors = (m as { errors?: string[] }).errors ?? [];
      if (m.subtype !== "error_during_execution" || errors.length) {
        this.transcript.addNote(`Stopped: ${m.subtype.replace(/_/g, " ")}${errors.length ? ` — ${errors.join("; ")}` : ""}`, "error");
      }
    }
    this.costUsd = m.total_cost_usd;
    for (const u of Object.values(m.modelUsage ?? {})) if (u.contextWindow) this.contextWindow = u.contextWindow;
    // The hook never answered in this conversation: the vault config is missing or stale.
    if (!this.servedOnce) for (const b of this.pendingBubbles) b.markMissing();
    this.pendingBubbles = this.pendingBubbles.filter((b) => !b.hasContext);
    this.setBusy(false);
    this.updateUsage();
  }

  private onSessionEnd(err?: Error): void {
    this.setBusy(false);
    this.transcript.endTurn();
    this.dock.cancelAll();
    if (err) {
      this.showTranscript();
      this.transcript.addNote(`Claude Code stopped: ${err.message}`, "error");
      // Keep the session id so the next message resumes the same conversation.
      this.resumeId = this.session?.sessionId ?? this.resumeId;
      this.session = null;
    }
  }

  /** The vault's UserPromptSubmit hook fetched context: show it on the oldest waiting message. */
  private onServed(s: ServedContext): void {
    const mine = this.session?.sessionId ?? this.resumeId;
    if (mine && s.sessionId && s.sessionId !== mine) return;
    const bubble = this.pendingBubbles.find((b) => !b.hasContext);
    if (!bubble) return;
    this.servedOnce = true;
    bubble.setContext(this.chipsFor(s.ctx), s.text);
    this.pendingBubbles = this.pendingBubbles.filter((b) => !b.hasContext);
  }

  private trackUsage(usage: unknown): void {
    const u = usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (total) this.lastContextTokens = total;
    this.updateUsage();
  }

  private updateUsage(): void {
    this.usageEl.empty();
    if (!this.lastContextTokens) {
      this.usageEl.hide();
      return;
    }
    this.usageEl.show();
    const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const pct = this.contextWindow ? Math.min(100, Math.round((100 * this.lastContextTokens) / this.contextWindow)) : null;
    const ring = this.usageEl.createSpan({ cls: "cw-usage-ring" });
    ring.style.setProperty("--cw-usage", `${pct ?? 0}%`);
    this.usageEl.createSpan({ text: pct !== null ? `${pct}%` : k(this.lastContextTokens) });
    this.usageEl.toggleClass("is-high", (pct ?? 0) >= 80);
    const tip = [
      `Context: ${k(this.lastContextTokens)}${this.contextWindow ? ` of ${k(this.contextWindow)}` : ""} tokens`,
      this.costUsd ? `Session cost: $${this.costUsd.toFixed(2)}` : "",
      "Type /compact to free up context.",
    ];
    setTooltip(this.usageEl, tip.filter(Boolean).join("\n"), { placement: "top" });
  }

  // ───────────────────────── sessions ─────────────────────────

  private newConversation(): void {
    this.dock.cancelAll();
    this.session?.close();
    this.session = null;
    this.commands = null;
    this.resumeId = null;
    this.pendingBubbles = [];
    this.servedOnce = false;
    this.transcript.clear();
    this.scroller.addClass("is-empty");
    this.renderEmpty();
    this.headerTitleEl.setText("New conversation");
    this.lastContextTokens = 0;
    this.costUsd = 0;
    this.updateUsage();
    this.setBusy(false);
    this.app.workspace.requestSaveLayout();
  }

  private async pickSession(): Promise<void> {
    let sessions: SDKSessionInfo[];
    try {
      sessions = await listSessions({ dir: this.host.vaultPath });
    } catch (e) {
      new Notice(`Could not list conversations: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    sessions.sort((a, b) => b.lastModified - a.lastModified);
    if (!sessions.length) {
      new Notice("No previous conversations in this vault.");
      return;
    }
    new SessionPickerModal(this.app, sessions, (s) => void this.resume(s.sessionId, sessionTitle(s))).open();
  }

  /** Load a Claude Code session (also ones started with `claude` in a terminal) and continue it. */
  private async resume(sessionId: string, title?: string): Promise<void> {
    this.newConversation();
    this.resumeId = sessionId;
    this.headerTitleEl.setText(title ?? "Resumed conversation");
    try {
      const messages = await getSessionMessages(sessionId, { dir: this.host.vaultPath });
      if (messages.length) this.showTranscript();
      for (const m of messages) this.transcript.renderHistoryMessage(m);
      this.transcript.endTurn();
      this.stickToBottom = true;
      this.scrollToBottom();
    } catch (e) {
      this.showTranscript();
      this.transcript.addNote(`Could not load history: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    this.app.workspace.requestSaveLayout();
  }

  // ───────────────────────── mode & model ─────────────────────────

  private openModeMenu(): void {
    const current = this.host.prefs().permissionMode;
    const menu = new Menu();
    for (const m of MODES) {
      menu.addItem((item) =>
        item
          .setTitle(menuLabel(m.label, m.desc))
          .setIcon(m.icon)
          .setChecked(m.value === current)
          .setWarning(m.value === "bypassPermissions")
          .onClick(() => void this.applyMode(m.value, true)),
      );
    }
    showMenuAbove(menu, this.modeBtn);
  }

  private async applyMode(mode: Mode, tellSession: boolean): Promise<void> {
    await this.host.savePrefs({ permissionMode: mode });
    this.updateModeButton();
    if (tellSession) await this.session?.setPermissionMode(mode);
  }

  private updateModeButton(): void {
    const mode = MODES.find((m) => m.value === this.host.prefs().permissionMode) ?? MODES[0]!;
    this.modeBtn.empty();
    setIcon(this.modeBtn.createSpan({ cls: "cw-footer-icon" }), mode.icon);
    this.modeBtn.createSpan({ cls: "cw-footer-label", text: mode.label });
    this.modeBtn.toggleClass("is-danger", mode.value === "bypassPermissions");
    setTooltip(this.modeBtn, `Permission mode: ${mode.desc}`, { placement: "top" });
  }

  private openModelMenu(): void {
    this.warm();
    const current = this.host.prefs().model;
    const menu = new Menu();
    const aliases = this.models.filter((m) => !m.value.startsWith("claude-"));
    const ids = this.models.filter((m) => m.value.startsWith("claude-"));
    for (const m of aliases) {
      menu.addItem((item) =>
        item
          .setTitle(menuLabel(m.label, m.desc))
          .setChecked(m.value === current)
          .onClick(() => void this.changeModel(m.value)),
      );
    }
    if (ids.length) {
      menu.addSeparator();
      for (const m of ids) {
        menu.addItem((item) =>
          item
            .setTitle(m.label)
            .setChecked(m.value === current)
            .onClick(() => void this.changeModel(m.value)),
        );
      }
    }
    showMenuAbove(menu, this.modelBtn);
  }

  private async changeModel(model: string): Promise<void> {
    await this.host.savePrefs({ model });
    this.updateModelButton();
    this.updateEffortButton();
    await this.session?.setModel(model || undefined);
  }

  private updateModelButton(): void {
    const value = this.host.prefs().model;
    const m = this.models.find((x) => x.value === value);
    this.modelBtn.empty();
    // "Default (recommended)" is too long for a narrow panel; the menu keeps the full name.
    const label = (m?.label ?? (value || "Default")).replace(/\s*\(recommended\)$/i, "");
    this.modelBtn.createSpan({ cls: "cw-footer-label", text: label });
    setIcon(this.modelBtn.createSpan({ cls: "cw-footer-chevron" }), "chevron-down");
    setTooltip(this.modelBtn, "Model", { placement: "top" });
  }

  /** Levels the selected model accepts (all of them while Claude Code hasn't said). */
  private effortLevels(): typeof EFFORTS {
    const levels = this.models.find((m) => m.value === this.host.prefs().model)?.efforts;
    return levels ? EFFORTS.filter((e) => levels.includes(e.value)) : EFFORTS;
  }

  private openEffortMenu(): void {
    this.warm();
    const current = this.host.prefs().effort;
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle(menuLabel("Default", "The model's usual level"))
        .setChecked(current === "")
        .onClick(() => void this.changeEffort("")),
    );
    menu.addSeparator();
    for (const e of this.effortLevels()) {
      menu.addItem((item) =>
        item
          .setTitle(menuLabel(e.label, e.desc))
          .setChecked(e.value === current)
          .onClick(() => void this.changeEffort(e.value)),
      );
    }
    showMenuAbove(menu, this.effortBtn.isShown() ? this.effortBtn : this.modelBtn);
  }

  private async changeEffort(effort: EffortLevel | ""): Promise<void> {
    await this.host.savePrefs({ effort });
    this.updateEffortButton();
    await this.session?.setEffort(effort || undefined);
  }

  private updateEffortButton(): void {
    const btn = this.effortBtn;
    const supported = this.models.find((m) => m.value === this.host.prefs().model)?.efforts;
    btn.toggle(!supported || supported.length > 0);
    const current = EFFORTS.find((e) => e.value === this.host.prefs().effort);
    btn.empty();
    setIcon(btn.createSpan({ cls: "cw-footer-icon" }), "brain");
    if (current) btn.createSpan({ cls: "cw-footer-label", text: current.label });
    const capped = current && supported && !supported.includes(current.value);
    setTooltip(
      btn,
      current
        ? `Effort: ${current.label}${capped ? " (not supported by this model; Claude Code lowers it)" : ""}`
        : "Effort: default for this model. Click to think harder or answer faster.",
      { placement: "top" },
    );
  }

  // ───────────────────────── composer ─────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (this.suggest.handleKey(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    } else if (e.key === "Escape" && this.busy) {
      e.preventDefault();
      void this.stop();
    }
  }

  private onInput(): void {
    this.autoGrow();
    this.updateSendButton();
    const value = this.input.value;
    const cursor = this.input.selectionStart;

    const slash = slashQuery(value, cursor);
    if (slash !== null && !this.dock.pending) {
      this.warm();
      if (!this.commands) {
        this.suggest.show([], () => undefined, "Loading commands…");
        return;
      }
      const items = filterCommands(this.commands, slash).map((c) => ({
        insert: `/${c.name} `,
        title: `/${c.name}`,
        hint: c.argumentHint || undefined,
        description: c.description,
      }));
      this.suggest.show(items, (item) => this.replaceRange(0, cursor, item.insert), "No matching command");
      return;
    }

    const mention = mentionQuery(value, cursor);
    if (mention) {
      const recent = this.app.workspace.getLastOpenFiles();
      const paths = filterFiles(
        this.app.vault.getFiles().map((f) => f.path),
        mention.query,
        recent,
      );
      const items = paths.map((p) => ({
        insert: /\s/.test(p) ? `@"${p}" ` : `@${p} `,
        title: p.split("/").pop() ?? p,
        description: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : undefined,
        icon: p.endsWith(".excalidraw.md") ? "shapes" : p.endsWith(".md") ? "file-text" : "file",
      }));
      this.suggest.show(items, (item) => this.replaceRange(mention.start, cursor, item.insert), "No matching file");
      return;
    }
    this.suggest.hide();
  }

  private replaceRange(from: number, to: number, text: string): void {
    this.input.setRangeText(text, from, to, "end");
    this.input.focus();
    this.onInput();
  }

  private autoGrow(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 240)}px`;
  }

  private clearInput(): void {
    this.input.value = "";
    this.attachments = [];
    this.renderAttachments();
    this.suggest.hide();
    this.autoGrow();
    this.updateSendButton();
  }

  private onPaste(e: ClipboardEvent): void {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void this.addImages(files);
  }

  private onDrop(e: DragEvent): void {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    void this.addImages(files);
  }

  private async addImages(files: File[]): Promise<void> {
    for (const f of files) {
      const mediaType = f.type as Attachment["mediaType"];
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)) continue;
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      this.attachments.push({ mediaType, data: btoa(bin), name: f.name || "image" });
    }
    this.renderAttachments();
  }

  private renderAttachments(): void {
    this.attachmentsEl.empty();
    this.attachments.forEach((a, i) => {
      const item = this.attachmentsEl.createDiv({ cls: "cw-attachment" });
      item.createEl("img", { attr: { src: `data:${a.mediaType};base64,${a.data}`, alt: a.name } });
      const x = item.createEl("button", { cls: "cw-attachment-remove", attr: { "aria-label": "Remove image" } });
      setIcon(x, "x");
      x.onclick = () => {
        this.attachments.splice(i, 1);
        this.renderAttachments();
      };
    });
    this.updateSendButton();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.contentEl.toggleClass("is-busy", busy);
    this.updateSendButton();
  }

  private isStopMode(): boolean {
    return this.busy && !this.input.value.trim() && !this.attachments.length;
  }

  private updateSendButton(): void {
    const stop = this.isStopMode();
    const empty = !this.input.value.trim() && !this.attachments.length;
    this.sendBtn.empty();
    setIcon(this.sendBtn, stop ? "square" : "arrow-up");
    this.sendBtn.toggleClass("is-stop", stop);
    this.sendBtn.toggleClass("is-disabled", !stop && empty);
    this.sendBtn.setAttr("aria-label", stop ? "Stop (Esc)" : "Send (Enter)");
  }

  private updatePlaceholder(): void {
    this.input.placeholder = this.dock.pending ? this.dock.composerHint : "Ask Claude… @ to mention a file, / for commands";
  }

  private onDockChange(pending: boolean): void {
    this.updatePlaceholder();
    this.scrollToBottom();
    if (pending && !this.contentEl.isShown()) {
      const notice = new Notice("Claude is waiting for your answer in the chat panel. Click to open it.", 8000);
      notice.noticeEl.onclick = () => void this.app.workspace.revealLeaf(this.leaf);
    }
  }

  // ───────────────────────── transcript chrome ─────────────────────────

  private showTranscript(): void {
    this.scroller.removeClass("is-empty");
  }

  private scrollToBottom(): void {
    if (this.stickToBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  private renderEmpty(): void {
    if (!this.scroller.hasClass("is-empty")) return;
    const el = this.emptyEl;
    el.empty();
    setIcon(el.createDiv({ cls: "cw-empty-icon" }), "bot");
    el.createDiv({ cls: "cw-empty-title", text: "What can I help with?" });
    el.createDiv({
      cls: "cw-empty-sub",
      text: "Claude sees the note or drawing you're working in and your selection, and can act on them.",
    });
    const list = el.createDiv({ cls: "cw-empty-suggestions" });
    for (const s of suggestionsFor(this.lastCtx)) {
      const b = list.createEl("button", { cls: "cw-empty-suggestion" });
      setIcon(b.createSpan(), s.icon);
      b.createSpan({ text: s.text });
      b.onclick = () => {
        this.input.value = s.text;
        this.input.focus();
        this.onInput();
      };
    }
  }

  // ───────────────────────── context & banners ─────────────────────────

  /** Live preview of what will be sent: display only, same data as the hook. */
  private async refreshContext(): Promise<void> {
    const ctx = await this.host.engine.collect();
    this.lastCtx = ctx;
    const row = this.contextRowEl;
    row.empty();
    const chip = row.createEl("button", { cls: "cw-context-chip" });
    const chips = this.chipsFor(ctx);
    if (!ctx.activeFile) {
      chip.addClass("is-muted");
      setIcon(chip.createSpan({ cls: "cw-context-chip-icon" }), "eye");
      chip.createSpan({ text: "No note focused" });
    } else {
      setIcon(chip.createSpan({ cls: "cw-context-chip-icon" }), ctx.activeFile.viewType === "excalidraw" ? "shapes" : "file-text");
      chip.createSpan({ cls: "cw-context-chip-file", text: chips[0] ?? "" });
      for (const extra of chips.slice(1)) chip.createSpan({ cls: "cw-context-chip-extra", text: extra });
    }
    setTooltip(chip, "Claude sees this with your next message. Click to preview exactly what is sent.", { placement: "top" });
    chip.onclick = () => void this.toggleContextPreview();
    if (this.contextPreviewEl.isShown()) void this.toggleContextPreview(true);
    this.renderEmpty();
  }

  private async toggleContextPreview(refresh = false): Promise<void> {
    const el = this.contextPreviewEl;
    if (el.isShown() && !refresh) {
      el.hide();
      return;
    }
    const { text } = await this.host.engine.renderCurrent();
    el.setText(text || "Nothing: no note or drawing is focused.");
    el.show();
  }

  private chipsFor(ctx: ActiveContext): string[] {
    const chips: string[] = [];
    if (ctx.activeFile) chips.push(ctx.activeFile.path.split("/").pop() ?? ctx.activeFile.path);
    for (const [key, data] of Object.entries(ctx.providers)) {
      const label = this.host.registry.getProvider(key)?.provider.chip?.(data);
      if (label) chips.push(label);
    }
    return chips;
  }

  private async refreshBanner(): Promise<void> {
    this.bannerEl.empty();
    const add = (icon: string, title: string, text: string, action?: { label: string; run: () => void }) => {
      const card = this.bannerEl.createDiv({ cls: "cw-banner-card" });
      setIcon(card.createSpan({ cls: "cw-banner-icon" }), icon);
      const body = card.createDiv({ cls: "cw-banner-body" });
      body.createDiv({ cls: "cw-banner-title", text: title });
      body.createDiv({ cls: "cw-banner-text", text });
      if (action) {
        const b = card.createEl("button", { cls: "mod-cta", text: action.label });
        b.onclick = action.run;
      }
    };
    if (!this.host.resolveClaude()) {
      add("triangle-alert", "Claude Code not found", "Install Claude Code, or set its path in settings.", {
        label: "Settings",
        run: () => this.host.openSettings(),
      });
    }
    const state = this.host.serverState();
    if (state.status === "error") {
      add("triangle-alert", "Local server not running", state.message, { label: "Settings", run: () => this.host.openSettings() });
    } else if (!(await this.host.isInstalled())) {
      add("plug", "Connect this vault", "Claude won't see what you're looking at until the vault config is installed.", {
        label: "Install",
        run: () =>
          void this.host.install().then(() => {
            // A running session loaded the old settings; start fresh so the hook applies.
            if (this.session) this.newConversation();
            void this.refreshBanner();
          }),
      });
    }
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
    const b = parent.createEl("button", { cls: "clickable-icon cw-icon-btn", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.onclick = onClick;
  }
}

function toModelChoices(models: ModelInfo[]): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const m of models) {
    const value = m.value === "default" ? "" : m.value;
    if (out.some((x) => x.value === value)) continue;
    const efforts = m.supportsEffort === false ? [] : m.supportedEffortLevels;
    out.push({ value, label: m.displayName || m.value, desc: m.description ?? "", efforts });
  }
  if (!out.some((x) => x.value === "")) out.unshift(FALLBACK_MODELS[0]!);
  return out;
}

function menuLabel(title: string, desc: string): DocumentFragment {
  return createFragment((f) => {
    f.createDiv({ cls: "cw-menu-title", text: title });
    if (desc) f.createDiv({ cls: "cw-menu-desc", text: desc });
  });
}

/** Composer menus open upwards from their button. */
function showMenuAbove(menu: Menu, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.top, overlap: true });
}

function suggestionsFor(ctx: ActiveContext | null): { icon: string; text: string }[] {
  const view = ctx?.activeFile?.viewType;
  if (view === "excalidraw") {
    return [
      { icon: "shapes", text: "Describe this drawing" },
      { icon: "sparkles", text: "Tidy up the layout of this drawing" },
      { icon: "file-text", text: "Write a note that explains this drawing" },
    ];
  }
  if (view === "markdown") {
    return [
      { icon: "file-text", text: "Summarize this note" },
      { icon: "search", text: "Find notes related to this one and suggest links" },
      { icon: "shapes", text: "Draw a diagram of this note in Excalidraw" },
    ];
  }
  return [
    { icon: "search", text: "What's in this vault?" },
    { icon: "file-plus", text: "Create a note for today's ideas" },
  ];
}
