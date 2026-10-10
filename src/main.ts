import { Platform, Plugin } from "obsidian";
import { createLogger } from "./core/logger";
import type { ActiveContext, ClaudeWorkspaceApi, WorkspaceModule } from "./core/module-api";
import { ModuleRegistry } from "./core/ModuleRegistry";
import { mergeData, WorkspaceSettingTab, type PluginData } from "./core/settings";
import { builtinModules } from "./modules";

export default class ClaudeWorkspacePlugin extends Plugin {
  data!: PluginData;
  registry!: ModuleRegistry;
  /** Public API for other plugins: `app.plugins.plugins["claude-workspace"].api`. */
  api!: ClaudeWorkspaceApi;
  private readonly log = createLogger("core", () => this.data?.debug ?? false);

  override async onload(): Promise<void> {
    this.data = mergeData(await this.loadData());

    this.registry = new ModuleRegistry({
      app: this.app,
      plugin: this,
      platform: Platform.isDesktopApp ? "desktop" : "mobile",
      isDebug: () => this.data.debug,
      isModuleEnabled: (id) => this.data.modules[id]?.enabled,
      setModuleEnabled: async (id, enabled) => {
        this.data.modules[id] = { ...this.data.modules[id], enabled };
        await this.persist();
      },
      loadModuleData: (id) => this.data.modules[id]?.data,
      saveModuleData: async (id, data) => {
        this.data.modules[id] = { ...this.data.modules[id], data };
        await this.persist();
      },
      getActiveContext: () => this.getActiveContext(),
    });

    this.api = {
      version: 1,
      registerModule: (mod: WorkspaceModule) => this.registry.add(mod),
    };

    for (const mod of builtinModules) this.registry.add(mod);
    this.addSettingTab(new WorkspaceSettingTab(this.app, this));

    // Modules may depend on other plugins (Excalidraw), which load in any order.
    this.app.workspace.onLayoutReady(() => {
      void this.registry.start().then(() => this.log.debug("modules started"));
    });
  }

  override onunload(): void {
    void this.registry.stop();
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
  }

  /** Placeholder until the ContextEngine lands in M1. */
  private getActiveContext(): Promise<ActiveContext> {
    const file = this.app.workspace.getActiveFile();
    return Promise.resolve({
      activeFile: file ? { path: file.path, viewType: "unknown" } : null,
      providers: {},
      openTabs: [],
    });
  }
}
