import { App, Plugin } from "./stubs/obsidian";
import { describe, expect, it, vi } from "vitest";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
import { ModuleRegistry } from "../src/core/ModuleRegistry";
import { mergeData, WorkspaceSettingTab, type CoreSettingsSection } from "../src/core/settings";
import { connectionSettings, type ConnectionSettingsDeps } from "../src/desktop/connection-settings";
import { voiceSettings } from "../src/desktop/voice/voice-settings";
import { helloModule } from "../src/modules/dummy";

/** Every row, groups flattened. */
function rows(items: SettingDefinitionItem[]): SettingDefinition[] {
  return items.flatMap((it) => ("type" in it ? (it.type === "page" ? [] : rows(it.items ?? [])) : [it]));
}
const controlKeys = (items: SettingDefinitionItem[]) => rows(items).flatMap((r) => (r.control ? [r.control.key] : []));
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

describe("settings tab", () => {
  function setup(sections: CoreSettingsSection[] = []) {
    const app = new App();
    const data = mergeData({ modules: { hello: { enabled: true } } });
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
    });
    registry.add(helloModule);
    const plugin = { registry, data, persist: vi.fn(async () => undefined), coreSettingsSections: sections, register: () => undefined };
    const tab = new WorkspaceSettingTab(app as never, plugin as never);
    tab.update(); // what addSettingTab does
    return { tab, registry, data, plugin };
  }

  it("gives each module's controls their own key and routes them to the module", async () => {
    const { tab, registry, data } = setup();
    await registry.start();
    const items = tab.getSettingDefinitions();
    expect(controlKeys(items)).toContain("modules.hello.greeting");
    expect(tab.getControlValue("modules.hello.greeting")).toBe("Hello");
    await tab.setControlValue("modules.hello.greeting", "Hi");
    expect(data.modules.hello?.data).toEqual({ greeting: "Hi" });
    expect(tab.getControlValue("modules.hello.greeting")).toBe("Hi");
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
    expect(keys).toEqual(expect.arrayContaining(["claudePath", "server.port", "voice.url", "voice.secret", "debug", "modules.hello.greeting"]));
    for (const key of keys) expect(tab.getControlValue(key), key).not.toBeUndefined();
  });

  it("redraws when modules start or are turned off", async () => {
    const { tab, registry } = setup();
    const hello = () => tab.settingItems.find((g) => rows([g])[0]?.name === helloModule.name);
    // Before start: the card shows the module, nothing it adds yet.
    expect(rows([hello()!]).map((r) => r.name)).toEqual([helloModule.name]);

    await registry.start();
    expect(rows([hello()!]).map((r) => r.name)).toEqual([helloModule.name, "What it adds", "Greeting"]);

    await registry.setEnabled("hello", false);
    expect(rows([hello()!]).map((r) => r.name)).toEqual([helloModule.name]);
  });
});
