import { App, Plugin } from "./stubs/obsidian";
import { describe, expect, it } from "vitest";
import type { WorkspaceModule } from "../src/core/module-api";
import { ModuleRegistry } from "../src/core/ModuleRegistry";
import { mergeData } from "../src/core/settings";
import { ShippedModules } from "../src/modules/shipped";

const markdown: WorkspaceModule = { id: "markdown", name: "Markdown notes", onload: () => undefined };
const drawing: WorkspaceModule = { id: "drawing", name: "Drawing", plugin: { id: "draw-plugin" }, onload: () => undefined };

function setup(saved: unknown = {}) {
  const app = new App();
  const data = mergeData(saved);
  const registry = new ModuleRegistry({
    app: app as never,
    plugin: new Plugin(app) as never,
    platform: "desktop",
    isDebug: () => false,
    isModuleEnabled: (id) => data.modules[id]?.enabled,
    setModuleEnabled: async (id, v) => void (data.modules[id] = { ...data.modules[id], enabled: v }),
    loadModuleData: (id) => data.modules[id]?.data,
    saveModuleData: async () => undefined,
    getActiveContext: async () => ({ activeFile: null, providers: {}, openTabs: [] }),
    getActiveView: () => null,
    notifyContextChanged: () => undefined,
    getPlugin: () => null,
  });
  const shipped = new ShippedModules(registry, [markdown, drawing], {
    deleted: () => data.deletedModules,
    setDeleted: async (ids) => void (data.deletedModules = ids),
    forget: async (id) => void delete data.modules[id],
  });
  return { registry, shipped, data, origins: () => registry.list().map((m) => [m.id, m.origin.kind]) };
}

describe("shipped modules", () => {
  it("are built in when about Obsidian, custom when written for another plugin", () => {
    const { shipped, origins } = setup();
    shipped.add();
    expect(origins()).toEqual([
      ["markdown", "builtin"],
      ["drawing", "custom"],
    ]);
  });

  it("deletes a custom one until it is restored, forgetting its settings", async () => {
    const { registry, shipped, data, origins } = setup({ modules: { drawing: { enabled: false } } });
    shipped.add();
    await shipped.delete("drawing");
    expect(origins()).toEqual([["markdown", "builtin"]]);
    expect(data.deletedModules).toEqual(["drawing"]);
    expect(data.modules.drawing).toBeUndefined();
    expect(shipped.deleted().map((m) => m.id)).toEqual(["drawing"]);

    await shipped.restore("drawing");
    expect(origins()).toEqual([
      ["markdown", "builtin"],
      ["drawing", "custom"],
    ]);
    expect(data.deletedModules).toEqual([]);
    expect(registry.isEnabled("drawing")).toBe(true);
  });

  it("leaves deleted ones out at start, and never deletes a built-in one", async () => {
    const { shipped, origins } = setup({ deletedModules: ["drawing", 42] });
    shipped.add();
    expect(origins()).toEqual([["markdown", "builtin"]]);
    await shipped.delete("markdown");
    expect(origins()).toEqual([["markdown", "builtin"]]);
  });
});
