import type { App, CliData, CliFlags } from "obsidian";

/**
 * Where Obsidian keeps the commands registered with the public `Plugin.registerCliHandler` (1.12.2+):
 * `app.cli.handlers`, a Map of command → { handler, description, flags }. The map is NOT part of the
 * public API; everything that touches it lives in this file.
 */
export interface CliCommand {
  command: string;
  /** As stored by Obsidian: a community plugin's text starts with "[<plugin name>]: ". */
  description: string;
  flags: CliFlags | null;
}

export interface CliHandlers {
  list(): CliCommand[];
  /** Runs the command's handler with `key=value` params, as Obsidian's CLI does after parsing argv. */
  run(command: string, params: CliData): Promise<string>;
}

interface InternalEntry {
  handler?: (params: CliData) => string | Promise<string>;
  description?: unknown;
  flags?: unknown;
}

export function obsidianCli(app: App): CliHandlers | null {
  const map = (app as unknown as { cli?: { handlers?: unknown } }).cli?.handlers;
  if (!(map instanceof Map)) return null;
  const handlers = map as Map<string, InternalEntry>;
  return {
    list: () =>
      [...handlers].flatMap(([command, e]) =>
        typeof e?.handler === "function"
          ? [{ command, description: typeof e.description === "string" ? e.description : "", flags: isFlags(e.flags) ? e.flags : null }]
          : [],
      ),
    run: async (command, params) => {
      const entry = handlers.get(command);
      if (typeof entry?.handler !== "function") throw new Error(`The command "${command}" is no longer registered.`);
      const out = await entry.handler(params); // called on the entry, like Obsidian's own dispatcher
      return typeof out === "string" ? out : "";
    },
  };
}

function isFlags(v: unknown): v is CliFlags {
  return !!v && typeof v === "object";
}
