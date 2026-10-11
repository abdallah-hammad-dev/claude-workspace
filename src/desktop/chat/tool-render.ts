/** How tool calls look in the transcript and permission prompts. Pure helpers + small DOM builders. */
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { setIcon } from "obsidian";

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

/** Vault-relative path when the path is inside the vault, else unchanged. */
export function relPath(p: string, vaultPath: string): string {
  const norm = p.replace(/\\/g, "/");
  const base = vaultPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && norm.toLowerCase().startsWith(base.toLowerCase() + "/")) return norm.slice(base.length + 1);
  return norm;
}

/** One-line summary shown next to the tool name. */
export function toolSummary(name: string, input: Record<string, unknown>, vaultPath = ""): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit": {
      const p = str(input.file_path) ?? str(input.notebook_path);
      return p ? relPath(p, vaultPath) : "";
    }
    case "Bash":
      return str(input.description) ?? str(input.command) ?? "";
    case "Glob":
    case "Grep":
      return [str(input.pattern), str(input.path) && relPath(str(input.path)!, vaultPath)].filter(Boolean).join(" in ");
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
      if (name === `${MCP_PREFIX}commands_run`) return str(input.id) ?? "";
      const first = Object.values(input).find((v) => typeof v === "string" && v.length < 80);
      return typeof first === "string" ? first : "";
    }
  }
}

/** Lucide icon (names checked against Obsidian's bundled set). */
export function toolIcon(name: string): string {
  switch (name) {
    case "Read":
      return "file-text";
    case "Write":
      return "file-plus";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "file-pen";
    case "Bash":
    case "BashOutput":
      return "terminal";
    case "Glob":
    case "Grep":
      return "file-search";
    case "WebFetch":
      return "globe";
    case "WebSearch":
      return "search";
    case "Task":
    case "Agent":
      return "bot";
    case "TodoWrite":
      return "list-checks";
    case "Skill":
      return "book-open";
    case "AskUserQuestion":
      return "circle-help";
    case "ExitPlanMode":
      return "map";
  }
  if (name.startsWith(`${MCP_PREFIX}excalidraw_`)) return "shapes";
  if (name.startsWith(`${MCP_PREFIX}commands_`)) return "command";
  if (name.startsWith(MCP_PREFIX)) return "file-text";
  if (name.startsWith("mcp__")) return "plug";
  return "wrench";
}

/** File the tool touches, for the "open file" button. */
export function toolFilePath(name: string, input: Record<string, unknown>): string | null {
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name)) return str(input.file_path) ?? null;
  return null;
}

/** "Allow Claude to <verb> <target>?" for a permission request. */
export interface PermissionAsk {
  icon: string;
  verb: string;
  target: string;
  /** Show target in monospace (paths, commands, ids). */
  code: boolean;
}

const OBSIDIAN_TOOL_VERBS: Record<string, string> = {
  excalidraw_apply: "edit the open drawing",
  excalidraw_get_scene: "read the open drawing",
  excalidraw_screenshot: "take a screenshot of the drawing",
  excalidraw_focus: "select elements in the drawing",
  commands_run: "run the Obsidian command",
  commands_list: "list Obsidian commands",
  obsidian_open_file: "open",
  obsidian_get_active_context: "read what you're looking at",
};

