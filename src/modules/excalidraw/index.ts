import type { App, View, WorkspaceLeaf } from "obsidian";
import { z } from "zod";
import { toVaultPath, vaultBasePath } from "../../core/paths";
import { ToolError, type ModuleContext, type WorkspaceModule } from "../../core/module-api";
import { applyOps, liveElements, type EA } from "./canvas";
import { opSchema } from "./ops";
import { normalizeSelection, summarize, type ElementSummary } from "./scene";
import { EXCALIDRAW_SKILL } from "./skill";

export const EXCALIDRAW_VIEW = "excalidraw";
const PLUGIN_ID = "obsidian-excalidraw-plugin";
const MAX_SELECTED_IN_CONTEXT = 20;
const SELECTION_POLL_MS = 800;

interface ExcalidrawAutomateGlobal {
  getAPI?(view?: View): EA;
  setView?(view: View): void;
}

/**
 * Live Excalidraw canvas tools. Reads and edits the open drawing through the
 * Excalidraw plugin's ExcalidrawAutomate API, never by editing the .excalidraw.md file.
 */
export const excalidrawModule: WorkspaceModule = {
  id: "excalidraw",
  name: "Excalidraw",
  description: "Claude sees the selected elements of the open drawing and can read, edit, screenshot and focus it live.",
  platforms: ["desktop"],
  isAvailable: (app) => !!pluginsOf(app)[PLUGIN_ID],

  onload(ctx) {
    const pathArg = z.string().optional().describe("Vault path of an open drawing; omit for the one the user is looking at");

    ctx.registerTool({
      name: "excalidraw_get_scene",
      title: "Read the live Excalidraw drawing",
      description:
        "Read the LIVE canvas of an open Excalidraw drawing (including unsaved changes): every element with id, type, " +
        "x/y/w/h, label text (bound text merged into its shape/arrow), colors, arrow from/to bindings, groups, frame, " +
        "link, plus the user's current selection. Call this before excalidraw_apply.",
      inputSchema: { path: pathArg, selectedOnly: z.boolean().optional().describe("Only the selected elements") },
      annotations: { readOnlyHint: true },
      handler: async ({ path, selectedOnly }) => {
        const { ea, file } = target(ctx, path);
        const els = liveElements(ea);
        const selectedIds = normalizeSelection(
          ea.getViewSelectedElements().map((e) => e.id),
          els,
        );
        let elements = summarize(els);
        if (selectedOnly) elements = elements.filter((e) => selectedIds.includes(e.id));
        return { path: file, selectedIds, elementCount: elements.length, elements };
      },
    });

    ctx.registerTool({
      name: "excalidraw_apply",
      title: "Edit the live Excalidraw drawing",
      description:
        "Edit the LIVE canvas of an open drawing with an ordered list of ops, applied as one batch. The whole list is " +
        "validated first: on any error nothing changes. Ops: add_shape (rectangle/ellipse/diamond, optional centered " +
        "label), add_text, connect (arrow between two elements, optional label), update (geometry, style, text), delete " +
        "(also removes bound labels and, by default, attached arrows). Give new elements a `ref` to connect or update them " +
        "later in the same call. Returns the ref → id map. Coordinates: x grows right, y grows down.",
      inputSchema: { path: pathArg, ops: z.array(opSchema).min(1) },
      handler: async ({ path, ops }) => {
        const { ea } = target(ctx, path);
        const result = await applyOps(ea, ops);
        ctx.notifyContextChanged();
        return {
          ...result,
          note: "Undo in Excalidraw with Ctrl/Cmd+Z. Take excalidraw_screenshot to check the layout after non-trivial edits.",
        };
      },
    });

    ctx.registerTool({
      name: "excalidraw_screenshot",
      title: "Screenshot the live drawing",
      description: "PNG render of the live drawing, to visually check layout, overlaps and readability after edits.",
      inputSchema: { path: pathArg, scale: z.number().min(0.25).max(3).optional().describe("Default 1") },
      annotations: { readOnlyHint: true },
      handler: async ({ path, scale }) => {
        const { ea } = target(ctx, path);
        const els = liveElements(ea);
        if (!els.length) throw new ToolError("The drawing is empty; nothing to screenshot.");
        ea.copyViewElementsToEAforEditing(els);
        const blob = await ea.createPNG(undefined, scale ?? 1);
        return { content: [{ type: "image", mimeType: "image/png", data: await blobToBase64(blob) }] };
      },
    });

    ctx.registerTool({
      name: "excalidraw_focus",
      title: "Show elements to the user",
      description: "Select and zoom to the given elements in the user's view, so they see what you are talking about.",
      inputSchema: { path: pathArg, ids: z.array(z.string()).min(1) },
      handler: async ({ path, ids }) => {
        const { ea } = target(ctx, path);
        const els = liveElements(ea);
        const found = els.filter((e) => ids.includes(e.id));
        const missing = ids.filter((id) => !found.some((e) => e.id === id));
        if (!found.length) throw new ToolError(`None of these ids exist in the drawing: ${ids.join(", ")}. Call excalidraw_get_scene.`);
        ea.selectElementsInView(found.map((e) => e.id));
        ea.viewZoomToElements(true, found);
        return { focused: found.map((e) => e.id), missing };
      },
    });

    ctx.registerContextProvider({
      id: "canvas",
      viewTypes: [EXCALIDRAW_VIEW],
      priority: 20,
      collect: (view) => {
        const ea = eaFor(view);
        const els = liveElements(ea);
        const selectedIds = normalizeSelection(
          ea.getViewSelectedElements().map((e) => e.id),
          els,
        );
        const summaries = summarize(els);
        return {
          elementCount: summaries.length,
          selected: summaries.filter((s) => selectedIds.includes(s.id)).slice(0, MAX_SELECTED_IN_CONTEXT),
          selectedCount: selectedIds.length,
        };
      },
      render: (d) => {
        const selected = d.selected as ElementSummary[];
        const count = d.selectedCount as number;
        const lines = [`It is a live Excalidraw drawing with ${String(d.elementCount)} elements.`];
        if (count) {
          lines.push(`Selected (${count}${count > selected.length ? `, first ${selected.length} shown` : ""}): ${JSON.stringify(selected)}`);
        }
        lines.push(
          "Read/edit it with excalidraw_get_scene / excalidraw_apply / excalidraw_screenshot (MCP server obsidian); " +
            "do NOT edit the .excalidraw.md file while it is open.",
        );
        return lines;
      },
      chip: (d) => {
        const n = d.selectedCount as number;
        return n ? `${n} element${n > 1 ? "s" : ""} selected` : `${String(d.elementCount)} elements`;
      },
    });

    ctx.registerSkill({ name: "excalidraw", markdown: EXCALIDRAW_SKILL });

    // Excalidraw selection changes don't fire Obsidian events: poll while a drawing is focused.
    let lastSelection = "";
    const timer = window.setInterval(() => {
      const view = ctx.getActiveView();
      if (!view || view.getViewType() !== EXCALIDRAW_VIEW) return;
      try {
        const sel = eaFor(view)
          .getViewSelectedElements()
          .map((e) => e.id)
          .sort()
          .join(",");
        if (sel !== lastSelection) {
          lastSelection = sel;
          ctx.notifyContextChanged();
        }
      } catch {
        // view not ready yet
      }
    }, SELECTION_POLL_MS);
    ctx.onDispose(() => window.clearInterval(timer));
  },
};

