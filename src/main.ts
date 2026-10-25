import { Notice, Platform, Plugin } from "obsidian";
import { ContextEngine } from "./core/context/ContextEngine";
import { createLogger } from "./core/logger";
import type { ClaudeWorkspaceApi, WorkspaceModule } from "./core/module-api";
import { ModuleRegistry } from "./core/ModuleRegistry";
import { loadedPlugin, loadedPlugins } from "./core/plugins";
import { mergeData, WorkspaceSettingTab, type CoreSettingsSection, type PluginData } from "./core/settings";
import type { DesktopServices } from "./desktop";
import { builtinModules } from "./modules";
import { CliBridge } from "./modules/cli";

/** How often to look for plugins turned on, off or updated, and for new CLI commands (Obsidian has no event). */
const PLUGIN_WATCH_MS = 2000;

export default class ClaudeWorkspacePlugin extends Plugin {
  data!: PluginData;
  registry!: ModuleRegistry;
  engine!: ContextEngine;
  /** Server, installer and chat view. Null on mobile. */
  desktop: DesktopServices | null = null;
  coreSettingsSections: CoreSettingsSection[] = [];
  /** Public API for other plugins: `app.plugins.plugins["claude-workspace"].api`. */
  api!: ClaudeWorkspaceApi;
  /** Modules for the commands plugins register with Obsidian's CLI. Desktop only, like that CLI. */
  cliBridge: CliBridge | null = null;
  private pluginsSeen = "";
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
      getPlugin: (id) => loadedPlugin(this.app, id),
    });
    this.engine = new ContextEngine(this.app, this.registry, createLogger("context", () => this.data.debug));
    this.engine.attach(this);

    this.api = {
      version: 1,
      registerModule: (mod: WorkspaceModule) => this.registry.add(mod),
    };

    for (const mod of builtinModules) this.registry.add(mod);
    if (Platform.isDesktopApp) this.cliBridge = new CliBridge(this.app, this.registry);

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
    // After the desktop sections are in: Obsidian reads the definitions when the tab is added.
    this.addSettingTab(new WorkspaceSettingTab(this.app, this));

    // Modules may depend on other plugins (Excalidraw), which load in any order.
    this.app.workspace.onLayoutReady(() => {
      void this.registry.start().then(() => {
        this.log.debug("modules started");
        this.watchPlugins();
        // Chromium slows timers to about one a minute while the window is hidden: catch up when it shows again.
        this.registerInterval(window.setInterval(() => this.watchPlugins(), PLUGIN_WATCH_MS));
        this.registerDomEvent(document, "visibilitychange", () => {
          if (!document.hidden) this.watchPlugins();
        });
      });
    });
  }

  override onunload(): void {
    void this.desktop?.dispose();
    this.cliBridge?.dispose();
    void this.registry.stop();
  }

  /** A plugin turned on, off or updated changes which modules can load and which CLI commands exist. */
  private watchPlugins(): void {
    const seen = loadedPlugins(this.app)
      .map((p) => `${p.id}@${p.version}`)
      .join(",");
    if (seen !== this.pluginsSeen) {
      this.pluginsSeen = seen;
      void this.registry.refreshAvailability();
    }
    this.cliBridge?.sync();
  }

  async persist(): Promise<void> {
    await this.saveData(this.data);
  }
}
