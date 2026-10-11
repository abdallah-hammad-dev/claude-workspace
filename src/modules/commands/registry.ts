import type { App } from "obsidian";

/**
 * Obsidian's command registry (`app.commands`) is NOT part of the public API.
 * Everything that touches it lives in this file, behind `CommandRegistry`, so an
 * Obsidian change breaks one adapter instead of the module.
 */
export interface CommandInfo {
  id: string;
  name: string;
}

export interface CommandRegistry {
  list(): CommandInfo[];
  /** False when the command doesn't exist or isn't available in the current view. */
  run(id: string): boolean;
  exists(id: string): boolean;
}

interface InternalCommands {
  commands?: Record<string, { id: string; name: string }>;
  executeCommandById?(id: string): boolean;
}

export function obsidianCommands(app: App): CommandRegistry | null {
  const c = (app as unknown as { commands?: InternalCommands }).commands;
  if (!c || typeof c.executeCommandById !== "function" || !c.commands || typeof c.commands !== "object") return null;
  const table = c.commands;
  const exec = c.executeCommandById.bind(c);
  return {
    list: () => Object.values(table).map((x) => ({ id: x.id, name: x.name })),
    run: (id) => exec(id),
    exists: (id) => id in table,
  };
}

/** Case-insensitive match of every query word against id + name. */
export function searchCommands(all: CommandInfo[], query: string | undefined): CommandInfo[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const hits = words.length ? all.filter((c) => words.every((w) => `${c.id} ${c.name}`.toLowerCase().includes(w))) : all;
  return [...hits].sort((a, b) => a.name.localeCompare(b.name));
}

/** Blocklist entries are exact ids or prefixes ending in `*` (e.g. `app:*`). */
export function isBlocked(id: string, blocklist: string[]): boolean {
  return blocklist.some((b) => {
    const rule = b.trim();
    if (!rule) return false;
    return rule.endsWith("*") ? id.startsWith(rule.slice(0, -1)) : id === rule;
  });
}

export const DEFAULT_BLOCKLIST = [
  "app:reload", // restarts Obsidian (and this plugin) mid-conversation
  "app:open-vault", // switches vaults
  "app:delete-file", // deletes the open file; Claude can ask you instead
  "claude-workspace:*", // this plugin's own commands (install, open chat…)
];
