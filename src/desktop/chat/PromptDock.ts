import type { PermissionMode, PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { MarkdownRenderer, setIcon, type App, type Component } from "obsidian";
import { describeSuggestions, MCP_PREFIX, permissionAsk, relPath, renderToolInput } from "./tool-render";

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  decisionReason?: string;
  blockedPath?: string;
  signal: AbortSignal;
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

interface Pending {
  render(card: HTMLElement): void;
  /** Composer placeholder while this card waits. */
  hint: string;
  /** Deny/answer with free text typed in the composer. */
  instead(text: string): PermissionResult;
  resolve(r: PermissionResult): void;
  signal: AbortSignal;
}

export interface DockDeps {
  app: App;
  component: Component;
  vaultPath: string;
  /** A request appeared or was answered. */
  onChange(pending: boolean): void;
  /** The user approved a plan and chose how edits should be handled next. */
  onModeChosen(mode: PermissionMode): void;
}

/**
 * Inline cards above the composer for everything Claude Code asks the user:
 * tool permissions, plan approval, AskUserQuestion. One at a time, the rest queued.
 * Typing in the composer while a card is shown answers it ("do this instead").
 */
export class PromptDock {
  private readonly queue: Pending[] = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly deps: DockDeps,
  ) {
    el.addClass("cw-dock");
    el.hide();
  }

  get pending(): boolean {
    return this.queue.length > 0;
  }

  /** Placeholder for the composer while a card waits. */
  get composerHint(): string {
    return this.queue[0]?.hint ?? "";
  }

  askPermission(req: PermissionRequest): Promise<PermissionResult> {
    if (req.toolName === "ExitPlanMode") return this.askPlan(req);
    return this.enqueue(req.signal, {
      render: (card) => this.renderPermission(card, req),
      hint: "Or tell Claude what to do instead… (Enter sends)",
      instead: (text) => ({ behavior: "deny", message: `The user denied this and said: ${text}` }),
    });
  }

  askQuestions(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    return this.enqueue(signal, {
      render: (card) => this.renderQuestions(card, input),
      hint: "Or type your own answer… (Enter sends)",
      instead: (text) => ({
        behavior: "allow",
        updatedInput: { ...input, answers: Object.fromEntries(questionsOf(input).map((q) => [q.question, text])) },
      }),
    });
  }

  /** Answer the current card with text from the composer. Returns false when nothing is pending. */
  answerWithText(text: string): boolean {
    const cur = this.queue[0];
    if (!cur) return false;
    this.finish(cur, cur.instead(text));
    return true;
  }

  /** Deny everything (new conversation, view closed). */
  cancelAll(): void {
    for (const p of [...this.queue]) this.finish(p, { behavior: "deny", message: "The conversation was closed." });
  }

  private askPlan(req: PermissionRequest): Promise<PermissionResult> {
    return this.enqueue(req.signal, {
      render: (card) => this.renderPlan(card, req),
      hint: "Or give feedback on the plan… (Enter sends)",
      instead: (text) => ({ behavior: "deny", message: `Keep planning. The user's feedback on the plan: ${text}` }),
    });
  }

  private enqueue(signal: AbortSignal, p: Omit<Pending, "resolve" | "signal">): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const entry: Pending = { ...p, resolve, signal };
      this.queue.push(entry);
      signal.addEventListener("abort", () => this.finish(entry, { behavior: "deny", message: "Cancelled." }), { once: true });
      if (this.queue.length === 1) this.show();
      else this.updateCount();
      this.deps.onChange(true);
    });
  }

  private finish(entry: Pending, r: PermissionResult): void {
    const i = this.queue.indexOf(entry);
    if (i < 0) return;
    this.queue.splice(i, 1);
    entry.resolve(r);
    if (i === 0) this.show();
    else this.updateCount();
    this.deps.onChange(this.queue.length > 0);
  }

  private show(): void {
    this.el.empty();
    const cur = this.queue[0];
    if (!cur) {
      this.el.hide();
      return;
    }
    this.el.show();
    const card = this.el.createDiv({ cls: "cw-prompt-card" });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.finish(cur, { behavior: "deny", message: "The user denied this tool call." });
      }
    });
    cur.render(card);
    this.updateCount();
  }

  private updateCount(): void {
    this.el.querySelector(".cw-prompt-queue")?.remove();
    if (this.queue.length > 1) {
      this.el.querySelector(".cw-prompt-head")?.createSpan({ cls: "cw-prompt-queue", text: `+${this.queue.length - 1} waiting` });
    }
  }

  private current(): Pending {
    return this.queue[0]!;
  }

  // ───────────────────────── cards ─────────────────────────

  private head(card: HTMLElement, icon: string, build: (title: HTMLElement) => void, variant = ""): void {
    const head = card.createDiv({ cls: `cw-prompt-head ${variant}` });
    setIcon(head.createSpan({ cls: "cw-prompt-icon" }), icon);
    build(head.createDiv({ cls: "cw-prompt-title" }));
  }

  private renderPermission(card: HTMLElement, req: PermissionRequest): void {
    card.addClass("is-permission");
    const ask = permissionAsk(req.toolName, req.input, this.deps.vaultPath);
    const isPath = ["Edit", "Write", "MultiEdit", "Read", "NotebookEdit"].includes(req.toolName);
    const isBash = req.toolName === "Bash";
    // Short targets (a file name, a command id) read well in the title; commands and long text go in the body.
    const inTitle = !isBash && !!ask.target && !ask.target.includes("\n") && ask.target.length <= 48;
    this.head(card, ask.icon, (t) => {
      t.appendText(`Allow Claude to ${ask.verb}`);
      if (isBash) t.appendText(" this command");
      else if (inTitle) {
        t.appendText(" ");
        t.createEl(ask.code ? "code" : "span", { text: isPath ? ask.target.split("/").pop()! : ask.target });
      }
      t.appendText("?");
    });

    const body = card.createDiv({ cls: "cw-prompt-body" });
    if (isPath) {
      if (ask.target.includes("/")) body.createDiv({ cls: "cw-prompt-path", text: ask.target });
      if (req.toolName !== "Read") renderToolInput(body, req.toolName, req.input);
    } else if (isBash) {
      if (typeof req.input.description === "string") body.createDiv({ cls: "cw-prompt-sub", text: req.input.description });
      renderToolInput(body, req.toolName, req.input);
    } else if (req.toolName === `${MCP_PREFIX}excalidraw_apply`) {
      renderOps(body, req.input.ops);
    } else if (!inTitle && ask.target) {
      body.createDiv({ cls: "cw-prompt-sub", text: ask.target });
    } else if (Object.keys(req.input).length && !inTitle) {
      const details = body.createEl("details", { cls: "cw-prompt-details" });
      details.createEl("summary", { text: "Details" });
      details.createEl("pre", { cls: "cw-code", text: JSON.stringify(req.input, null, 2) });
    }
    if (!body.childElementCount) body.remove();

    if (req.decisionReason || req.blockedPath) {
      const why = card.createDiv({ cls: "cw-prompt-reason" });
      setIcon(why.createSpan(), "info");
      why.createSpan({
        text: [req.decisionReason, req.blockedPath && `Path: ${relPath(req.blockedPath, this.deps.vaultPath)}`].filter(Boolean).join(" · "),
      });
    }

    const actions = card.createDiv({ cls: "cw-prompt-actions" });
    const allow = this.button(actions, "Allow", "mod-cta", () => ({ behavior: "allow", updatedInput: req.input }));
    this.button(actions, "Deny", "", () => ({ behavior: "deny", message: "The user denied this tool call." }));
    if (req.suggestions?.length) {
      const always = this.button(actions, "", "cw-prompt-always", () => ({
        behavior: "allow",
        updatedInput: req.input,
        updatedPermissions: req.suggestions,
      }));
      setIcon(always.createSpan({ cls: "cw-prompt-always-icon" }), "check-check");
      appendWithCode(always.createSpan(), describeSuggestions(req.suggestions));
    }
    card.createDiv({ cls: "cw-prompt-hint", text: "Esc denies · or type below to tell Claude what to do instead" });
    window.setTimeout(() => allow.focus({ preventScroll: true }), 0);
  }

  private renderPlan(card: HTMLElement, req: PermissionRequest): void {
    card.addClass("is-plan");
    this.head(card, "map", (t) => t.appendText("Claude's plan is ready. Start working on it?"));
    const body = card.createDiv({ cls: "cw-prompt-body cw-plan markdown-rendered" });
    void MarkdownRenderer.render(this.deps.app, typeof req.input.plan === "string" ? req.input.plan : "", body, "", this.deps.component);

    const approve = (mode: PermissionMode): PermissionResult => {
      this.deps.onModeChosen(mode);
      return { behavior: "allow", updatedInput: req.input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
    };
    const actions = card.createDiv({ cls: "cw-prompt-actions" });
    const first = this.button(actions, "Yes, and accept edits", "mod-cta", () => approve("acceptEdits"));
    this.button(actions, "Yes, ask before each edit", "", () => approve("default"));
    this.button(actions, "Keep planning", "", () => ({ behavior: "deny", message: "The user wants to keep planning." }));
    card.createDiv({ cls: "cw-prompt-hint", text: "Or type feedback on the plan below" });
    window.setTimeout(() => first.focus({ preventScroll: true }), 0);
  }

  private renderQuestions(card: HTMLElement, input: Record<string, unknown>): void {
    card.addClass("is-question");
    const questions = questionsOf(input);
    this.head(card, "circle-help", (t) => t.appendText(questions.length > 1 ? "Claude has a few questions" : "Claude has a question"));
    const chosen = new Map<string, Set<string>>();
    const other = new Map<string, string>();
    const body = card.createDiv({ cls: "cw-prompt-body" });

    for (const q of questions) {
      const box = body.createDiv({ cls: "cw-question" });
      if (q.header) box.createDiv({ cls: "cw-question-header", text: q.header });
      box.createDiv({ cls: "cw-question-text", text: q.question });
      if (q.multiSelect) box.createDiv({ cls: "cw-prompt-sub", text: "Choose any" });
      const set = new Set<string>();
      chosen.set(q.question, set);
      const options = box.createDiv({ cls: "cw-options" });
      const els: HTMLElement[] = [];
      for (const opt of q.options) {
        const b = options.createEl("button", { cls: "cw-option" });
        b.createDiv({ cls: "cw-option-label", text: opt.label });
        if (opt.description) b.createDiv({ cls: "cw-option-desc", text: opt.description });
        b.onclick = () => {
          if (!q.multiSelect) {
            set.clear();
            els.forEach((x) => x.removeClass("is-selected"));
          }
          if (set.has(opt.label)) set.delete(opt.label);
          else set.add(opt.label);
          b.toggleClass("is-selected", set.has(opt.label));
        };
        els.push(b);
      }
      const o = box.createEl("input", { type: "text", cls: "cw-option-other", attr: { placeholder: "Something else…" } });
      o.oninput = () => other.set(q.question, o.value);
    }

    const actions = card.createDiv({ cls: "cw-prompt-actions" });
    this.button(actions, "Send answers", "mod-cta", () => {
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const parts = [...(chosen.get(q.question) ?? [])];
        const extra = other.get(q.question)?.trim();
        if (extra) parts.push(extra);
        if (parts.length) answers[q.question] = parts.join(", ");
      }
      return { behavior: "allow", updatedInput: { ...input, answers } };
    });
    this.button(actions, "Skip", "", () => ({ behavior: "deny", message: "The user skipped the question." }));
  }

  private button(parent: HTMLElement, text: string, cls: string, result: () => PermissionResult): HTMLButtonElement {
    const b = parent.createEl("button", { cls: `cw-prompt-btn ${cls}`.trim(), text });
    b.onclick = () => this.finish(this.current(), result());
    return b;
  }
}

