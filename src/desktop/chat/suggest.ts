import { setIcon } from "obsidian";

export interface SuggestItem {
  /** Text inserted on pick (e.g. "/compact " or "@Projects/Alpha.md "). */
  insert: string;
  title: string;
  hint?: string;
  description?: string;
  icon?: string;
}

export interface CommandLike {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  builtin?: boolean;
}

/** The slash token being typed at the cursor (only at the very start of the message), or null. */
export function slashQuery(value: string, cursor: number): string | null {
  const m = /^\/(\S*)$/.exec(value.slice(0, cursor));
  return m ? m[1]! : null;
}

/** The first argument of a slash command being typed at the cursor (`/effort hi|`), or null. */
export function argQuery(value: string, cursor: number): { command: string; query: string; start: number } | null {
  const m = /^\/(\S+) +(\S*)$/.exec(value.slice(0, cursor));
  return m ? { command: m[1]!, query: m[2]!, start: cursor - m[2]!.length } : null;
}

/**
 * Literal values of a command's first argument, read from Claude Code's `argumentHint`:
 * `<low|medium|high>` → low, medium, high; `[auto|<tokens>]` → auto; `consent | revoke` → consent, revoke.
 * Placeholders (`<model>`, `[name]`, `key=value`) give null: only `|` alternatives are values.
 */
export function argChoices(hint: string | undefined): string[] | null {
  const h = (hint ?? "").trim().replace(/\s*\|\s*/g, "|");
  let group = "";
  let depth = 0;
  for (const ch of h) {
    if (/\s/.test(ch) && depth === 0) break;
    if (ch === "[" || ch === "<" || ch === "(") depth++;
    if (ch === "]" || ch === ">" || ch === ")") depth--;
    group += ch;
  }
  if (/^[[<(]/.test(group) && /[\]>)]$/.test(group)) group = group.slice(1, -1);
  const alternatives: string[] = [];
  let current = "";
  depth = 0;
  for (const ch of group) {
    if (ch === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
      continue;
    }
    if (ch === "[" || ch === "<" || ch === "(") depth++;
    if (ch === "]" || ch === ">" || ch === ")") depth--;
    current += ch;
  }
  alternatives.push(current);
  if (alternatives.length < 2) return null;
  const values = alternatives.map((a) => a.trim().split(/\s/)[0]!).filter((a) => /^[\w-]+$/.test(a));
  return values.length ? [...new Set(values)] : null;
}

/** Built-ins that only make sense in a terminal (prompt-bar color, focus view, process internals). */
const TERMINAL_ONLY = new Set(["color", "focus", "heapdump", "workflow-launch-exec"]);

/** The @mention being typed at the cursor, or null. */
export function mentionQuery(value: string, cursor: number): { query: string; start: number } | null {
  const before = value.slice(0, cursor);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  return m ? { query: m[2]!, start: before.length - m[2]!.length - 1 } : null;
}

/**
 * Prefix matches first, then substring matches in the name, then (for queries of 3+ characters)
 * in the description. One row per name; Claude Code's built-in row wins.
 */
export function filterCommands(commands: CommandLike[], query: string, limit = 50): CommandLike[] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const unique = [...commands]
    .filter((c) => !c.builtin || !(TERMINAL_ONLY.has(c.name) || c.name.startsWith("__")))
    .sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin))
    .filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  const names = (c: CommandLike) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  const rank = (c: CommandLike): number => {
    if (!q) return 0;
    if (names(c).some((n) => n.startsWith(q))) return 0;
    if (names(c).some((n) => n.includes(q))) return 1;
    if (q.length >= 3 && c.description.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return unique
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c);
}

/** Vault files for an @mention: recent files first when the query is empty, then basename > path matches. */
export function filterFiles(paths: string[], query: string, recent: string[] = [], limit = 30): string[] {
  const q = query.toLowerCase();
  if (!q) {
    const rest = paths.filter((p) => !recent.includes(p)).sort();
    return [...recent.filter((p) => paths.includes(p)), ...rest].slice(0, limit);
  }
  const scored: { p: string; s: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const s = base.startsWith(q) ? 0 : base.includes(q) ? 1 : lower.includes(q) ? 2 : -1;
    if (s >= 0) scored.push({ p, s: s - (recent.includes(p) ? 0.5 : 0) });
  }
  return scored
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}

/** Popup list anchored above the composer; keyboard driven from the textarea. */
export class InlineSuggest {
  private readonly el: HTMLElement;
  private items: SuggestItem[] = [];
  private selected = 0;
  private onPick: ((item: SuggestItem) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv({ cls: "cw-suggest", attr: { role: "listbox" } });
    this.el.hide();
    // Keep focus in the textarea while clicking items.
    this.el.addEventListener("mousedown", (e) => e.preventDefault());
  }

  get isOpen(): boolean {
    return this.onPick !== null;
  }

  show(items: SuggestItem[], onPick: (item: SuggestItem) => void, emptyText = "No matches", selected = 0): void {
    this.items = items;
    this.onPick = onPick;
    this.selected = Math.max(0, Math.min(selected, items.length - 1));
    this.render(emptyText);
    this.el.show();
  }

  hide(): void {
    this.onPick = null;
    this.el.hide();
  }

  /** Returns true when the key was handled by the popup. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!this.items.length) return true;
      const n = this.items.length;
      this.selected = (this.selected + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.highlight();
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && this.items.length) {
      this.pick(this.selected);
      return true;
    }
    if (e.key === "Escape") {
      this.hide();
      return true;
    }
    return false;
  }

  private pick(i: number): void {
    const item = this.items[i];
    const cb = this.onPick;
    this.hide();
    if (item && cb) cb(item);
  }

  private render(emptyText: string): void {
    this.el.empty();
    if (!this.items.length) {
      this.el.createDiv({ cls: "cw-suggest-empty", text: emptyText });
      return;
    }
    this.items.forEach((item, i) => {
      const row = this.el.createDiv({ cls: "cw-suggest-item", attr: { role: "option" } });
      if (item.icon) setIcon(row.createSpan({ cls: "cw-suggest-icon" }), item.icon);
      const text = row.createDiv({ cls: "cw-suggest-text" });
      const line = text.createDiv({ cls: "cw-suggest-title" });
      line.createSpan({ text: item.title });
      if (item.hint) line.createSpan({ cls: "cw-suggest-hint", text: item.hint });
      if (item.description) text.createDiv({ cls: "cw-suggest-desc", text: item.description });
      row.addEventListener("click", () => this.pick(i));
      row.addEventListener("mousemove", () => {
        if (this.selected !== i) {
          this.selected = i;
          this.highlight(false);
        }
      });
    });
    this.highlight();
  }

  private highlight(scroll = true): void {
    const rows = this.el.querySelectorAll(".cw-suggest-item");
    rows.forEach((r, i) => r.toggleClass("is-selected", i === this.selected));
    if (scroll) rows[this.selected]?.scrollIntoView({ block: "nearest" });
  }
}