function pluginsOf(app: App): Record<string, unknown> {
  return (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins ?? {};
}

function eaFor(view: View): EA {
  const g = (window as unknown as { ExcalidrawAutomate?: ExcalidrawAutomateGlobal }).ExcalidrawAutomate;
  if (!g?.getAPI) throw new ToolError("The Excalidraw plugin isn't loaded. Enable it in Obsidian's community plugins.");
  const ea = g.getAPI(view);
  (ea as unknown as ExcalidrawAutomateGlobal).setView?.(view);
  return ea;
}

/** The drawing to act on: `path` if given, else the one the user is looking at, else the only open one. */
function target(ctx: ModuleContext, path: string | undefined): { ea: EA; file: string } {
  const leaves: WorkspaceLeaf[] = ctx.app.workspace.getLeavesOfType(EXCALIDRAW_VIEW);
  const fileOf = (l: WorkspaceLeaf) => (l.view as { file?: { path: string } }).file?.path;
  let leaf: WorkspaceLeaf | undefined;
  if (path) {
    const p = toVaultPath(path, vaultBasePath(ctx.app));
    leaf = leaves.find((l) => fileOf(l) === p);
    if (!leaf) throw new ToolError(`${path} isn't open as a drawing. Open it with obsidian_open_file first, then retry.`);
  } else {
    const active = ctx.getActiveView();
    leaf = leaves.find((l) => l.view === active) ?? (leaves.length === 1 ? leaves[0] : undefined);
    if (!leaf) {
      throw new ToolError(
        leaves.length
          ? `Several drawings are open (${leaves.map(fileOf).join(", ")}) and none is focused; pass \`path\`.`
          : "No Excalidraw drawing is open. Open one with obsidian_open_file first.",
      );
    }
  }
  return { ea: eaFor(leaf.view), file: fileOf(leaf) ?? "" };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
