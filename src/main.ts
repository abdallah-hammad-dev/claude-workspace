import { Notice, Platform, Plugin } from "obsidian";
import { ContextEngine } from "./core/context/ContextEngine";
import { createLogger } from "./core/logger";
import type { ClaudeWorkspaceApi, WorkspaceModule } from "./core/module-api";
import { ModuleRegistry } from "./core/ModuleRegistry";
import { mergeData, WorkspaceSettingTab, type CoreSettingsSection, type PluginData } from "./core/settings";
import type { DesktopServices } from "./desktop";
import { builtinModules } from "./modules";

export default class ClaudeWorkspacePlugin extends Plugin {
  data!: PluginData;
  registry!: ModuleRegistry;
  engine!: ContextEngine;
  /** Server, installer and chat view. Null on mobile. */
  desktop: DesktopServices | null = null;
  coreSettingsSections: CoreSettingsSection[] = [];
  /** Public API for other plugins: `app.plugins.plugins["claude-workspace"].api`. */
  api!: ClaudeWorkspaceApi;
  readonly log = createLogger("core", () => this.data?.debug ?? false);

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
      getActiveContext: () => this.engine.collect(),
      getActiveView: () => this.engine.currentLeaf()?.view ?? null,
      notifyContextChanged: () => this.engine.notifyChanged(),
    });
    this.engine = new ContextEngine(this.app, this.registry, createLogger("context", () => this.data.debug));
    this.engine.attach(this);

    this.api = {
      version: 1,
      registerModule: (mod: WorkspaceModule) => this.registry.add(mod),
    };

    for (const mod of builtinModules) this.registry.add(mod);
    this.addSettingTab(new WorkspaceSettingTab(this.app, this));

    // Node-only code lives behind a dynamic import so the bundle still loads on mobile.
    if (Platform.isDesktopApp) {
      try {
        const { startDesktop } = await import("./desktop");
        this.desktop = await startDesktop(this);
      } catch (e) {
        this.log.error("desktop features failed to start", e);
        new Notice(`Claude Workspace: failed to start (${e instanceof Error ? e.message : String(e)}). See the developer console.`, 15000);
      }
    }

    // Modules may depend on other plugins (Excalidraw), which load in any order.
    this.app.workspace.onLayoutReady(() => {
      void this.registry.start().then(() => this.log.debug("modules started"));
    });
  }

  override onunload(): void {
    void this.desktop?.dispose();
    void this.registry.stop();
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
  }
}
