import { Keymap, MarkdownRenderer, TFile, setIcon, type App, type Component } from "obsidian";
import type { SDKAssistantMessage, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { toVaultPath } from "../../core/paths";
import { displayToolName, renderToolInput, toolFilePath, toolResultText, toolSummary } from "./tool-render";

type Block =
  | { kind: "text"; el: HTMLElement; text: string; final: boolean }
  | { kind: "thinking"; el: HTMLElement; body: HTMLElement; text: string; final: boolean }
  | { kind: "tool"; id: string; tool: ToolBlock; final: boolean };

const RENDER_THROTTLE_MS = 80;
const MAX_RESULT_CHARS = 4000;

/**
 * Renders a conversation from SDK messages. Stream events give live text;
 * the complete `assistant` message that follows finalizes each block.
 */
export class Transcript {
  /** Blocks of the message being streamed, keyed `${messageId}:${index}`. */
  private readonly streaming = new Map<string, Block>();
  private readonly tools = new Map<string, ToolBlock>();
  private currentMessageId: string | null = null;
  private renderTimers = new Map<HTMLElement, number>();

  constructor(
    private readonly app: App,
    private readonly component: Component,
    readonly el: HTMLElement,
    private readonly vaultPath: string,
    private readonly onScroll: () => void,
  ) {
    el.addEventListener("click", (evt) => this.onClick(evt));
  }

  clear(): void {
    this.el.empty();
    this.streaming.clear();
    this.tools.clear();
    this.currentMessageId = null;
  }

  addUser(text: string, imageCount = 0): UserBubble {
    const el = this.el.createDiv({ cls: "cw-msg cw-user" });
    const body = el.createDiv({ cls: "cw-user-text", text });
    if (imageCount) body.createDiv({ cls: "cw-muted", text: `📎 ${imageCount} image${imageCount > 1 ? "s" : ""}` });
    const chips = el.createDiv({ cls: "cw-sent-context" });
    this.onScroll();
    return new UserBubble(chips);
  }

  addNote(text: string, kind: "info" | "error" | "divider" = "info"): HTMLElement {
    const el = this.el.createDiv({ cls: `cw-note cw-note-${kind}` });
    if (kind === "divider") el.createSpan({ text });
    else void this.renderMarkdown(el, text);
    this.onScroll();
    return el;
  }

  // ───────────────────────── streaming ─────────────────────────

  onStreamEvent(msg: SDKPartialAssistantMessage): void {
    if (msg.parent_tool_use_id) return; // subagent internals: summarized on the parent tool block
    const ev = msg.event;
    switch (ev.type) {
      case "message_start":
        this.currentMessageId = ev.message.id;
        break;
      case "content_block_start": {
        const key = `${this.currentMessageId}:${ev.index}`;
        const cb = ev.content_block;
        if (cb.type === "text") this.streaming.set(key, this.newText());
        else if (cb.type === "thinking") this.streaming.set(key, this.newThinking());
        else if (cb.type === "tool_use" || cb.type === "server_tool_use") {
          this.streaming.set(key, { kind: "tool", id: cb.id, tool: this.newTool(cb.id, cb.name, {}), final: false });
        }
        break;
      }
      case "content_block_delta": {
        const block = this.streaming.get(`${this.currentMessageId}:${ev.index}`);
        if (!block) break;
        if (ev.delta.type === "text_delta" && block.kind === "text") {
          block.text += ev.delta.text;
          this.scheduleRender(block.el, () => block.text);
        } else if (ev.delta.type === "thinking_delta" && block.kind === "thinking") {
          block.text += ev.delta.thinking;
          block.body.setText(block.text);
        }
        break;
      }
    }
  }

  onAssistant(msg: SDKAssistantMessage): void {
    if (msg.parent_tool_use_id) {
      const parent = this.tools.get(msg.parent_tool_use_id);
      for (const b of msg.message.content) if (b.type === "tool_use") parent?.addSubStep(`${displayToolName(b.name)} ${toolSummary(b.name, b.input as Record<string, unknown>)}`);
      return;
    }
    const msgId = msg.message.id;
    for (const b of msg.message.content) {
      if (b.type === "text") {
        const block = this.takeStreaming(msgId, "text") ?? this.newText();
        if (block.kind !== "text") continue;
        block.text = b.text;
        block.final = true;
        this.flushRender(block.el, b.text);
      } else if (b.type === "thinking") {
        const block = this.takeStreaming(msgId, "thinking") ?? this.newThinking();
        if (block.kind !== "thinking") continue;
        block.body.setText(b.thinking);
        block.final = true;
      } else if (b.type === "tool_use") {
        const existing = this.tools.get(b.id) ?? this.newTool(b.id, b.name, {});
        existing.setInput(b.input as Record<string, unknown>);
        this.markFinal(msgId, b.id);
      }
    }
    this.onScroll();
  }

  /** Tool results arrive as user messages. */
  onUser(msg: SDKUserMessage): void {
    const content = msg.message.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      this.tools.get(b.tool_use_id)?.setResult(toolResultText(b.content), b.is_error === true);
    }
  }

  /** Mark running tools as interrupted when a turn ends without their result. */
  endTurn(): void {
    for (const t of this.tools.values()) t.settle();
    this.streaming.clear();
  }

  // ───────────────────────── history (resume) ─────────────────────────

  renderHistoryMessage(m: { type: string; message: unknown; parent_tool_use_id: string | null }): void {
    if (m.parent_tool_use_id) return;
    const message = m.message as { content?: unknown; id?: string };
    if (m.type === "user") {
      if (typeof message.content === "string") {
        if (!message.content.startsWith("<")) this.addUser(message.content);
        return;
      }
      if (Array.isArray(message.content)) {
        const texts = (message.content as { type: string; text?: string }[]).filter((b) => b.type === "text");
        const text = texts.map((t) => t.text ?? "").join("\n");
        if (text && !text.startsWith("<")) this.addUser(text);
        this.onUser({ type: "user", message: message as never, parent_tool_use_id: null });
      }
    } else if (m.type === "assistant") {
      this.onAssistant({ type: "assistant", message: message as never, parent_tool_use_id: null } as unknown as SDKAssistantMessage);
    }
  }

  // ───────────────────────── internals ─────────────────────────

  private takeStreaming(msgId: string, kind: "text" | "thinking"): Block | null {
    for (const [key, block] of this.streaming) {
      if (key.startsWith(`${msgId}:`) && block.kind === kind && !block.final) return block;
    }
    return null;
  }

  private markFinal(msgId: string, toolId: string): void {
    for (const [key, block] of this.streaming) {
      if (key.startsWith(`${msgId}:`) && block.kind === "tool" && block.id === toolId) block.final = true;
    }
  }

  private newText(): Block {
    const el = this.el.createDiv({ cls: "cw-msg cw-assistant markdown-rendered" });
    return { kind: "text", el, text: "", final: false };
  }

  private newThinking(): Block {
    const details = this.el.createEl("details", { cls: "cw-thinking" });
    details.createEl("summary", { text: "Thinking" });
    const body = details.createDiv({ cls: "cw-thinking-body" });
    return { kind: "thinking", el: details, body, text: "", final: false };
  }

  private newTool(id: string, name: string, input: Record<string, unknown>): ToolBlock {
    const tool = new ToolBlock(this.el.createEl("details", { cls: "cw-tool" }), name, input, (p) => this.openPath(p));
    this.tools.set(id, tool);
    this.onScroll();
    return tool;
  }

  private scheduleRender(el: HTMLElement, text: () => string): void {
    if (this.renderTimers.has(el)) return;
    this.renderTimers.set(
      el,
      window.setTimeout(() => {
        this.renderTimers.delete(el);
        void this.renderMarkdown(el, text());
        this.onScroll();
      }, RENDER_THROTTLE_MS),
    );
  }

  private flushRender(el: HTMLElement, text: string): void {
    const t = this.renderTimers.get(el);
    if (t !== undefined) window.clearTimeout(t);
    this.renderTimers.delete(el);
    void this.renderMarkdown(el, text);
  }

  private async renderMarkdown(el: HTMLElement, text: string): Promise<void> {
    el.empty();
    await MarkdownRenderer.render(this.app, text, el, "", this.component);
    this.linkifyPaths(el);
  }

  /** Inline `code` that names a vault file becomes clickable. */
  private linkifyPaths(root: HTMLElement): void {
    root.querySelectorAll("code").forEach((code) => {
      if (code.parentElement?.tagName === "PRE") return;
      const file = this.resolveFile(code.textContent ?? "");
      if (file) {
        code.addClass("cw-file-link");
        code.dataset.path = file.path;
      }
    });
  }

  private resolveFile(raw: string): TFile | null {
    const cleaned = raw.trim().replace(/:\d+(-\d+)?$/, "");
    if (!cleaned || cleaned.length > 300 || !/[./\\]/.test(cleaned)) return null;
    const p = toVaultPath(cleaned, this.vaultPath);
    if (p === null || p === "") return null;
    const f = this.app.vault.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }

  private onClick(evt: MouseEvent): void {
    const target = evt.target as HTMLElement;
    const link = target.closest("a.internal-link");
    if (link instanceof HTMLElement) {
      evt.preventDefault();
      const href = link.dataset.href ?? link.getAttribute("href") ?? "";
      void this.app.workspace.openLinkText(href, "", Keymap.isModEvent(evt));
      return;
    }
    const code = target.closest("code.cw-file-link");
    if (code instanceof HTMLElement && code.dataset.path) {
      evt.preventDefault();
      void this.app.workspace.openLinkText(code.dataset.path, "", Keymap.isModEvent(evt));
    }
  }

  private openPath(raw: string): void {
    const file = this.resolveFile(raw);
    if (file) void this.app.workspace.getLeaf(false).openFile(file);
  }
}

