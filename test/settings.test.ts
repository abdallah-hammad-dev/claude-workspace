import { App, Plugin } from "./stubs/obsidian";
import { describe, expect, it, vi } from "vitest";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
import { ModuleRegistry } from "../src/core/ModuleRegistry";
import type { WorkspaceModule } from "../src/core/module-api";
import type { ModuleInfo } from "../src/core/ModuleRegistry";
import { mergeData, moduleSections, WorkspaceSettingTab, type CoreSettingsSection } from "../src/core/settings";
import { connectionSettings, type ConnectionSettingsDeps } from "../src/desktop/connection-settings";
import { voiceSettings } from "../src/desktop/voice/voice-settings";

/** Every row, groups flattened. Pages' rows too when `pages` is set. */
function rows(items: SettingDefinitionItem[], pages = false): SettingDefinition[] {
  return items.flatMap((it) => ("type" in it ? (it.type === "page" && !pages ? [] : rows(it.items ?? [], pages)) : [it]));
}
const controlKeys = (items: SettingDefinitionItem[]) => rows(items, true).flatMap((r) => (r.control ? [r.control.key] : []));
const named = (items: SettingDefinitionItem[], name: string) => rows(items).find((r) => r.name === name);

function connection(overrides: Partial<ConnectionSettingsDeps> = {}) {
  const setClaudePath = vi.fn(async (_v: string) => undefined);
  const setPort = vi.fn(async (_p: number | null) => undefined);
  const deps: ConnectionSettingsDeps = {
    claudePath: () => "",
    setClaudePath,
    detectClaude: () => "/usr/local/bin/claude",
    serverState: () => ({ status: "listening", port: 27557 }),
    port: () => null,
    defaultPort: 27557,
    setPort,
    restartServer: async () => undefined,
    installStatus: async () => true,
    install: async () => undefined,
    copyMcpAddCommand: async () => undefined,
    regenerateToken: async () => undefined,
    ...overrides,
  };
  return { setClaudePath, setPort, block: connectionSettings(deps, () => undefined) };
}

function voice(enabled: boolean) {
  const prefs = { ...mergeData({}).voice, enabled };
  const setPrefs = vi.fn(async (p: object) => void Object.assign(prefs, p));
  return { prefs, setPrefs, block: voiceSettings({ prefs: () => prefs, setPrefs, check: async () => "ok" }) };
}

describe("connection settings", () => {
  it("shows the port as text and keeps only a usable one", async () => {
    let port: number | null = null;
    const { setPort, block } = connection({ port: () => port });
    const value = block.values["server.port"]!;
    expect(value.get()).toBe("");
    port = 27600;
    expect(value.get()).toBe("27600");

    for (const [typed, saved] of [
      ["27600", 27600],
      ["", null],
      ["80", null],
      ["70000", null],
      ["port", null],
    ] as const) {
      await value.set(typed);
      expect(setPort).toHaveBeenLastCalledWith(saved);
    }
  });

  it("trims the Claude Code path and offers the detected one as placeholder", async () => {
    const { setClaudePath, block } = connection();
    await block.values.claudePath!.set("  C:\\claude.exe ");
    expect(setClaudePath).toHaveBeenCalledWith("C:\\claude.exe");
    const row = named(block.items, "Claude Code executable");
    expect(row?.control).toMatchObject({ type: "text", key: "claudePath", placeholder: "/usr/local/bin/claude" });
  });
});

describe("voice settings", () => {
  it("hides everything but the switch while voice input is off", () => {
    const { prefs, block } = voice(false);
    const [toggle, ...rest] = rows(block.items);
    const visible = (r: SettingDefinition) => (typeof r.visible === "function" ? r.visible() : (r.visible ?? true));
    expect(toggle?.control?.key).toBe("voice.enabled");
    expect(visible(toggle!)).toBe(true);
    expect(rest.map(visible)).toEqual(rest.map(() => false));
    prefs.enabled = true;
    expect(rest.map(visible)).toEqual(rest.map(() => true));
  });

  it("keeps the API key in the keychain and saves cleaned-up values", async () => {
    const { setPrefs, block } = voice(true);
    expect(named(block.items, "API key")?.control).toEqual({ type: "secret", key: "voice.secret" });
    await block.values["voice.url"]!.set("  https://example.com/v1 ");
    expect(setPrefs).toHaveBeenLastCalledWith({ url: "https://example.com/v1" });
    await block.values["voice.secret"]!.set(null);
    expect(setPrefs).toHaveBeenLastCalledWith({ secret: "" });
    await block.values["voice.live"]!.set(false);
    expect(setPrefs).toHaveBeenLastCalledWith({ live: false });
    expect(block.values["voice.language"]!.get()).toBe("");
  });
});

/** A module with one text setting, saved in its module data. */
const greeter: WorkspaceModule = {
  id: "greeter",
  name: "Greeter",
  onload(ctx) {
    const settings = ctx.loadData({ greeting: "Hello" });
    ctx.registerTool({ name: "greeter_greet", description: "Greet.", inputSchema: {}, handler: async () => settings.greeting });
    ctx.registerSettings({
      title: "Greeter",
      items: [{ name: "Greeting", control: { type: "text", key: "greeting" } }],
      values: {
        greeting: {
          get: () => settings.greeting,
          set: async (v) => {
            settings.greeting = String(v);
            await ctx.saveData(settings);
          },
        },
      },
    });
  },
};

