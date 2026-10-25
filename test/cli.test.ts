import { App, Plugin } from "./stubs/obsidian";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CliFlags, SettingDefinitionPage } from "obsidian";
import { ToolError } from "../src/core/module-api";
import { ModuleRegistry } from "../src/core/ModuleRegistry";
import { loadedPlugin } from "../src/core/plugins";
import { CliBridge } from "../src/modules/cli";
import { cliModuleId, groupCommands, inputShape, isOnByDefault, toCliParams, toolName } from "../src/modules/cli/bridge";
import { obsidianCli, type CliCommand } from "../src/modules/cli/handlers";

const EXCALIDRAW = { id: "obsidian-excalidraw-plugin", name: "Excalidraw", version: "2.29.0" };
const MAP_VIEW = { id: "obsidian-map-view", name: "Map View", version: "5.0.0" };

const cmd = (command: string, description: string, flags: CliFlags | null = null): CliCommand => ({ command, description, flags });

describe("CLI handlers adapter", () => {
  it("returns null when Obsidian has no CLI registry", () => {
    expect(obsidianCli(new App() as never)).toBeNull();
    expect(obsidianCli({ cli: { handlers: {} } } as never)).toBeNull();
  });

  it("lists commands and runs a handler on its entry, like Obsidian's dispatcher", async () => {
    const entry = {
      description: "[Excalidraw]: Native Excalidraw CLI — read",
      flags: { path: { value: "<path>", description: "Drawing" } },
      handler(this: { description: string }, params: Record<string, string>) {
        return `${this.description}: ${params.path}`;
      },
    };
    const cli = obsidianCli({ cli: { handlers: new Map<string, unknown>([["obsidian-excalidraw-plugin:read", entry], ["broken", {}]]) } } as never)!;
    expect(cli.list()).toEqual([cmd("obsidian-excalidraw-plugin:read", entry.description, entry.flags)]);
    expect(await cli.run("obsidian-excalidraw-plugin:read", { path: "a.excalidraw.md" })).toBe(`${entry.description}: a.excalidraw.md`);
    await expect(cli.run("gone", {})).rejects.toThrow(/no longer registered/);
  });
});

describe("groupCommands", () => {
  it("sorts commands by the plugin Obsidian named in their description, and keeps Obsidian's own apart", () => {
    const groups = groupCommands(
      [
        cmd("search", "Search vault for text"),
        cmd("obsidian-excalidraw-plugin:read", "[Excalidraw]: Native Excalidraw CLI — read"),
        cmd("mv-geosearch", "[Map View]: Search for a location"), // no plugin-id prefix: only a convention
        cmd("daily:read", "Read daily note contents"),
      ],
      [EXCALIDRAW, MAP_VIEW],
    );
    expect(groups).toEqual([
      { plugin: null, commands: [cmd("daily:read", "Read daily note contents"), cmd("search", "Search vault for text")] },
      { plugin: EXCALIDRAW, commands: [cmd("obsidian-excalidraw-plugin:read", "Native Excalidraw CLI — read")] },
      { plugin: MAP_VIEW, commands: [cmd("mv-geosearch", "Search for a location")] },
    ]);
  });

  it("never offers Obsidian's developer commands, hidden ones, or those of a plugin that is gone", () => {
    const groups = groupCommands(
      [
        cmd("eval", "Execute JavaScript"),
        cmd("dev:console", "Show console"),
        cmd("devtools", "Open developer tools"),
        cmd("__completions", ""),
        cmd("old:thing", "[Old plugin]: something"),
        cmd("version", "Show Obsidian version"),
      ],
      [],
    );
    expect(groups).toEqual([{ plugin: null, commands: [cmd("version", "Show Obsidian version")] }]);
  });

  it("tells plugins with the same name apart by the command's plugin id", () => {
    const twin = { id: "other-excalidraw", name: "Excalidraw", version: "1.0.0" };
    const groups = groupCommands([cmd("obsidian-excalidraw-plugin:read", "[Excalidraw]: read")], [twin, EXCALIDRAW]);
    expect(groups.map((g) => g.plugin?.id)).toEqual(["obsidian-excalidraw-plugin"]);
  });
});