/** Shows what context was injected for this message (exactly what the hook returned). */
export class UserBubble {
  private settled = false;
  constructor(private readonly el: HTMLElement) {}

  get hasContext(): boolean {
    return this.settled;
  }

  setContext(chips: string[], fullText: string): void {
    this.settled = true;
    this.el.empty();
    if (!fullText) {
      this.el.createSpan({ cls: "cw-chip cw-chip-muted", text: "no file focused" });
      return;
    }
    for (const c of chips) this.el.createSpan({ cls: "cw-chip", text: c });
    const details = this.el.createEl("details", { cls: "cw-context-details" });
    details.createEl("summary", { text: "context sent" });
    details.createEl("pre", { text: fullText });
  }

  markMissing(): void {
    if (this.settled) return;
    this.settled = true;
    this.el.empty();
    this.el.createSpan({
      cls: "cw-chip cw-chip-warn",
      text: "no Obsidian context — run “Install Claude Code config in this vault”",
    });
  }
}

class ToolBlock {
  private readonly summaryEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly inputEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly resultEl: HTMLElement;
  private done = false;

  constructor(
    private readonly el: HTMLDetailsElement,
    private readonly name: string,
    input: Record<string, unknown>,
    private readonly openPath: (p: string) => void,
  ) {
    const summary = el.createEl("summary");
    this.statusEl = summary.createSpan({ cls: "cw-tool-status is-running" });
    setIcon(this.statusEl, "loader");
    summary.createSpan({ cls: "cw-tool-name", text: displayToolName(name) });
    this.summaryEl = summary.createSpan({ cls: "cw-tool-summary" });
    this.body = el.createDiv({ cls: "cw-tool-body" });
    this.inputEl = this.body.createDiv();
    this.subEl = this.body.createDiv({ cls: "cw-tool-substeps" });
    this.resultEl = this.body.createDiv();
    this.setInput(input);
  }

