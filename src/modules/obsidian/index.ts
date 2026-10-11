import { MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";
import { z } from "zod";
import { capText, renderSelection } from "../../core/context/render";
import { ToolError, type WorkspaceModule } from "../../core/module-api";
import { toVaultPath, vaultBasePath } from "../../core/paths";

/** Views whose own module reports the selection better than the DOM does. */
const SELF_REPORTING_VIEWS = new Set(["markdown", "excalidraw"]);

/** Core Obsidian tools and the generic selection provider. Always on. */
export const obsidianModule: WorkspaceModule = {
  id: "obsidian",
  name: "Obsidian (core tools)",
  description: "obsidian_get_active_context and obsidian_open_file.",
  required: true,

  onload(ctx) {
    const { app } = ctx;

    ctx.registerTool({
      name: "obsidian_get_active_context",
      title: "What the user is looking at",
      description:
        "Structured view of what the user is looking at in Obsidian right now: active file, view type, " +
        "cursor, selection, module-specific details (e.g. selected Excalidraw elements) and open tabs. " +
        "The same information is already injected before each prompt in <obsidian_context>; call this " +
        "to refresh it mid-task.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      handler: async () => ctx.getActiveContext(),
    });

    ctx.registerTool({
      name: "obsidian_open_file",
      title: "Open a file in Obsidian",
      description:
        "Open a vault file in the user's Obsidian window (e.g. to show them something, or to open an " +
        "Excalidraw drawing before using excalidraw_* tools). Path is vault-relative or absolute inside the vault.",
      inputSchema: {
        path: z.string().describe("File path, e.g. Projects/Alpha.md"),
        newTab: z.boolean().optional().describe("Open in a new tab instead of the current one"),
        line: z.number().int().positive().optional().describe("Markdown only: 1-based line to scroll to"),
      },
      handler: async ({ path, newTab, line }) => {
        const vaultPath = toVaultPath(path, vaultBasePath(app));
        if (vaultPath === null) throw new ToolError(`${path} is outside the vault. Only vault files can be opened.`);
        const file = app.vault.getAbstractFileByPath(vaultPath);
        if (!(file instanceof TFile)) {
          throw new ToolError(`No file at "${vaultPath}". Check the path with Glob (paths are case-sensitive).`);
        }
        const existing = findLeaf(ctx.app.workspace.iterateRootLeaves.bind(ctx.app.workspace), file);
        const leaf = !newTab && existing ? existing : app.workspace.getLeaf(newTab ? "tab" : false);
        if (leaf !== existing) await leaf.openFile(file);
        await app.workspace.revealLeaf(leaf);
        if (line && leaf.view instanceof MarkdownView) {
          const pos = { line: line - 1, ch: 0 };
          leaf.view.editor.setCursor(pos);
          leaf.view.editor.scrollIntoView({ from: pos, to: pos }, true);
        }
        return { opened: file.path, view: leaf.view.getViewType() };
      },
    });

    // Selection in views no module knows about (PDF, canvas text, …).
    ctx.registerContextProvider({
      id: "selection",
      viewTypes: ["*"],
      priority: 500,
      collect: (view) => {
        if (SELF_REPORTING_VIEWS.has(view.getViewType())) return null;
        const sel = activeWindow.getSelection();
        const text = sel?.toString();
        if (!text || !sel?.anchorNode || !view.containerEl.contains(sel.anchorNode)) return null;
        return capText(text);
      },
      render: (d) => renderSelection(String(d.text), d.truncated === true, `source="view"`),
      chip: () => "text selected",
    });
  },
};

function findLeaf(iterate: (cb: (l: WorkspaceLeaf) => void) => void, file: TFile): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  iterate((l) => {
    if (!found && (l.view as { file?: unknown }).file === file) found = l;
  });
  return found;
}
