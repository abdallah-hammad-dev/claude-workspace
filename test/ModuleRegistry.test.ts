import { App, Plugin, WorkspaceLeaf } from "./stubs/obsidian";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModuleContext, WorkspaceModule } from "../src/core/module-api";
import { ModuleRegistry, type RegistryHost } from "../src/core/ModuleRegistry";
import { compareVersions, type PluginInfo } from "../src/core/plugins";

function setup(opts: { platform?: "desktop" | "mobile"; enabled?: Record<string, boolean>; plugins?: PluginInfo[] } = {}) {
  const app = new App();
  const plugin = new Plugin(app);
  const enabled: Record<string, boolean> = { ...opts.enabled };
  /** Loaded Obsidian plugins; tests change it to turn plugins on and off. */
  const plugins: PluginInfo[] = [...(opts.plugins ?? [])];
  const data: Record<string, object> = {};
  const host: RegistryHost = {
    app: app as never,
    plugin: plugin as never,
    platform: opts.platform ?? "desktop",
    isDebug: () => false,
    isModuleEnabled: (id) => enabled[id],
    setModuleEnabled: (id, v) => {
      enabled[id] = v;
      return Promise.resolve();
    },
    loadModuleData: (id) => data[id],
    saveModuleData: (id, d) => {
      data[id] = d;
      return Promise.resolve();
    },
    getActiveContext: () => Promise.resolve({ activeFile: null, providers: {}, openTabs: [] }),
    getActiveView: () => null,
    notifyContextChanged: () => undefined,
    getPlugin: (id) => plugins.find((p) => p.id === id) ?? null,
  };
  return { registry: new ModuleRegistry(host), app, plugin, enabled, data, plugins };
}

/** A module that registers one of everything. */
function fullModule(id = "demo", extra: Partial<WorkspaceModule> = {}): WorkspaceModule & { ctx?: ModuleContext } {
  const mod: WorkspaceModule & { ctx?: ModuleContext } = {
    id,
    name: id,
    onload(ctx) {
      mod.ctx = ctx;
      ctx.registerTool({
        name: `${id}_ping`,
        description: "ping",
        inputSchema: { x: z.number() },
        handler: async ({ x }) => x + 1,
      });
      ctx.registerContextProvider({ id: "p", viewTypes: ["markdown"], collect: () => ({ a: 1 }) });
      ctx.registerCommand({ id: "cmd", name: "Cmd", callback: () => undefined });
      ctx.registerView(`${id}-view`, (leaf) => ({ leaf }) as never);
      ctx.registerSettings({ title: id, items: [], values: {} });
      ctx.registerSkill({ name: `${id}-skill`, markdown: "---\nname: x\n---\n" });
    },
    ...extra,
  };
  return mod;
}