describe("settings tab", () => {
  function setup(sections: CoreSettingsSection[] = []) {
    const app = new App();
    const data = mergeData({});
    const registry = new ModuleRegistry({
      app: app as never,
      plugin: new Plugin(app) as never,
      platform: "desktop",
      isDebug: () => false,
      isModuleEnabled: (id) => data.modules[id]?.enabled,
      setModuleEnabled: async (id, enabled) => void (data.modules[id] = { ...data.modules[id], enabled }),
      loadModuleData: (id) => data.modules[id]?.data,
      saveModuleData: async (id, d) => void (data.modules[id] = { ...data.modules[id], data: d }),
      getActiveContext: async () => ({ activeFile: null, providers: {}, openTabs: [] }),
      getActiveView: () => null,
      notifyContextChanged: () => undefined,
      getPlugin: () => null,
    });
    registry.add(greeter);
    const plugin = { registry, data, persist: vi.fn(async () => undefined), coreSettingsSections: sections, register: () => undefined };
    const tab = new WorkspaceSettingTab(app as never, plugin as never);
    tab.update(); // what addSettingTab does
    return { tab, registry, data, plugin };
  }

  it("gives each module's controls their own key and routes them to the module", async () => {
    const { tab, registry, data } = setup();
    await registry.start();
    const items = tab.getSettingDefinitions();
    expect(controlKeys(items)).toContain("modules.greeter.greeting");
    expect(tab.getControlValue("modules.greeter.greeting")).toBe("Hello");
    await tab.setControlValue("modules.greeter.greeting", "Hi");
    expect(data.modules.greeter?.data).toEqual({ greeting: "Hi" });
    expect(tab.getControlValue("modules.greeter.greeting")).toBe("Hi");
  });

  it("saves debug logging in plugin data", async () => {
    const { tab, data, plugin } = setup();
    tab.getSettingDefinitions();
    await tab.setControlValue("debug", true);
    expect(data.debug).toBe(true);
    expect(plugin.persist).toHaveBeenCalled();
  });

  it("has a value behind every control", async () => {
    const { tab, registry } = setup([() => connection().block, () => voice(true).block]);
    await registry.start();
    const keys = controlKeys(tab.getSettingDefinitions());
    expect(keys).toEqual(expect.arrayContaining(["claudePath", "server.port", "voice.url", "voice.secret", "debug", "modules.greeter.greeting"]));
    for (const key of keys) expect(tab.getControlValue(key), key).not.toBeUndefined();
  });

  it("prefixes the keys of controls on a module's sub-page too", async () => {
    const { tab, registry } = setup();
    let on = false;
    registry.add({
      id: "paged",
      name: "Paged",
      onload(ctx) {
        ctx.registerSettings({
          title: "Paged",
          items: [{ type: "page", name: "Paged options", items: [{ name: "Thing", control: { type: "toggle", key: "thing" } }] }],
          values: { thing: { get: () => on, set: (v) => void (on = v === true) } },
        });
      },
    });
    await registry.start();
    expect(controlKeys(tab.getSettingDefinitions())).toContain("modules.paged.thing");
    await tab.setControlValue("modules.paged.thing", true);
    expect(on).toBe(true);
  });

  it("redraws when modules start or are turned off", async () => {
    const { tab, registry } = setup();
    const card = () => tab.settingItems.find((g) => rows([g])[0]?.name === greeter.name);
    // Before start: the card shows the module, nothing it adds yet.
    expect(rows([card()!]).map((r) => r.name)).toEqual([greeter.name]);

    await registry.start();
    expect(rows([card()!]).map((r) => r.name)).toEqual([greeter.name, "What it adds", "Greeting"]);

    await registry.setEnabled("greeter", false);
    expect(rows([card()!]).map((r) => r.name)).toEqual([greeter.name]);
  });
});

describe("moduleSections", () => {
  const info = (id: string, plugin?: ModuleInfo["plugin"]): ModuleInfo => ({ id, name: id === "excalidraw" ? "Excalidraw" : id, status: "loaded", required: false, plugin });

  it("puts modules about Obsidian first, then one section per plugin, named and versioned like the plugin", () => {
    const ex = { id: "obsidian-excalidraw-plugin", name: "Excalidraw", version: "2.29.0" };
    const sections = moduleSections([
      info("obsidian"),
      info("excalidraw", ex),
      info("markdown"),
      info("quickadd", { id: "quickadd", name: "QuickAdd", version: "2.1.0" }),
      info("obsidian-excalidraw-plugin", ex),
    ]);
    expect(sections.map((s) => [s.heading, s.modules.map((m) => m.id)])).toEqual([
      ["Core modules", ["obsidian", "markdown"]],
      ["Excalidraw 2.29.0", ["excalidraw", "obsidian-excalidraw-plugin"]],
      ["QuickAdd 2.1.0", ["quickadd"]],
    ]);
  });

  it("uses the module's name while its plugin isn't loaded", () => {
    expect(moduleSections([info("excalidraw", { id: "obsidian-excalidraw-plugin" })])).toEqual([
      { heading: "Excalidraw", modules: [info("excalidraw", { id: "obsidian-excalidraw-plugin" })] },
    ]);
  });
});
