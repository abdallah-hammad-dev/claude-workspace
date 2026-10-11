/** How tool calls look in the transcript and permission prompts. Pure helpers + small DOM builders. */

export const MCP_PREFIX = "mcp__obsidian__";

export interface DiffLine {
  kind: "ctx" | "del" | "add" | "gap";
  text: string;
}

/** Minimal line diff for Edit/Write previews: trims the common prefix/suffix, keeps a little context. */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  const ctxFrom = Math.max(0, start - context);
  if (ctxFrom > 0) out.push({ kind: "gap", text: "…" });
  for (let i = ctxFrom; i < start; i++) out.push({ kind: "ctx", text: a[i]! });
  for (let i = start; i < endA; i++) out.push({ kind: "del", text: a[i]! });
  for (let i = start; i < endB; i++) out.push({ kind: "add", text: b[i]! });
  const ctxTo = Math.min(a.length, endA + context);
  for (let i = endA; i < ctxTo; i++) out.push({ kind: "ctx", text: a[i]! });
  if (ctxTo < a.length) out.push({ kind: "gap", text: "…" });
  return out;
}

export function displayToolName(name: string): string {
  if (name.startsWith(MCP_PREFIX)) return name.slice(MCP_PREFIX.length);
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[2]} (${m[1]})` : name;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One-line summary shown next to the tool name. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return str(input.file_path) ?? str(input.notebook_path) ?? "";
    case "Bash":
      return str(input.description) ?? str(input.command) ?? "";
    case "Glob":
    case "Grep":
      return [str(input.pattern), str(input.path)].filter(Boolean).join(" in ");
    case "WebFetch":
      return str(input.url) ?? "";
    case "WebSearch":
      return str(input.query) ?? "";
    case "Task":
    case "Agent":
      return str(input.description) ?? "";
    case "TodoWrite":
      return `${Array.isArray(input.todos) ? input.todos.length : 0} items`;
    case "Skill":
      return str(input.skill) ?? str(input.command) ?? "";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string" && v.length < 80);
      return typeof first === "string" ? first : "";
    }
  }
}

/** File the tool touches, for the "open file" button. */
export function toolFilePath(name: string, input: Record<string, unknown>): string | null {
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name)) return str(input.file_path) ?? null;
  return null;
}

export function renderDiff(parent: HTMLElement, lines: DiffLine[], maxLines = 400): void {
  const pre = parent.createEl("pre", { cls: "cw-diff" });
  for (const l of lines.slice(0, maxLines)) {
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "gap" ? "" : " ";
    pre.createDiv({ cls: `cw-diff-${l.kind}`, text: `${sign} ${l.text}` });
  }
  if (lines.length > maxLines) pre.createDiv({ cls: "cw-diff-gap", text: `… ${lines.length - maxLines} more lines` });
}

/** Rich view of a tool's input (diff, command, todo list) or a JSON fallback. */
export function renderToolInput(parent: HTMLElement, name: string, input: Record<string, unknown>): void {
  switch (name) {
    case "Edit":
      renderDiff(parent, lineDiff(str(input.old_string) ?? "", str(input.new_string) ?? ""));
      return;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
      for (const e of edits) renderDiff(parent, lineDiff(str(e.old_string) ?? "", str(e.new_string) ?? ""));
      return;
    }
    case "Write":
      renderDiff(parent, lineDiff("", str(input.content) ?? ""), 60);
      return;
    case "Bash":
      parent.createEl("pre", { cls: "cw-code", text: str(input.command) ?? "" });
      return;
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : [];
      const ul = parent.createEl("ul", { cls: "cw-todos" });
      for (const t of todos) {
        const status = str(t.status) ?? "pending";
        const icon = status === "completed" ? "☑" : status === "in_progress" ? "◐" : "☐";
        ul.createEl("li", { cls: `cw-todo-${status}`, text: `${icon} ${str(t.content) ?? ""}` });
      }
      return;
    }
    default:
      if (Object.keys(input).length) parent.createEl("pre", { cls: "cw-code", text: JSON.stringify(input, null, 2) });
  }
}

/** Text of a tool_result content (string or blocks), images noted. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image]" : ""))
    .join("\n");
}