describe("ModuleRegistry", () => {
  it("loads enabled modules and collects their registrations", async () => {
    const { registry, plugin } = setup();
    registry.add(fullModule());
    await registry.start();

    expect(registry.list()).toEqual([
      // Modules added without an origin come from other plugins, through `plugin.api.registerModule`.
      { id: "demo", name: "demo", description: undefined, status: "loaded", error: undefined, required: false, origin: { kind: "plugin" } },
    ]);
    expect(registry.getTools().map((t) => t.def.name)).toEqual(["demo_ping"]);
    expect(registry.getProviders("markdown").map((p) => p.key)).toEqual(["demo.p"]);
    expect(registry.getProviders("excalidraw")).toEqual([]);
    expect(registry.getSkills().map((s) => s.name)).toEqual(["demo-skill"]);
    expect(registry.getSettingsSections()).toHaveLength(1);
    expect(plugin.commands.has("demo-cmd")).toBe(true);
    expect(plugin.views.has("demo-view")).toBe(true);
  });

  it("does not load before start()", () => {
    const { registry } = setup();
    registry.add(fullModule());
    expect(registry.getTools()).toEqual([]);
    expect(registry.list()[0]?.status).toBe("pending");
  });

  it("disabling a module disposes everything it registered", async () => {
    const { registry, plugin, app } = setup();
    const onunload = vi.fn();
    const onDispose = vi.fn();
    const mod = fullModule("demo", {});
    const origOnload = mod.onload.bind(mod);
    mod.onload = (ctx) => {
      void origOnload(ctx);
      ctx.onDispose(onDispose);
    };
    mod.onunload = onunload;
    registry.add(mod);
    await registry.start();

    await registry.setEnabled("demo", false);

    expect(registry.list()[0]?.status).toBe("disabled");
    expect(registry.getTools()).toEqual([]);
    expect(registry.getProviders("markdown")).toEqual([]);
    expect(registry.getSkills()).toEqual([]);
    expect(registry.getSettingsSections()).toEqual([]);
    expect(plugin.commands.has("demo-cmd")).toBe(false);
    expect(app.workspace.detached).toContain("demo-view");
    expect(onunload).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
  });

  it("re-enabling works even though Obsidian can't unregister view types", async () => {
    const { registry, plugin } = setup();
    registry.add(fullModule());
    await registry.start();
    await registry.setEnabled("demo", false);
    await registry.setEnabled("demo", true);

    expect(registry.list()[0]?.status).toBe("loaded");
    expect(registry.getTools()).toHaveLength(1);
    // The trampoline registered once still dispatches to the new factory.
    const view = plugin.views.get("demo-view")!(new WorkspaceLeaf());
    expect(view).toHaveProperty("leaf");
  });

  it("shows a placeholder for a view whose module is disabled", async () => {
    const { registry, plugin } = setup();
    registry.add(fullModule());
    await registry.start();
    await registry.setEnabled("demo", false);
    const view = plugin.views.get("demo-view")!(new WorkspaceLeaf());
    expect(view.getDisplayText()).toBe("Module disabled");
  });

  it("respects enabledByDefault and the saved toggle", async () => {
    const { registry } = setup({ enabled: { b: true } });
    registry.add(fullModule("a", { enabledByDefault: false }));
    registry.add(fullModule("b", { enabledByDefault: false }));
    await registry.start();
    expect(registry.list().map((m) => [m.id, m.status])).toEqual([
      ["a", "disabled"],
      ["b", "loaded"],
    ]);
  });

  it("skips unavailable and wrong-platform modules without registering anything", async () => {
    const { registry } = setup({ platform: "mobile" });
    registry.add(fullModule("a", { isAvailable: () => false }));
    registry.add(fullModule("b", { platforms: ["desktop"] }));
    await registry.start();
    expect(registry.list().map((m) => m.status)).toEqual(["unavailable", "unsupported"]);
    expect(registry.getTools()).toEqual([]);
  });

  it("rolls back partial registrations when onload throws", async () => {
    const { registry, plugin } = setup();
    registry.add({
      id: "broken",
      name: "broken",
      onload(ctx) {
        ctx.registerCommand({ id: "c", name: "c", callback: () => undefined });
        throw new Error("boom");
      },
    });
    await registry.start();
    expect(registry.list()[0]).toMatchObject({ status: "failed", error: "boom" });
    expect(plugin.commands.size).toBe(0);
  });

  it("enforces the tool-name prefix", async () => {
    const { registry } = setup();
    registry.add({
      id: "demo",
      name: "demo",
      onload(ctx) {
        ctx.registerTool({ name: "ping", description: "", inputSchema: {}, handler: async () => null });
      },
    });
    await registry.start();
    expect(registry.list()[0]?.error).toMatch(/prefixed with "demo_"/);
  });

  it("rejects invalid and duplicate module ids", () => {
    const { registry } = setup();
    expect(() => registry.add(fullModule("Bad-Id"))).toThrow(/Invalid module id/);
    expect(() => registry.add(fullModule("bad_id"))).toThrow(/Invalid module id/);
    registry.add(fullModule("obsidian-excalidraw-plugin")); // a plugin's manifest id is fine
    registry.add(fullModule("x"));
    expect(() => registry.add(fullModule("x"))).toThrow(/already registered/);
  });

  it("loads modules added after start (external plugins) and removes them", async () => {
    const { registry } = setup();
    await registry.start();
    const dispose = registry.add(fullModule("ext"));
    await vi.waitFor(() => expect(registry.getTools()).toHaveLength(1));
    dispose();
    await vi.waitFor(() => expect(registry.list()).toEqual([]));
    expect(registry.getTools()).toEqual([]);
  });

  it("emits change events for tools", async () => {
    const { registry } = setup();
    const changes: string[] = [];
    registry.onChange((c) => changes.push(c));
    registry.add(fullModule());
    await registry.start();
    await registry.setEnabled("demo", false);
    expect(changes.filter((c) => c === "tools")).toEqual(["tools", "tools"]);
  });

  it("sorts providers by priority", async () => {
    const { registry } = setup();
    registry.add({
      id: "m",
      name: "m",
      onload(ctx) {
        ctx.registerContextProvider({ id: "late", viewTypes: ["*"], priority: 200, collect: () => null });
        ctx.registerContextProvider({ id: "early", viewTypes: ["markdown"], priority: 10, collect: () => null });
      },
    });
    await registry.start();
    expect(registry.getProviders("markdown").map((p) => p.key)).toEqual(["m.early", "m.late"]);
  });

  it("scopes per-module data", async () => {
    const { registry, data } = setup();
    const mod = fullModule();
    registry.add(mod);
    await registry.start();
    expect(mod.ctx!.loadData({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    await mod.ctx!.saveData({ a: 5 });
    expect(data.demo).toEqual({ a: 5 });
    expect(mod.ctx!.loadData({ a: 1, b: 2 })).toEqual({ a: 5, b: 2 });
  });
});

describe("refreshAvailability", () => {
  it("loads a module once its dependency appears", async () => {
    const { registry } = setup();
    let present = false;
    registry.add(fullModule("dep", { isAvailable: () => present }));
    await registry.start();
    expect(registry.list()[0]?.status).toBe("unavailable");
    present = true;
    await registry.refreshAvailability();
    expect(registry.list()[0]?.status).toBe("loaded");
    expect(registry.getTools()).toHaveLength(1);
  });
});

describe("modules for a plugin", () => {
  const excalidraw = (version: string): PluginInfo => ({ id: "obsidian-excalidraw-plugin", name: "Excalidraw", version });

  it("load only while their plugin is loaded, and say which plugin they are for", async () => {
    const { registry, plugins } = setup();
    registry.add(fullModule("draw", { plugin: { id: "obsidian-excalidraw-plugin" } }));
    await registry.start();
    expect(registry.list()[0]).toMatchObject({ status: "unavailable", reason: undefined, plugin: { id: "obsidian-excalidraw-plugin" } });

    plugins.push(excalidraw("2.28.1"));
    await registry.refreshAvailability();
    expect(registry.list()[0]).toMatchObject({ status: "loaded", plugin: { id: "obsidian-excalidraw-plugin", name: "Excalidraw", version: "2.28.1" } });

    // Turned off in Obsidian: the module goes away with it.
    plugins.pop();
    await registry.refreshAvailability();
    expect(registry.list()[0]?.status).toBe("unavailable");
    expect(registry.getTools()).toEqual([]);
  });

  it("wait for the minimum version and say why", async () => {
    const { registry, plugins } = setup({ plugins: [excalidraw("2.28.1")] });
    registry.add(fullModule("draw", { plugin: { id: "obsidian-excalidraw-plugin", minVersion: "2.29.0" } }));
    await registry.start();
    expect(registry.list()[0]).toMatchObject({
      status: "unavailable",
      reason: "Needs Excalidraw 2.29.0 or newer; 2.28.1 is installed.",
    });

    plugins[0] = excalidraw("2.29.0");
    await registry.refreshAvailability();
    expect(registry.list()[0]).toMatchObject({ status: "loaded", reason: undefined });
  });

  it("can be reloaded to register something else", async () => {
    const { registry } = setup();
    let tools = ["a"];
    registry.add({
      id: "dyn",
      name: "dyn",
      onload(ctx) {
        for (const t of tools) ctx.registerTool({ name: `dyn_${t}`, description: "", inputSchema: {}, handler: async () => null });
      },
    });
    await registry.start();
    tools = ["b", "c"];
    await registry.reload("dyn");
    expect(registry.getTools().map((t) => t.def.name)).toEqual(["dyn_b", "dyn_c"]);
  });
});

describe("compareVersions", () => {
  it("compares part by part, as numbers, with pre-releases first", () => {
    expect(compareVersions("2.29.0", "2.28.1")).toBe(1);
    expect(compareVersions("2.9.0", "2.10.0")).toBe(-1);
    expect(compareVersions("2.29", "2.29.0")).toBe(0);
    expect(compareVersions("2.29.0-beta-1", "2.29.0")).toBe(-1);
    expect(compareVersions("2.29.0", "2.29.0-beta-1")).toBe(1);
    expect(compareVersions("1.0.0-beta-1", "1.0.0-beta-2")).toBe(-1);
  });
});

describe("contentsOf", () => {
  it("lists what a loaded module registered, and nothing once disabled", async () => {
    const { registry } = setup();
    registry.add(fullModule());
    await registry.start();
    expect(registry.contentsOf("demo")).toEqual({
      tools: [{ name: "demo_ping", description: "ping", readOnly: false }],
      contextProviders: [{ id: "p", viewTypes: ["markdown"] }],
      skills: ["demo-skill"],
      commands: ["Cmd"],
      views: ["demo-view"],
      settings: ["demo"],
    });
    await registry.setEnabled("demo", false);
    expect(registry.contentsOf("demo")).toEqual({ tools: [], contextProviders: [], skills: [], commands: [], views: [], settings: [] });
  });
});
