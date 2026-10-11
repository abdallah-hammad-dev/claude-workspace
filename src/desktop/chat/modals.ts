import type { TFile} from "obsidian";
import { FuzzySuggestModal, MarkdownRenderer, Modal, SuggestModal, type App, type Component } from "obsidian";
import type { PermissionResult, PermissionUpdate, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { displayToolName, renderToolInput, toolSummary } from "./tool-render";

interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  decisionReason?: string;
  blockedPath?: string;
  signal: AbortSignal;
}

/** Ask the user to allow a tool call: allow once / always / deny. */
export function askPermission(app: App, component: Component, req: PermissionRequest): Promise<PermissionResult> {
  return new Promise((resolve) => {
    const modal = new PermissionModal(app, component, req, resolve);
    req.signal.addEventListener("abort", () => modal.close(), { once: true });
    modal.open();
  });
}

class PermissionModal extends Modal {
  private result: PermissionResult = { behavior: "deny", message: "The user denied this tool call." };

  constructor(
    app: App,
    private readonly component: Component,
    private readonly req: PermissionRequest,
    private readonly done: (r: PermissionResult) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { req, contentEl } = this;
    const plan = req.toolName === "ExitPlanMode";
    this.setTitle(plan ? "Claude's plan" : `Allow ${displayToolName(req.toolName)}?`);
    contentEl.addClass("cw-permission");

    if (plan) {
      const el = contentEl.createDiv({ cls: "cw-plan markdown-rendered" });
      void MarkdownRenderer.render(this.app, typeof req.input.plan === "string" ? req.input.plan : "", el, "", this.component);
    } else {
      const summary = toolSummary(req.toolName, req.input);
      if (summary) contentEl.createEl("p", { cls: "cw-permission-summary", text: summary });
      renderToolInput(contentEl.createDiv({ cls: "cw-permission-input" }), req.toolName, req.input);
    }
    if (req.decisionReason) contentEl.createEl("p", { cls: "cw-muted", text: req.decisionReason });
    if (req.blockedPath) contentEl.createEl("p", { cls: "cw-muted", text: `Path: ${req.blockedPath}` });

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const allow = buttons.createEl("button", { cls: "mod-cta", text: plan ? "Approve plan" : "Allow once" });
    allow.onclick = () => this.finish({ behavior: "allow", updatedInput: req.input });
    if (!plan && req.suggestions?.length) {
      const always = buttons.createEl("button", { text: alwaysLabel(req.suggestions) });
      always.onclick = () => this.finish({ behavior: "allow", updatedInput: req.input, updatedPermissions: req.suggestions });
    }
    const deny = buttons.createEl("button", { cls: "mod-warning", text: plan ? "Keep planning" : "Deny" });
    deny.onclick = () =>
      this.finish({ behavior: "deny", message: plan ? "The user wants to keep planning." : "The user denied this tool call." });
    allow.focus();
  }

  private finish(r: PermissionResult): void {
    this.result = r;
    this.close();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(this.result);
  }
}

function alwaysLabel(s: PermissionUpdate[]): string {
  const first = s[0];
  if (first && first.type === "addRules" && first.rules[0]) {
    const r = first.rules[0];
    const where = first.destination === "session" ? "this session" : first.destination === "localSettings" ? "this vault (local)" : first.destination;
    return `Always allow ${r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName} — ${where}`;
  }
  if (first && first.type === "setMode") return `Allow and switch to ${first.mode}`;
  return "Always allow";
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** AskUserQuestion: render the questions, return answers keyed by question text. */
export function askQuestions(app: App, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
  return new Promise((resolve) => {
    const modal = new QuestionModal(app, input, resolve);
    signal.addEventListener("abort", () => modal.close(), { once: true });
    modal.open();
  });
}

class QuestionModal extends Modal {
  private result: PermissionResult = { behavior: "deny", message: "The user dismissed the question." };
  private readonly answers = new Map<string, Set<string>>();
  private readonly other = new Map<string, string>();

  constructor(
    app: App,
    private readonly input: Record<string, unknown>,
    private readonly done: (r: PermissionResult) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const questions = (Array.isArray(this.input.questions) ? this.input.questions : []) as Question[];
    this.setTitle("Claude has a question");
    const { contentEl } = this;
    contentEl.addClass("cw-question");

    for (const q of questions) {
      const box = contentEl.createDiv({ cls: "cw-question-item" });
      box.createEl("div", { cls: "cw-question-header", text: q.header });
      box.createEl("p", { text: q.question });
      const chosen = new Set<string>();
      this.answers.set(q.question, chosen);
      const optionEls: HTMLElement[] = [];
      for (const opt of q.options) {
        const el = box.createEl("button", { cls: "cw-option" });
        el.createEl("strong", { text: opt.label });
        if (opt.description) el.createEl("div", { cls: "cw-muted", text: opt.description });
        el.onclick = () => {
          if (!q.multiSelect) {
            chosen.clear();
            optionEls.forEach((o) => o.removeClass("is-selected"));
          }
          if (chosen.has(opt.label)) chosen.delete(opt.label);
          else chosen.add(opt.label);
          el.toggleClass("is-selected", chosen.has(opt.label));
        };
        optionEls.push(el);
      }
      const other = box.createEl("input", { type: "text", placeholder: "Other…", cls: "cw-other" });
      other.oninput = () => this.other.set(q.question, other.value);
    }

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    const submit = buttons.createEl("button", { cls: "mod-cta", text: "Answer" });
    submit.onclick = () => {
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const parts = [...(this.answers.get(q.question) ?? [])];
        const other = this.other.get(q.question)?.trim();
        if (other) parts.push(other);
        if (parts.length) answers[q.question] = parts.join(", ");
      }
      this.result = { behavior: "allow", updatedInput: { ...this.input, answers } };
      this.close();
    };
  }

  override onClose(): void {
    this.contentEl.empty();
    this.done(this.result);
  }
}

/** `@` mention picker over vault files. */
export class FilePickerModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly onPick: (file: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder("Mention a file…");
  }
  private picked = false;
  getItems(): TFile[] {
    return this.app.vault.getFiles();
  }
  getItemText(f: TFile): string {
    return f.path;
  }
  onChooseItem(f: TFile): void {
    this.picked = true;
    this.onPick(f);
  }
  override onClose(): void {
    // onChooseItem runs after onClose; defer so we know whether something was picked.
    window.setTimeout(() => !this.picked && this.onPick(null), 0);
  }
}

/** Past Claude Code sessions for this vault (the same ones `claude --resume` shows). */
export class SessionPickerModal extends SuggestModal<SDKSessionInfo> {
  constructor(
    app: App,
    private readonly sessions: SDKSessionInfo[],
    private readonly onPick: (s: SDKSessionInfo) => void,
  ) {
    super(app);
    this.setPlaceholder("Resume a conversation…");
  }
  getSuggestions(q: string): SDKSessionInfo[] {
    const needle = q.toLowerCase();
    return this.sessions.filter((s) => sessionTitle(s).toLowerCase().includes(needle));
  }
  renderSuggestion(s: SDKSessionInfo, el: HTMLElement): void {
    el.createDiv({ text: sessionTitle(s) });
    el.createEl("small", { cls: "cw-muted", text: new Date(s.lastModified).toLocaleString() });
  }
  onChooseSuggestion(s: SDKSessionInfo): void {
    this.onPick(s);
  }
}

export function sessionTitle(s: SDKSessionInfo): string {
  return (s.customTitle || s.summary || s.firstPrompt || s.sessionId).slice(0, 120);
}
