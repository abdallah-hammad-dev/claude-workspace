import type { App, SettingDefinition } from "obsidian";
import { ToolError, type ControlValue, type Disposer, type SettingsSection, type WorkspaceModule } from "../../core/module-api";
import type { ModuleRegistry } from "../../core/ModuleRegistry";
import { loadedPlugins } from "../../core/plugins";
import { cliModuleId, groupCommands, inputShape, isOnByDefault, toCliParams, toolName, type CliGroup } from "./bridge";
import { obsidianCli, type CliHandlers } from "./handlers";

interface CliPrefs {
  /** Commands the user turned on or off; the others follow `isOnByDefault`. */
  commands: Record<string, boolean>;
}

/**
 * Turns the commands registered with Obsidian's CLI (`Plugin.registerCliHandler`, Obsidian 1.12.2+) into
 * MCP tools, run inside Obsidian (no shell): one module per plugin, plus one for Obsidian's own commands.
 * Obsidian has no event for CLI registrations, so `sync()` runs on a timer and adds, reloads or removes
 * modules when the commands or the loaded plugins change.
 */
export class CliBridge {
  /** By module id. */
  private readonly groups = new Map<string, CliGroup>();
  private readonly disposers = new Map<string, Disposer>();
  private seen = "";

  constructor(
    private readonly app: App,
    private readonly registry: ModuleRegistry,
  ) {}

  sync(): void {
    const cli = obsidianCli(this.app);
    if (!cli) return;
    const commands = cli.list();
    const plugins = loadedPlugins(this.app);
    const signature = JSON.stringify([commands.map((c) => c.command), plugins]);
    if (signature === this.seen) return;
    this.seen = signature;

    const next = new Map<string, CliGroup>();
    for (const group of groupCommands(commands, plugins)) {
      const known = [...this.groups].find(([, g]) => g.plugin?.id === group.plugin?.id)?.[0];
      next.set(known ?? cliModuleId(group.plugin?.id ?? null, (id) => this.registry.has(id) || next.has(id)), group);
    }
    for (const [id, dispose] of [...this.disposers]) {
      if (next.has(id)) continue;
      dispose();
      this.disposers.delete(id);
      this.groups.delete(id);
    }
    for (const [id, group] of next) {
      const old = this.groups.get(id);
      this.groups.set(id, group);
      if (!old) this.disposers.set(id, this.registry.add(this.module(id, group, cli), { kind: "cli" }));
      else if (JSON.stringify(old) !== JSON.stringify(group)) void this.registry.reload(id);
    }
  }

  dispose(): void {
    for (const dispose of this.disposers.values()) dispose();
    this.disposers.clear();
    this.groups.clear();
    this.seen = "";
  }

  private module(id: string, first: CliGroup, cli: CliHandlers): WorkspaceModule {
    const plugin = first.plugin;
    const name = plugin ? `${plugin.name} CLI` : "Obsidian CLI";
    return {
      id,
      name,
      description: plugin
        ? `The commands ${plugin.name} offers through Obsidian's command line, as tools for Claude.`
        : "Obsidian's own command-line commands (search, daily notes, properties, tasks…), as tools for Claude. " +
          "Developer commands (eval, dev:…) are never offered.",
      platforms: ["desktop"],
      plugin: plugin ? { id: plugin.id } : undefined,
      enabledByDefault: plugin !== null,

      onload: (ctx) => {
        const group = this.groups.get(id) ?? first;
        const pluginId = group.plugin?.id ?? null;
        const prefs = ctx.loadData<CliPrefs>({ commands: {} });
        const isOn = (command: string) => prefs.commands[command] ?? isOnByDefault(group, command);
        // Plugins document their CLI in a `<plugin-id>:help` command (Excalidraw does); point Claude to it.
        const help = group.commands.find((c) => pluginId !== null && c.command === `${pluginId}:help` && isOn(c.command));
        const helpTool = help && toolName(id, help.command, pluginId);
        const names = new Set<string>();

        for (const c of group.commands) {
          const tool = toolName(id, c.command, pluginId);
          if (!isOn(c.command) || names.has(tool)) continue; // two commands can only differ by ":" vs "_"
          names.add(tool);
          const seeHelp = helpTool && tool !== helpTool ? ` Read ${helpTool} first for how to use these commands.` : "";
          ctx.registerTool({
            name: tool,
            title: c.command,
            description: `${sentence(c.description || c.command)} Obsidian CLI command \`${c.command}\`, run inside Obsidian; returns its output as text.${seeHelp}`,
            inputSchema: inputShape(c.flags),
            handler: async (args) => {
              try {
                return (await cli.run(c.command, toCliParams(args))) || "(no output)";
              } catch (e) {
                // Obsidian's handlers throw strings as often as Errors.
                throw new ToolError(`${c.command}: ${e instanceof Error ? e.message : String(e)}`);
              }
            },
          });
        }

        ctx.registerSettings(
          commandsPage(name, group, isOn, async (command, on) => {
            prefs.commands[command] = on;
            await ctx.saveData(prefs);
            await this.registry.reload(id);
          }),
        );
      },
    };
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/** A sub-page with one switch per command: each command that is on is a tool. */
function commandsPage(
  moduleName: string,
  group: CliGroup,
  isOn: (command: string) => boolean,
  set: (command: string, on: boolean) => Promise<void>,
): SettingsSection {
  const values: Record<string, ControlValue> = {};
  const prefix = group.plugin ? `${group.plugin.id}:` : null;
  const items: SettingDefinition[] = group.commands.map((c) => {
    const key = `command:${c.command}`;
    values[key] = { get: () => isOn(c.command), set: (v) => set(c.command, v === true) };
    const name = prefix && c.command.startsWith(prefix) ? c.command.slice(prefix.length) : c.command;
    return { name, desc: c.description, control: { type: "toggle", key } };
  });
  return {
    title: "Commands",
    items: [
      {
        type: "page",
        // Obsidian finds a page by its name among all the tab's pages: one per module.
        name: `${moduleName} commands`,
        desc: "Choose which commands Claude can use. Each command that is on is a tool.",
        displayValue: () => `${group.commands.filter((c) => isOn(c.command)).length} of ${group.commands.length} on`,
        items,
      },
    ],
    values,
  };
}
