import type { ActiveContext } from "../module-api";

export const MAX_SELECTION_CHARS = 6000;

/** Lines a provider contributes, looked up by `${moduleId}.${providerId}`. */
export type ProviderRenderer = (data: Record<string, unknown>) => string[];

/**
 * Render the `<obsidian_context>` block injected before every prompt.
 * Pure: everything it needs is in `ctx` and `renderers`. Never includes file contents.
 */
export function renderContext(ctx: ActiveContext, renderers: (key: string) => ProviderRenderer | undefined): string {
  const lines: string[] = [];

  if (ctx.activeFile) {
    const { path, viewType } = ctx.activeFile;
    lines.push(`The user is currently looking at: ${path} (view: ${viewType}${ctx.mode ? `, mode: ${ctx.mode}` : ""}).`);
    lines.push(`"This file", "this note", "this drawing", "here" refer to it.`);
  } else if (ctx.openTabs.length) {
    lines.push("No file is focused in Obsidian right now.");
  } else {
    return "";
  }

  for (const [key, data] of Object.entries(ctx.providers)) {
    if (typeof data.error === "string") {
      lines.push(`(context from ${key} unavailable: ${data.error})`);
      continue;
    }
    const render = renderers(key);
    if (!render) continue;
    try {
      lines.push(...render(data));
    } catch (e) {
      lines.push(`(context from ${key} unavailable: ${e instanceof Error ? e.message : String(e)})`);
    }
  }

  const others = [...new Set(ctx.openTabs.map((t) => t.path))].filter((p) => p !== ctx.activeFile?.path);
  if (others.length) lines.push(`Other open tabs: ${others.join(", ")}`);

  return ["<obsidian_context>", ...lines, "</obsidian_context>"].join("\n");
}

/** Cap a selection so one huge selection can't flood the prompt. */
export function capText(text: string, max = MAX_SELECTION_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** Wrap selected text so its boundaries are unambiguous even if it contains markdown. */
export function renderSelection(text: string, truncated: boolean, label: string): string[] {
  return [`<selected_text ${label}>`, text + (truncated ? "\n…[truncated]" : ""), "</selected_text>"];
}