describe("names", () => {
  it("names a plugin's module after its manifest id, Obsidian's own `cli`", () => {
    expect(cliModuleId("obsidian-excalidraw-plugin", () => false)).toBe("obsidian-excalidraw-plugin");
    expect(cliModuleId(null, () => false)).toBe("cli");
    expect(cliModuleId("excalidraw", (id) => id === "excalidraw")).toBe("excalidraw-cli");
    expect(cliModuleId("My_Plugin.v2", () => false)).toBe("my-plugin-v2");
    expect(cliModuleId("2fa", () => false)).toBe("p2fa");
    const long = cliModuleId("a-plugin-with-a-really-long-manifest-identifier", () => false);
    expect(long).toMatch(/^a-plugin-with-a-really-[a-z0-9]{6}$/);
  });

  it("turns a command into a tool name: plugin id dropped, ':' → '_'", () => {
    expect(toolName("obsidian-excalidraw-plugin", "obsidian-excalidraw-plugin:read", EXCALIDRAW.id)).toBe("obsidian-excalidraw-plugin_read");
    expect(toolName("obsidian-excalidraw-plugin", "obsidian-excalidraw-plugin", EXCALIDRAW.id)).toBe("obsidian-excalidraw-plugin_default");
    expect(toolName("obsidian-map-view", "mv-geosearch", MAP_VIEW.id)).toBe("obsidian-map-view_mv-geosearch");
    expect(toolName("cli", "daily:read", null)).toBe("cli_daily_read");
  });

  it("keeps the MCP name (mcp__obsidian__<tool>) within 64 characters", () => {
    const a = toolName("a-plugin-with-a-really-l-abc123", "a-plugin:some-very-long-sub-command:with-parts", "a-plugin");
    const b = toolName("a-plugin-with-a-really-l-abc123", "a-plugin:some-very-long-sub-command:with-other", "a-plugin");
    expect(`mcp__obsidian__${a}`.length).toBeLessThanOrEqual(64);
    expect(a.startsWith("a-plugin-with-a-really-l-abc123_")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("inputShape and toCliParams", () => {
  const flags: CliFlags = {
    path: { value: "<path>", description: "Drawing path", required: true },
    limit: { value: "<n>", description: "Max files" },
    total: { description: "Return match count" },
    "<command>": { description: "Show help for a specific command" },
  };

  it("offers valued flags as text, bare flags as switches, and drops names the Claude API rejects", () => {
    const schema = z.toJSONSchema(z.object(inputShape(flags)), { io: "input" });
    expect(schema).toMatchObject({
      properties: {
        path: { type: "string", description: "Drawing path (<path>)" },
        limit: { type: "string", description: "Max files (<n>)" },
        total: { type: "boolean", description: "Return match count" },
      },
      required: ["path"],
    });
    expect(Object.keys(schema.properties ?? {})).toEqual(["path", "limit", "total"]);
  });

  it("accepts numbers and JSON where the CLI expects text, and passes what Obsidian's CLI would", () => {
    const args = z.object(inputShape({ ...flags, ids: { value: "<ids>", description: "JSON array" } })).parse({ path: "a.md", limit: 5, total: true, ids: ["x", "y"] });
    expect(toCliParams(args)).toEqual({ path: "a.md", limit: "5", total: "true", ids: '["x","y"]' });
    expect(toCliParams({ path: "a.md", total: false })).toEqual({ path: "a.md" });
  });

  it("leaves Obsidian's riskier commands off until the user turns them on", () => {
    const core = { plugin: null, commands: [] };
    expect(isOnByDefault(core, "search")).toBe(true);
    expect(isOnByDefault(core, "restart")).toBe(false);
    expect(isOnByDefault(core, "plugin:uninstall")).toBe(false);
    expect(isOnByDefault(core, "command")).toBe(false);
    expect(isOnByDefault({ plugin: EXCALIDRAW, commands: [] }, "obsidian-excalidraw-plugin:script")).toBe(true);
  });
});

describe("CliBridge", () => {
  function setup() {
    const calls: { command: string; params: Record<string, string> }[] = [];
    const handler = (command: string, out = "ok") => ({
      handler: (params: Record<string, string>) => {
        calls.push({ command, params });
        return out;
      },
    });
    const handlers = new Map<string, unknown>([
      ["search", { ...handler("search", "Projects/Alpha.md"), description: "Search vault for text", flags: { query: { value: "<text>", description: "Search query", required: true } } }],
      ["restart", { ...handler("restart"), description: "Restart the app", flags: null }],
      ["eval", { ...handler("eval"), description: "Execute JavaScript", flags: null }],
      ["obsidian-excalidraw-plugin:help", { ...handler("help", "how to"), description: "[Excalidraw]: Native Excalidraw CLI — help", flags: null }],
      [
        "obsidian-excalidraw-plugin:read",
        {
          description: "[Excalidraw]: Native Excalidraw CLI — read",
          flags: { path: { value: "<path>", description: "Drawing" }, selectedOnly: { description: "Live selection only" } },
          handler: (params: Record<string, string>) => {
            calls.push({ command: "read", params });
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- Obsidian's handlers throw strings
            if (!params.path) throw "Missing path";
            return '{"ok":true}';
          },
        },
      ],
    ]);
    const app = Object.assign(new App(), {
      cli: { handlers },
      plugins: { plugins: { [EXCALIDRAW.id]: { manifest: { name: EXCALIDRAW.name, version: EXCALIDRAW.version } } } },
    });
    const data: Record<string, { enabled?: boolean; data?: object }> = {};
    const registry = new ModuleRegistry({
      app: app as never,
      plugin: new Plugin(app) as never,
      platform: "desktop",
      isDebug: () => false,
      isModuleEnabled: (id) => data[id]?.enabled,
      setModuleEnabled: async (id, enabled) => void (data[id] = { ...data[id], enabled }),
      loadModuleData: (id) => data[id]?.data,
      saveModuleData: async (id, d) => void (data[id] = { ...data[id], data: d }),
      getActiveContext: async () => ({ activeFile: null, providers: {}, openTabs: [] }),
      getActiveView: () => null,
      notifyContextChanged: () => undefined,
      getPlugin: (id) => loadedPlugin(app as never, id),
    });
    const bridge = new CliBridge(app as never, registry);
    const tool = (name: string) => registry.getTool(name)?.def;
    return { app, handlers, registry, bridge, calls, tool, data };
  }

  it("adds a module per plugin, plus Obsidian's own (off by default)", async () => {
    const { registry, bridge } = setup();
    await registry.start();
    bridge.sync();
    await registry.reload("cli"); // let the queued loads finish
    expect(registry.list().map(({ id, name, status, plugin }) => ({ id, name, status, plugin }))).toEqual([
      { id: "cli", name: "Obsidian CLI", status: "disabled", plugin: undefined },
      { id: "obsidian-excalidraw-plugin", name: "Excalidraw CLI", status: "loaded", plugin: { id: EXCALIDRAW.id, name: "Excalidraw", version: "2.29.0" } },
    ]);
    expect(registry.getTools().map((t) => t.def.name)).toEqual(["obsidian-excalidraw-plugin_help", "obsidian-excalidraw-plugin_read"]);
  });

  it("runs the command inside Obsidian with the CLI's params, and reports its errors to Claude", async () => {
    const { registry, bridge, calls, tool } = setup();
    await registry.start();
    bridge.sync();
    await registry.reload("obsidian-excalidraw-plugin");
    const read = tool("obsidian-excalidraw-plugin_read")!;
    expect(read.description).toBe(
      "Native Excalidraw CLI — read. Obsidian CLI command `obsidian-excalidraw-plugin:read`, run inside Obsidian; returns its output as text. " +
        "Read obsidian-excalidraw-plugin_help first for how to use these commands.",
    );
    expect(await read.handler({ path: "Flow.excalidraw.md", selectedOnly: true }, { signal: new AbortController().signal })).toBe('{"ok":true}');
    expect(calls.at(-1)).toEqual({ command: "read", params: { path: "Flow.excalidraw.md", selectedOnly: "true" } });
    await expect(read.handler({}, { signal: new AbortController().signal })).rejects.toThrow(new ToolError("obsidian-excalidraw-plugin:read: Missing path"));
  });

  it("offers Obsidian's commands once turned on, except risky ones until switched on and developer ones never", async () => {
    const { registry, bridge, tool, data } = setup();
    data.cli = { enabled: true };
    await registry.start();
    bridge.sync();
    await registry.reload("cli");
    expect(registry.contentsOf("cli").tools.map((t) => t.name)).toEqual(["cli_search"]);
    expect(await tool("cli_search")!.handler({ query: "alpha" }, { signal: new AbortController().signal })).toBe("Projects/Alpha.md");

    // The "Obsidian CLI commands" page has a switch per command, eval not among them.
    const section = registry.getSettingsSections().find((s) => s.moduleId === "cli")!.section;
    const page = section.items[0] as SettingDefinitionPage;
    expect(page).toMatchObject({ type: "page", name: "Obsidian CLI commands" });
    expect(page.items?.map((r) => ("name" in r ? r.name : ""))).toEqual(["restart", "search"]);
    expect((page.displayValue as () => string)()).toBe("1 of 2 on");

    await section.values["command:restart"]!.set(true);
    expect(registry.contentsOf("cli").tools.map((t) => t.name)).toEqual(["cli_restart", "cli_search"]);
    expect(data.cli?.data).toEqual({ commands: { restart: true } });
  });

  it("follows plugins: new commands reload the module, a plugin turned off takes its module away", async () => {
    const { app, handlers, registry, bridge } = setup();
    await registry.start();
    bridge.sync();
    handlers.set("obsidian-excalidraw-plugin:export", { handler: () => "", description: "[Excalidraw]: Native Excalidraw CLI — export", flags: null });
    bridge.sync();
    await registry.reload("cli");
    expect(registry.contentsOf("obsidian-excalidraw-plugin").tools.map((t) => t.name)).toContain("obsidian-excalidraw-plugin_export");

    for (const k of [...handlers.keys()]) if (k.startsWith("obsidian-excalidraw-plugin")) handlers.delete(k);
    delete app.plugins.plugins[EXCALIDRAW.id];
    bridge.sync();
    await registry.reload("cli");
    expect(registry.list().map((m) => m.id)).toEqual(["cli"]);
  });
});