export function permissionAsk(name: string, input: Record<string, unknown>, vaultPath = ""): PermissionAsk {
  const icon = toolIcon(name);
  const path = (k: string) => relPath(str(input[k]) ?? "", vaultPath);
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { icon, verb: "edit", target: path(str(input.file_path) ? "file_path" : "notebook_path"), code: true };
    case "Write":
      return { icon, verb: "write", target: path("file_path"), code: true };
    case "Read":
      return { icon, verb: "read", target: path("file_path"), code: true };
    case "Bash":
      return { icon, verb: "run", target: str(input.command) ?? "", code: true };
    case "Glob":
    case "Grep":
      return { icon, verb: "search files for", target: str(input.pattern) ?? "", code: true };
    case "WebFetch":
      return { icon, verb: "fetch", target: str(input.url) ?? "", code: true };
    case "WebSearch":
      return { icon, verb: "search the web for", target: str(input.query) ?? "", code: false };
    case "Task":
    case "Agent":
      return { icon, verb: "start a subagent:", target: str(input.description) ?? "", code: false };
    case "Skill":
      return { icon, verb: "use the skill", target: str(input.skill) ?? "", code: true };
  }
  if (name.startsWith(MCP_PREFIX)) {
    const tool = name.slice(MCP_PREFIX.length);
    const verb = OBSIDIAN_TOOL_VERBS[tool];
    if (tool === "commands_run") return { icon, verb: verb!, target: str(input.id) ?? "", code: true };
    if (tool === "obsidian_open_file") return { icon, verb: verb!, target: str(input.path) ?? "", code: true };
    if (verb) return { icon, verb, target: "", code: false };
    return { icon, verb: "use the Obsidian tool", target: tool, code: true };
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { icon, verb: `use ${m[1]}'s tool`, target: m[2]!, code: true };
  return { icon, verb: "use", target: name, code: true };
}

const MODE_LABELS: Record<string, string> = {
  default: "Ask before edits",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Don't ask",
};

const WHERE: Record<string, string> = {
  session: "for this conversation",
  cliArg: "for this conversation",
  localSettings: "in this vault",
  projectSettings: "in this vault (shared settings)",
  userSettings: "everywhere",
};

function ruleLabel(r: { toolName: string; ruleContent?: string }): string {
  const c = r.ruleContent;
  if (r.toolName === "Bash") {
    if (!c) return "all commands";
    return c.endsWith(":*") ? `\`${c.slice(0, -2)} …\` commands` : `\`${c}\``;
  }
  if (["Edit", "Write", "MultiEdit"].includes(r.toolName)) return c ? `edits to \`${c}\`` : "all file edits";
  if (r.toolName === "Read") return c ? `reading \`${c}\`` : "reading files";
  if (r.toolName === "WebFetch") return c?.startsWith("domain:") ? `fetching from ${c.slice(7)}` : "web fetches";
  const tool = displayToolName(r.toolName);
  return c ? `${tool}(${c})` : tool;
}

/** Plain-language label for an "always allow" button, from Claude Code's permission suggestions. */
export function describeSuggestions(suggestions: PermissionUpdate[]): string {
  const first = suggestions[0];
  if (!first) return "Always allow";
  const where = WHERE[first.destination] ?? "";
  const more = suggestions.length > 1 ? ` (+${suggestions.length - 1} more)` : "";
  switch (first.type) {
    case "setMode":
      return first.mode === "acceptEdits"
        ? `Allow all edits ${WHERE.session}${more}`
        : `Switch to “${MODE_LABELS[first.mode] ?? first.mode}” ${where}${more}`;
    case "addRules":
    case "replaceRules":
      return `Always allow ${first.rules.map(ruleLabel).join(", ")} ${where}${more}`;
    case "addDirectories":
      return `Allow access to ${first.directories.join(", ")} ${where}${more}`;
    default:
      return `Always allow ${where}${more}`;
  }
}

export function renderDiff(parent: HTMLElement, lines: DiffLine[], maxLines = 400): void {
  const box = parent.createDiv({ cls: "cw-diff" });
  for (const l of lines.slice(0, maxLines)) {
    const row = box.createDiv({ cls: `cw-diff-line cw-diff-${l.kind}` });
    row.createSpan({ cls: "cw-diff-sign", text: l.kind === "add" ? "+" : l.kind === "del" ? "−" : "" });
    row.createSpan({ cls: "cw-diff-text", text: l.text || " " });
  }
  if (lines.length > maxLines) box.createDiv({ cls: "cw-diff-line cw-diff-gap", text: `… ${lines.length - maxLines} more lines` });
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
        const li = ul.createEl("li", { cls: `cw-todo cw-todo-${status}` });
        setIcon(li.createSpan({ cls: "cw-todo-icon" }), status === "completed" ? "circle-check" : status === "in_progress" ? "circle-dot" : "circle");
        li.createSpan({ text: str(t.content) ?? "" });
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