  setInput(input: Record<string, unknown>): void {
    this.summaryEl.setText(toolSummary(this.name, input));
    this.inputEl.empty();
    renderToolInput(this.inputEl, this.name, input);
    const path = toolFilePath(this.name, input);
    if (path && this.name !== "Read") {
      const btn = this.inputEl.createEl("button", { cls: "cw-open-file", text: "Open file" });
      btn.onclick = () => this.openPath(path);
    }
    // Edits are worth seeing without a click.
    if (["Edit", "MultiEdit", "Write", "TodoWrite"].includes(this.name)) this.el.open = true;
  }

  addSubStep(text: string): void {
    this.subEl.createDiv({ cls: "cw-muted", text: `↳ ${text}` });
  }

  setResult(text: string, isError: boolean): void {
    this.done = true;
    this.statusEl.className = `cw-tool-status ${isError ? "is-error" : "is-done"}`;
    setIcon(this.statusEl, isError ? "x" : "check");
    this.resultEl.empty();
    if (!text) return;
    const shown = text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + `\n… (${text.length - MAX_RESULT_CHARS} more chars)` : text;
    this.resultEl.createEl("pre", { cls: `cw-tool-result${isError ? " is-error" : ""}`, text: shown });
    if (isError) this.el.open = true;
  }

  settle(): void {
    if (this.done) return;
    this.done = true;
    this.statusEl.className = "cw-tool-status is-interrupted";
    setIcon(this.statusEl, "minus");
  }
}
