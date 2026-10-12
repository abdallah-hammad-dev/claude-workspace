import { Keymap, MarkdownRenderer, TFile, setIcon, type App, type Component } from "obsidian";
import type { SDKAssistantMessage, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { toVaultPath } from "../../core/paths";
import { lineCount, splitPastes } from "./paste";
import { displayToolName, renderToolInput, toolFilePath, toolIcon, toolResultText, toolSummary } from "./tool-render";

type Block =
  | { kind: "text"; el: HTMLElement; text: string; final: boolean }
  | { kind: "thinking"; thinking: ThinkingBlock; final: boolean }
  | { kind: "tool"; id: string; tool: ToolBlock; final: boolean };

const RENDER_THROTTLE_MS = 80;
const MAX_RESULT_CHARS = 4000;

export interface UserImage {
  mediaType: string;
  /** base64 */
  data: string;
}

export interface UserMessageOptions {
  images?: UserImage[];
  /** Pastes behind `[Pasted text #n]` placeholders in the text (shown collapsed). */
  pastes?: ReadonlyMap<number, string>;
  /** Wait for the hook's context to show it under the message (false for slash commands, "instead" replies). */
  expectContext?: boolean;
  /** Small label above the bubble, e.g. "Instead". */
  label?: string;
}

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

  get isEmpty(): boolean {
    return this.el.childElementCount === 0;
  }

  clear(): void {
    this.el.empty();
    this.streaming.clear();
    this.tools.clear();
    this.currentMessageId = null;
  }

  addUser(text: string, opts: UserMessageOptions = {}): UserBubble {
    const turn = this.el.createDiv({ cls: "cw-user-turn" });
    if (opts.label) turn.createDiv({ cls: "cw-user-label", text: opts.label });
    const bubble = turn.createDiv({ cls: "cw-user-bubble" });
    if (text) this.renderUserText(bubble, text, opts.pastes ?? new Map());
    if (opts.images?.length) {
      const row = bubble.createDiv({ cls: "cw-user-images" });
      for (const img of opts.images) {
        const el = row.createEl("img", { attr: { src: `data:${img.mediaType};base64,${img.data}`, alt: "Attached image" } });
        el.onclick = () => el.toggleClass("is-expanded", !el.hasClass("is-expanded"));
      }
    }
    const meta = turn.createDiv({ cls: "cw-user-meta" });
    this.onScroll();
    return new UserBubble(meta, opts.expectContext !== false);
  }

  /** Slash command highlighted, pastes as chips that open in place, long text folded. */
  private renderUserText(bubble: HTMLElement, text: string, pastes: ReadonlyMap<number, string>): void {
    const body = bubble.createDiv({ cls: "cw-user-text" });
    splitPastes(text, pastes).forEach((seg, i) => {
      if ("text" in seg) {
        const command = i === 0 ? /^\/\S+/.exec(seg.text) : null;
        if (command) body.createSpan({ cls: "cw-user-command", text: command[0] });
        body.appendText(command ? seg.text.slice(command[0].length) : seg.text);
        return;
      }
      const lines = lineCount(seg.content);
      const chip = body.createEl("button", { cls: "cw-paste-chip", attr: { "aria-expanded": "false" } });
      setIcon(chip.createSpan({ cls: "cw-paste-chip-icon" }), "clipboard-paste");
      chip.createSpan({ text: `Pasted text · ${lines} line${lines > 1 ? "s" : ""}` });
      let pre: HTMLElement | null = null;
      chip.onclick = () => {
        pre ??= bubble.createEl("pre", { cls: "cw-paste-content", text: seg.content });
        const open = chip.getAttribute("aria-expanded") !== "true";
        chip.setAttr("aria-expanded", String(open));
        pre.toggle(open);
      };
    });
    // Long messages (e.g. a big paste in a resumed conversation) fold to a few lines.
    if (!pastes.size && (lineCount(text) > 12 || text.length > 1500)) {
      body.addClass("is-clamped");
      const more = bubble.createEl("button", { cls: "cw-user-more", text: "Show more" });
      more.onclick = () => {
        const clamped = body.hasClass("is-clamped");
        body.toggleClass("is-clamped", !clamped);
        more.setText(clamped ? "Show less" : "Show more");
      };
    }
  }

  addNote(text: string, kind: "info" | "error" | "divider" = "info"): HTMLElement {
    const el = this.el.createDiv({ cls: `cw-note cw-note-${kind}` });
    if (kind === "divider") {
      el.createSpan({ text });
    } else {
      setIcon(el.createSpan({ cls: "cw-note-icon" }), kind === "error" ? "triangle-alert" : "info");
      void this.renderMarkdown(el.createDiv({ cls: "cw-note-text" }), text);
    }
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
        else if (cb.type === "thinking") this.streaming.set(key, { kind: "thinking", thinking: this.newThinking(), final: false });
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
          block.thinking.append(ev.delta.thinking);
        }
        break;
      }
    }
  }

  onAssistant(msg: SDKAssistantMessage): void {
    if (msg.parent_tool_use_id) {
      const parent = this.tools.get(msg.parent_tool_use_id);
      for (const b of msg.message.content) {
        if (b.type === "tool_use") parent?.addSubStep(b.name, toolSummary(b.name, b.input as Record<string, unknown>, this.vaultPath));
      }
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
        const block = this.takeStreaming(msgId, "thinking");
        const thinking = block?.kind === "thinking" ? block.thinking : this.newThinking();
        thinking.finish(b.thinking);
        if (block) block.final = true;
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
    for (const b of this.streaming.values()) if (b.kind === "thinking") b.thinking.finish();
    this.streaming.clear();
  }

  // ───────────────────────── history (resume) ─────────────────────────

  renderHistoryMessage(m: { type: string; message: unknown; parent_tool_use_id: string | null }): void {
    if (m.parent_tool_use_id) return;
    const message = m.message as { content?: unknown; id?: string };
    if (m.type === "user") {
      if (typeof message.content === "string") {
        if (!message.content.startsWith("<")) this.addUser(message.content, { expectContext: false });
        return;
      }
      if (Array.isArray(message.content)) {
        const blocks = message.content as { type: string; text?: string; source?: { type?: string; media_type?: string; data?: string } }[];
        const text = blocks
          .filter((b) => b.type === "text")
          .map((t) => t.text ?? "")
          .join("\n");
        const images = blocks
          .filter((b) => b.type === "image" && b.source?.type === "base64" && b.source.data)
          .map((b) => ({ mediaType: b.source!.media_type ?? "image/png", data: b.source!.data! }));
        if ((text && !text.startsWith("<")) || images.length) this.addUser(text.startsWith("<") ? "" : text, { expectContext: false, images });
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
    const el = this.el.createDiv({ cls: "cw-assistant markdown-rendered" });
    return { kind: "text", el, text: "", final: false };
  }

  private newThinking(): ThinkingBlock {
    return new ThinkingBlock(this.el.createEl("details", { cls: "cw-thinking" }));
  }

  private newTool(id: string, name: string, input: Record<string, unknown>): ToolBlock {
    const tool = new ToolBlock(this.el.createEl("details", { cls: "cw-tool" }), name, input, this.vaultPath, (p) => this.openPath(p));
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

/** Shows, under the user's message, exactly what context the hook injected. */
export class UserBubble {
  private settled: boolean;
  constructor(
    private readonly el: HTMLElement,
    expectContext: boolean,
  ) {
    this.settled = !expectContext;
  }

  get hasContext(): boolean {
    return this.settled;
  }

  setContext(chips: string[], fullText: string): void {
    if (this.settled) return;
    this.settled = true;
    this.el.empty();
    const pill = this.el.createEl("button", { cls: "cw-context-pill", attr: { "aria-label": "What Claude saw with this message" } });
    setIcon(pill.createSpan({ cls: "cw-context-pill-icon" }), "eye");
    pill.createSpan({ text: fullText ? chips.join(" · ") || "Obsidian context" : "No note focused" });
    if (!fullText) {
      pill.addClass("is-muted");
      pill.disabled = true;
      return;
    }
    setIcon(pill.createSpan({ cls: "cw-context-pill-chevron" }), "chevron-down");
    const preview = this.el.createEl("pre", { cls: "cw-context-preview", text: fullText });
    preview.hide();
    pill.onclick = () => {
      const open = !pill.hasClass("is-open");
      pill.toggleClass("is-open", open);
      preview.toggle(open);
    };
  }

  markMissing(): void {
    if (this.settled) return;
    this.settled = true;
    this.el.empty();
    const pill = this.el.createDiv({ cls: "cw-context-pill is-warning" });
    setIcon(pill.createSpan({ cls: "cw-context-pill-icon" }), "triangle-alert");
    pill.createSpan({ text: "Claude didn't receive Obsidian context. Install the vault config in settings." });
  }
}

class ThinkingBlock {
  private readonly body: HTMLElement;
  private readonly label: HTMLElement;
  private text = "";

  constructor(private readonly el: HTMLDetailsElement) {
    const summary = el.createEl("summary");
    setIcon(summary.createSpan({ cls: "cw-row-icon" }), "brain");
    this.label = summary.createSpan({ cls: "cw-thinking-label", text: "Thinking…" });
    setIcon(summary.createSpan({ cls: "cw-row-chevron" }), "chevron-right");
    this.body = el.createDiv({ cls: "cw-thinking-body" });
    el.addClass("is-running");
  }

  append(delta: string): void {
    this.text += delta;
    this.body.setText(this.text);
  }

  finish(full?: string): void {
    if (full !== undefined) {
      this.text = full;
      this.body.setText(full);
    }
    this.el.removeClass("is-running");
    this.label.setText(this.text.trim() ? "Thought process" : "Thought");
  }
}

class ToolBlock {
  private readonly summaryEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly inputEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly resultEl: HTMLElement;
  private done = false;

  constructor(
    private readonly el: HTMLDetailsElement,
    private readonly name: string,
    input: Record<string, unknown>,
    private readonly vaultPath: string,
    private readonly openPath: (p: string) => void,
  ) {
    const summary = el.createEl("summary");
    setIcon(summary.createSpan({ cls: "cw-row-icon" }), toolIcon(name));
    summary.createSpan({ cls: "cw-tool-name", text: displayToolName(name) });
    this.summaryEl = summary.createSpan({ cls: "cw-tool-summary" });
    this.statusEl = summary.createSpan({ cls: "cw-tool-status is-running", attr: { "aria-label": "Running" } });
    setIcon(this.statusEl, "loader");
    setIcon(summary.createSpan({ cls: "cw-row-chevron" }), "chevron-right");
    const body = el.createDiv({ cls: "cw-tool-body" });
    this.inputEl = body.createDiv();
    this.subEl = body.createDiv({ cls: "cw-tool-substeps" });
    this.resultEl = body.createDiv();
    el.addClass("is-running");
    this.setInput(input);
  }

  setInput(input: Record<string, unknown>): void {
    this.summaryEl.setText(toolSummary(this.name, input, this.vaultPath));
    this.inputEl.empty();
    renderToolInput(this.inputEl, this.name, input);
    const path = toolFilePath(this.name, input);
    if (path && this.name !== "Read") {
      const btn = this.inputEl.createEl("button", { cls: "cw-link-btn" });
      setIcon(btn.createSpan(), "file-text");
      btn.createSpan({ text: "Open file" });
      btn.onclick = () => this.openPath(path);
    }
    // Edits and plans are worth seeing without a click.
    if (["Edit", "MultiEdit", "Write", "TodoWrite"].includes(this.name)) this.el.open = true;
  }

  addSubStep(name: string, summary: string): void {
    const row = this.subEl.createDiv({ cls: "cw-substep" });
    setIcon(row.createSpan({ cls: "cw-row-icon" }), toolIcon(name));
    row.createSpan({ cls: "cw-tool-name", text: displayToolName(name) });
    row.createSpan({ cls: "cw-tool-summary", text: summary });
  }

  setResult(text: string, isError: boolean): void {
    this.done = true;
    this.el.removeClass("is-running");
    this.el.toggleClass("is-error", isError);
    this.statusEl.className = `cw-tool-status ${isError ? "is-error" : "is-done"}`;
    this.statusEl.setAttr("aria-label", isError ? "Failed" : "Done");
    setIcon(this.statusEl, isError ? "x" : "check");
    this.resultEl.empty();
    if (!text) return;
    const shown = text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) + `\n… (${text.length - MAX_RESULT_CHARS} more characters)` : text;
    this.resultEl.createEl("pre", { cls: `cw-tool-result${isError ? " is-error" : ""}`, text: shown });
    if (isError) this.el.open = true;
  }

  settle(): void {
    if (this.done) return;
    this.done = true;
    this.el.removeClass("is-running");
    this.statusEl.className = "cw-tool-status is-interrupted";
    this.statusEl.setAttr("aria-label", "Interrupted");
    setIcon(this.statusEl, "minus");
  }
}
