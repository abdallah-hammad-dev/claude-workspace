import type { CliData, CliFlags } from "obsidian";
import { z } from "zod";
import type { PluginInfo } from "../../core/plugins";
import type { CliCommand } from "./handlers";

/** Commands of one plugin, or Obsidian's own (`plugin: null`). Descriptions without Obsidian's "[name]: ". */
export interface CliGroup {
  plugin: PluginInfo | null;
  commands: CliCommand[];
}

/**
 * Obsidian's own help hides `__…` commands and files `dev:…`, `devtools` and `eval` under "Developer":
 * they run arbitrary code or drive the developer tools, so Claude never gets them.
 */
function isHidden(command: string, core: boolean): boolean {
  return command.startsWith("__") || (core && (command.startsWith("dev:") || command === "devtools" || command === "eval"));
}

/**
 * Obsidian's own commands that restart the app, change what is installed, delete or overwrite files, or run
 * any palette command (bypassing the Obsidian commands module's blocklist). Off until the user turns them on.
 */
const CORE_OFF_BY_DEFAULT = [
  "reload",
  "restart",
  "plugin:*",
  "plugins:restrict",
  "theme:install",
  "theme:uninstall",
  "delete",
  "history:restore",
  "sync:restore",
  "command",
];

export function isOnByDefault(group: CliGroup, command: string): boolean {
  if (group.plugin) return true;
  return !CORE_OFF_BY_DEFAULT.some((rule) => (rule.endsWith("*") ? command.startsWith(rule.slice(0, -1)) : command === rule));
}

/**
 * Sorts commands by who registered them. Obsidian prefixes a community plugin's description with
 * "[<manifest name>]: " (the command name itself is only a convention: `<plugin-id>:<action>`).
 */
export function groupCommands(commands: CliCommand[], plugins: PluginInfo[]): CliGroup[] {
  const core: CliCommand[] = [];
  const byPlugin = new Map<string, { plugin: PluginInfo; commands: CliCommand[] }>();
  for (const c of commands) {
    const owners = plugins.filter((p) => c.description.startsWith(`[${p.name}]: `));
    if (!owners.length) {
      if (c.description.startsWith("[")) continue; // a plugin that is no longer loaded
      if (!isHidden(c.command, true)) core.push(c);
      continue;
    }
    const owner = owners.find((p) => c.command === p.id || c.command.startsWith(`${p.id}:`)) ?? owners[0]!;
    if (isHidden(c.command, false)) continue;
    const description = c.description.slice(owner.name.length + 4);
    const group = byPlugin.get(owner.id) ?? { plugin: owner, commands: [] };
    group.commands.push({ ...c, description });
    byPlugin.set(owner.id, group);
  }
  const sorted = (cs: CliCommand[]) => [...cs].sort((a, b) => a.command.localeCompare(b.command));
  const plugins_ = [...byPlugin.values()].sort((a, b) => a.plugin.name.localeCompare(b.plugin.name));
  return [
    ...(core.length ? [{ plugin: null, commands: sorted(core) }] : []),
    ...plugins_.map((g) => ({ plugin: g.plugin, commands: sorted(g.commands) })),
  ];
}

/** Claude Code names MCP tools `mcp__obsidian__<tool>`; keep the whole name within 64 characters. */
const MAX_TOOL_NAME = 64 - "mcp__obsidian__".length;
const MAX_MODULE_ID = 30;

/**
 * The module of a plugin's CLI is named like the plugin (its manifest id), Obsidian's own is `cli`.
 * `taken` holds ids of other modules; a clash gets a `-cli` suffix.
 */
export function cliModuleId(pluginId: string | null, taken: (id: string) => boolean): string {
  let id = pluginId === null ? "cli" : pluginId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(id)) id = `p${id}`;
  if (id.length > MAX_MODULE_ID) id = `${id.slice(0, MAX_MODULE_ID - 7).replace(/-+$/, "")}-${shortHash(id)}`;
  return taken(id) ? `${id}-cli` : id;
}

/**
 * `obsidian-excalidraw-plugin:read` → `<module>_read`, `daily:read` → `cli_daily_read`: the command with its
 * plugin id dropped and `:` (not allowed in tool names) turned into `_`. A plugin's bare default command
 * (`<plugin-id>`) becomes `<module>_default`.
 */
export function toolName(moduleId: string, command: string, pluginId: string | null): string {
  let action = command;
  if (pluginId !== null && command === pluginId) action = "default";
  else if (pluginId !== null && command.startsWith(`${pluginId}:`)) action = command.slice(pluginId.length + 1);
  action = action.replace(/:/g, "_").replace(/[^A-Za-z0-9_-]/g, "-");
  const name = `${moduleId}_${action}`;
  return name.length <= MAX_TOOL_NAME ? name : `${name.slice(0, MAX_TOOL_NAME - 7).replace(/[-_]+$/, "")}-${shortHash(name)}`;
}

/** The Claude API only accepts these as property names; others (help's `<command>`) aren't key=value options. */
const FLAG_NAME = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Every CLI value is text; numbers and JSON that Claude sends as such are turned into the text the CLI expects. */
const textValue = z.preprocess(
  (v) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v !== null && typeof v === "object" ? JSON.stringify(v) : v),
  z.string(),
);

/** A flag with a value placeholder (`file=<name>`) takes text; one without (`total`) is a switch. */
export function inputShape(flags: CliFlags | null): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, flag] of Object.entries(flags ?? {})) {
    if (!FLAG_NAME.test(name)) continue;
    const field = flag.value ? textValue.describe(`${flag.description} (${flag.value})`) : z.boolean().describe(flag.description);
    shape[name] = flag.required ? field : field.optional();
  }
  return shape;
}

/** What Obsidian's CLI passes for `key=value` and bare `flag` arguments. A switch set to false is left out. */
export function toCliParams(args: Record<string, unknown>): CliData {
  const params: CliData = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === false) continue;
    params[key] = value === true ? "true" : typeof value === "string" ? value : JSON.stringify(value);
  }
  return params;
}

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(6, "0").slice(-6);
}