/** Text where `backticked` parts become <code>. */
function appendWithCode(el: HTMLElement, text: string): void {
  text.split(/(`[^`]+`)/).forEach((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) el.createEl("code", { text: part.slice(1, -1) });
    else if (part) el.appendText(part);
  });
}

function questionsOf(input: Record<string, unknown>): Question[] {
  return (Array.isArray(input.questions) ? input.questions : []) as Question[];
}

/** Readable list of excalidraw_apply ops instead of raw JSON. */
function renderOps(parent: HTMLElement, ops: unknown): void {
  if (!Array.isArray(ops)) return;
  const ul = parent.createEl("ul", { cls: "cw-ops" });
  for (const raw of ops as Record<string, unknown>[]) {
    const s = (k: string) => (typeof raw[k] === "string" ? (raw[k]) : "");
    let text: string;
    switch (raw.op) {
      case "add_shape":
        text = `Add ${s("shape") || "rectangle"}${s("text") ? ` “${s("text")}”` : ""}`;
        break;
      case "add_text":
        text = `Add text “${s("text")}”`;
        break;
      case "connect":
        text = `Connect ${s("from")} → ${s("to")}${s("text") ? ` “${s("text")}”` : ""}`;
        break;
      case "update":
        text = `Update ${s("id")}${s("text") ? ` → “${s("text")}”` : ""}`;
        break;
      case "delete":
        text = `Delete ${Array.isArray(raw.ids) ? (raw.ids as string[]).join(", ") : ""}`;
        break;
      default:
        text = String(raw.op);
    }
    ul.createEl("li", { text });
  }
}
