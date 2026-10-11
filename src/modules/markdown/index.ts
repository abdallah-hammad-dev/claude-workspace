import { MarkdownView, type App, type TFile } from "obsidian";
import { capText, renderSelection } from "../../core/context/render";
import type { WorkspaceModule } from "../../core/module-api";

export interface MarkdownContext extends Record<string, unknown> {
  cursor?: { line: number; ch: number };
  /** Heading path at the cursor, outermost first. */
  section?: string[];
  selection?: { fromLine?: number; toLine?: number; text: string; truncated: boolean };
}

/** Cursor, section and selection of the focused markdown note. */
export const markdownModule: WorkspaceModule = {
  id: "markdown",
  name: "Markdown notes",
  description: "Adds the cursor position, current section and selected text of the note you're in.",

  onload(ctx) {
    ctx.registerContextProvider({
      id: "editor",
      viewTypes: ["markdown"],
      priority: 10,
      collect: (view, file) => (view instanceof MarkdownView ? collectMarkdown(ctx.app, view, file) : null),
      render: (d) => renderMarkdown(d),
      chip: (d) => markdownChip(d),
    });
  },
};

export function collectMarkdown(app: App, view: MarkdownView, file: TFile | null): MarkdownContext | null {
  const out: MarkdownContext = {};
  if (view.getMode() === "source") {
    const ed = view.editor;
    const head = ed.getCursor("head");
    out.cursor = { line: head.line + 1, ch: head.ch };
    const sel = ed.getSelection();
    if (sel) {
      const { text, truncated } = capText(sel);
      out.selection = { fromLine: ed.getCursor("from").line + 1, toLine: ed.getCursor("to").line + 1, text, truncated };
    }
    if (file) out.section = sectionAt(app, file, head.line);
  } else {
    // Reading mode: no editor cursor, but a DOM selection inside this view still counts.
    const domSel = activeWindow.getSelection();
    const text = domSel?.toString();
    if (text && domSel?.anchorNode && view.containerEl.contains(domSel.anchorNode)) {
      out.selection = capText(text);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Heading breadcrumb containing `line` (0-based), from the metadata cache. */
export function sectionAt(app: App, file: TFile, line: number): string[] | undefined {
  const headings = app.metadataCache.getFileCache(file)?.headings;
  if (!headings?.length) return undefined;
  const path: { level: number; text: string }[] = [];
  for (const h of headings) {
    if (h.position.start.line > line) break;
    while (path.length && path[path.length - 1]!.level >= h.level) path.pop();
    path.push({ level: h.level, text: h.heading });
  }
  return path.length ? path.map((h) => h.text) : undefined;
}

export function renderMarkdown(d: MarkdownContext): string[] {
  const lines: string[] = [];
  if (d.cursor) {
    lines.push(`Cursor at line ${d.cursor.line}${d.section ? ` (section: ${d.section.join(" › ")})` : ""}.`);
  }
  if (d.selection) {
    const s = d.selection;
    const label = s.fromLine ? `lines="${s.fromLine}-${s.toLine}"` : `source="reading view"`;
    lines.push(...renderSelection(s.text, s.truncated, label));
  }
  return lines;
}

export function markdownChip(d: MarkdownContext): string | null {
  const s = d.selection;
  if (s) return s.fromLine ? (s.fromLine === s.toLine ? `L${s.fromLine} selected` : `L${s.fromLine}–${s.toLine} selected`) : "text selected";
  return d.cursor ? `L${d.cursor.line}` : null;
}
