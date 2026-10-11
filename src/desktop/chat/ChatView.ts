import {
  getSessionMessages,
  listSessions,
  type McpServerConfig,
  type PermissionMode,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSessionInfo,
  type SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { ItemView, Notice, setIcon, type App, type Plugin, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { ContextEngine } from "../../core/context/ContextEngine";
import type { ActiveContext, Disposer, Logger } from "../../core/module-api";
import type { ModuleRegistry } from "../../core/ModuleRegistry";
import type { ChatPrefs } from "../../core/settings";
import type { HostState, ServedContext } from "../McpHost";
import { ChatSession } from "./ChatSession";
import { askPermission, askQuestions, FilePickerModal, SessionPickerModal, sessionTitle } from "./modals";
import { Transcript, type UserBubble } from "./Transcript";

export const CHAT_VIEW_TYPE = "claude-workspace-chat";

/** Appended to Claude Code's own system prompt. Keep short; documented in README. */
export const SYSTEM_PROMPT_APPEND =
  "You are running inside Obsidian, in the user's vault (the working directory). Before each user message " +
  "you get an <obsidian_context> block describing what they are looking at right now; it is generated " +
  "automatically, not typed by the user. Use the mcp__obsidian__* tools to act on live Obsidian views " +
  "(e.g. excalidraw_* for open drawings) and obsidian_open_file to show the user a file.";

const MODES: { value: ChatPrefs["permissionMode"]; label: string }[] = [
  { value: "default", label: "Ask before edits" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan" },
  { value: "auto", label: "Auto" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];

const DEFAULT_MODELS = [
  { value: "", displayName: "Default model" },
  { value: "opus", displayName: "Opus" },
  { value: "sonnet", displayName: "Sonnet" },
  { value: "haiku", displayName: "Haiku" },
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
  private bannerEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private attachmentsEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modelSelect!: HTMLSelectElement;
  private modeSelect!: HTMLSelectElement;
  private usageEl!: HTMLElement;
  private attachments: Attachment[] = [];
  private busy = false;
  private pendingBubble: UserBubble | null = null;
  private resumeId: string | null = null;
  private contextWindow = 0;
  private lastContextTokens = 0;
  private costUsd = 0;
  private models = DEFAULT_MODELS;
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
    this.titleEl = header.createDiv({ cls: "cw-title", text: "New conversation" });
    this.iconButton(header, "history", "Resume a conversation", () => void this.pickSession());
    this.iconButton(header, "square-pen", "New conversation", () => this.newConversation());

    this.bannerEl = root.createDiv({ cls: "cw-banner" });
    const messages = root.createDiv({ cls: "cw-messages" });
    this.transcript = new Transcript(this.app, this, messages, this.host.vaultPath, () => {
      messages.scrollTop = messages.scrollHeight;
    });

    const composer = root.createDiv({ cls: "cw-composer" });
    this.chipsEl = composer.createDiv({ cls: "cw-chips" });
    this.attachmentsEl = composer.createDiv({ cls: "cw-attachments" });
    this.input = composer.createEl("textarea", {
      cls: "cw-input",
      attr: { placeholder: "Ask Claude… (Enter to send, Shift+Enter for a new line, @ to mention a file)", rows: "3" },
    });
    const toolbar = composer.createDiv({ cls: "cw-toolbar" });
    this.modelSelect = toolbar.createEl("select", { cls: "dropdown cw-select" });
    this.modeSelect = toolbar.createEl("select", { cls: "dropdown cw-select" });
    this.usageEl = toolbar.createDiv({ cls: "cw-usage" });
    this.sendBtn = toolbar.createEl("button", { cls: "mod-cta cw-send" });

    this.fillModels();
    for (const m of MODES) this.modeSelect.createEl("option", { value: m.value, text: m.label });
    this.modeSelect.value = this.host.prefs().permissionMode;
    this.modelSelect.onchange = () => void this.changeModel(this.modelSelect.value);
    this.modeSelect.onchange = () => void this.changeMode(this.modeSelect.value as PermissionMode);
    this.sendBtn.onclick = () => (this.busy && !this.input.value.trim() ? void this.stop() : this.submit());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.input.addEventListener("input", () => this.onInput());
    this.input.addEventListener("paste", (e) => this.onPaste(e));
    composer.addEventListener("dragover", (e) => e.preventDefault());
    composer.addEventListener("drop", (e) => this.onDrop(e));

    this.disposers.push(this.host.engine.onChange(() => void this.refreshChips()));
    this.disposers.push(this.host.onContextServed((s) => this.onServed(s)));
    this.updateSendButton();
    void this.refreshChips();
    void this.refreshBanner();
  }

  override async onClose(): Promise<void> {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    this.session?.close();
    this.session = null;
  }

  // ───────────────────────── sending ─────────────────────────

  private submit(): void {
    const text = this.input.value.trim();
    if (!text && !this.attachments.length) return;

    const claudePath = this.host.resolveClaude();
    if (!claudePath) {
      void this.refreshBanner();
      new Notice("Claude Code executable not found — set it in the plugin settings.");
      return;
    }
    const session = this.ensureSession(claudePath);
    const content: ContentBlockParam[] = this.attachments.map((a) => ({
      type: "image",
      source: { type: "base64", media_type: a.mediaType, data: a.data },
    }));
    if (text) content.push({ type: "text", text });

    this.pendingBubble = this.transcript.addUser(text, this.attachments.length);
    this.input.value = "";
    this.attachments = [];
    this.renderAttachments();
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
      permissionMode: prefs.permissionMode,
      resume: this.resumeId ?? undefined,
      appendSystemPrompt: SYSTEM_PROMPT_APPEND,
      canUseTool: (toolName, input, opts) =>
        toolName === "AskUserQuestion"
          ? askQuestions(this.app, input, opts.signal)
          : askPermission(this.app, this, { toolName, input, ...opts }),
      onMessage: (m) => this.onMessage(m),
      onEnd: (err) => this.onSessionEnd(err),
    });
    return this.session;
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
    this.titleEl.setText(this.titleEl.getText() === "New conversation" ? "Conversation" : this.titleEl.getText());
    const obsidian = m.mcp_servers.find((s) => s.name === "obsidian");
    if (!obsidian) this.transcript.addNote("The Obsidian MCP server isn't connected; Obsidian tools are unavailable.", "error");
    else if (obsidian.status !== "connected") {
      this.transcript.addNote(`Obsidian MCP server: ${obsidian.status}. Check the port in settings.`, "error");
    }
    void this.session?.supportedModels().then((models) => {
      if (!models.length) return;
      this.models = [{ value: "", displayName: "Default model" }, ...models.filter((x) => x.value !== "default")];
      this.fillModels();
    });
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
    // If the hook never answered for this turn, the vault config is missing or stale.
    this.pendingBubble?.markMissing();
    this.pendingBubble = null;
    this.setBusy(false);
    this.updateUsage();
  }

  private onSessionEnd(err?: Error): void {
    this.setBusy(false);
    this.transcript.endTurn();
    this.pendingBubble = null;
    if (err) {
      this.transcript.addNote(`Claude Code stopped: ${err.message}`, "error");
      // Keep the session id so the next message resumes the same conversation.
      this.resumeId = this.session?.sessionId ?? this.resumeId;
      this.session = null;
    }
  }

  /** The vault's UserPromptSubmit hook fetched context: show it on the pending message. */
  private onServed(s: ServedContext): void {
    const bubble = this.pendingBubble;
    if (!bubble || bubble.hasContext) return;
    const mine = this.session?.sessionId ?? this.resumeId;
    if (mine && s.sessionId && s.sessionId !== mine) return;
    bubble.setContext(this.chipsFor(s.ctx), s.text);
  }

  private trackUsage(usage: unknown): void {
    const u = usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
    const total = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (total) this.lastContextTokens = total;
    this.updateUsage();
  }

  private updateUsage(): void {
    const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    const parts: string[] = [];
    if (this.lastContextTokens) {
      parts.push(
        this.contextWindow
          ? `${k(this.lastContextTokens)} / ${k(this.contextWindow)} (${Math.round((100 * this.lastContextTokens) / this.contextWindow)}%)`
          : `${k(this.lastContextTokens)} tokens`,
      );
    }
    if (this.costUsd) parts.push(`$${this.costUsd.toFixed(2)}`);
    this.usageEl.setText(parts.join(" · "));
    this.usageEl.setAttr("aria-label", "Context used by the conversation · session cost");
  }

  // ───────────────────────── sessions ─────────────────────────

  private newConversation(): void {
    this.session?.close();
    this.session = null;
    this.resumeId = null;
    this.pendingBubble = null;
    this.transcript.clear();
    this.titleEl.setText("New conversation");
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
      new Notice(`Could not list sessions: ${e instanceof Error ? e.message : String(e)}`);
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
    this.titleEl.setText(title ?? "Resumed conversation");
    try {
      const messages = await getSessionMessages(sessionId, { dir: this.host.vaultPath });
      for (const m of messages) this.transcript.renderHistoryMessage(m);
      this.transcript.endTurn();
    } catch (e) {
      this.transcript.addNote(`Could not load history: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    this.app.workspace.requestSaveLayout();
  }

  // ───────────────────────── pickers ─────────────────────────

  private fillModels(): void {
    const current = this.host.prefs().model;
    this.modelSelect.empty();
    const list = this.models.some((m) => m.value === current) ? this.models : [...this.models, { value: current, displayName: current }];
    for (const m of list) this.modelSelect.createEl("option", { value: m.value, text: m.displayName });
    this.modelSelect.value = current;
  }

  private async changeModel(model: string): Promise<void> {
    await this.host.savePrefs({ model });
    await this.session?.setModel(model || undefined);
  }

  private async changeMode(mode: PermissionMode): Promise<void> {
    await this.host.savePrefs({ permissionMode: mode as ChatPrefs["permissionMode"] });
    await this.session?.setPermissionMode(mode);
  }

  // ───────────────────────── composer ─────────────────────────

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.submit();
    } else if (e.key === "Escape" && this.busy) {
      e.preventDefault();
      void this.stop();
    }
  }

  private onInput(): void {
    this.updateSendButton();
    const pos = this.input.selectionStart;
    const before = this.input.value.slice(0, pos);
    if (!/(^|\s)@$/.test(before)) return;
    new FilePickerModal(this.app, (file) => {
      if (file) {
        const mention = /\s/.test(file.path) ? `@"${file.path}" ` : `@${file.path} `;
        this.input.setRangeText(mention, pos - 1, pos, "end");
      }
      this.input.focus();
    }).open();
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
      const x = item.createEl("button", { cls: "cw-attachment-remove", text: "×", attr: { "aria-label": "Remove" } });
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

  private updateSendButton(): void {
    const stopMode = this.busy && !this.input.value.trim() && !this.attachments.length;
    this.sendBtn.empty();
    setIcon(this.sendBtn, stopMode ? "square" : "send");
    this.sendBtn.setAttr("aria-label", stopMode ? "Stop (Esc)" : "Send (Enter)");
  }

  // ───────────────────────── context chips & banners ─────────────────────────

  /** Live preview of what will be sent: display only, same data as the hook. */
  private async refreshChips(): Promise<void> {
    const ctx = await this.host.engine.collect();
    this.chipsEl.empty();
    const chips = this.chipsFor(ctx);
    if (!chips.length) {
      this.chipsEl.createSpan({ cls: "cw-chip cw-chip-muted", text: "no file focused" });
      return;
    }
    for (const c of chips) this.chipsEl.createSpan({ cls: "cw-chip", text: c });
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
    const add = (text: string, action?: { label: string; run: () => void }) => {
      const row = this.bannerEl.createDiv({ cls: "cw-banner-row" });
      row.createSpan({ text });
      if (action) {
        const b = row.createEl("button", { text: action.label });
        b.onclick = action.run;
      }
    };
    if (!this.host.resolveClaude()) {
      add("Claude Code isn't installed or wasn't found.", { label: "Settings", run: () => this.host.openSettings() });
    }
    const state = this.host.serverState();
    if (state.status === "error") add(`Local server not running: ${state.message}.`, { label: "Settings", run: () => this.host.openSettings() });
    else if (!(await this.host.isInstalled())) {
      add("Claude won't see what you're looking at until the vault config is installed.", {
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
