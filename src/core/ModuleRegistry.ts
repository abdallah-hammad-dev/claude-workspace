import { ItemView, type App, type Plugin, type View, type ViewCreator, type WorkspaceLeaf } from "obsidian";
import type { ZodRawShape } from "zod";
import { createLogger } from "./logger";
import type {
  ActiveContext,
  ContextProvider,
  Disposer,
  ModuleContext,
  ModulePlatform,
  RegisteredTool,
  SettingsSection,
  SkillDef,
  ToolDef,
  WorkspaceModule,
} from "./module-api";

/** What the registry needs from the plugin. Kept narrow so tests can fake it. */
export interface RegistryHost {
  app: App;
  plugin: Plugin;
  platform: ModulePlatform;
  isDebug(): boolean;
  isModuleEnabled(id: string): boolean | undefined;
  setModuleEnabled(id: string, enabled: boolean): Promise<void>;
  loadModuleData(id: string): object | undefined;
  saveModuleData(id: string, data: object): Promise<void>;
  getActiveContext(): Promise<ActiveContext>;
  getActiveView(): View | null;
  notifyContextChanged(): void;
}

export type ModuleStatus =
  | "pending" // added, registry not started yet
  | "loaded"
  | "disabled" // toggled off by the user
  | "unavailable" // isAvailable() returned false
  | "unsupported" // wrong platform
  | "failed"; // onload threw

export interface ModuleInfo {
  id: string;
  name: string;
  description?: string;
  status: ModuleStatus;
  error?: string;
  required: boolean;
}

/** What a loaded module added, for the settings page. */
export interface ModuleContents {
  tools: { name: string; description: string; readOnly: boolean }[];
  contextProviders: { id: string; viewTypes: string[] }[];
  skills: string[];
  commands: string[];
  views: string[];
  settings: string[];
}

export interface ProviderEntry {
  moduleId: string;
  /** `${moduleId}.${provider.id}` */
  key: string;
  provider: ContextProvider;
}

export type RegistryChange = "tools" | "providers" | "views" | "settings" | "skills" | "modules";

interface Entry {
  mod: WorkspaceModule;
  status: ModuleStatus;
  error?: string;
  disposers: Disposer[];
}

const MODULE_ID = /^[a-z][a-z0-9]*$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export class ModuleRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly providers: ProviderEntry[] = [];
  private readonly sections: { moduleId: string; section: SettingsSection }[] = [];
  private readonly skills = new Map<string, { moduleId: string; skill: SkillDef }>();
  private readonly viewFactories = new Map<string, { moduleId: string; factory: ViewCreator }>();
  private readonly commands = new Map<string, { moduleId: string; name: string }>();
  /** View types registered with Obsidian. Obsidian can't unregister them, so we keep a trampoline. */
  private readonly obsidianViewTypes = new Set<string>();
  private readonly listeners = new Set<(change: RegistryChange) => void>();
  private readonly log;
  private started = false;
  /** Serializes load/unload so rapid toggles can't interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: RegistryHost) {
    this.log = createLogger("registry", () => host.isDebug());
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Add a module. Loads it right away if the registry is already started. */
  add(mod: WorkspaceModule): Disposer {
    if (!MODULE_ID.test(mod.id)) throw new Error(`Invalid module id "${mod.id}" (lowercase letters and digits)`);
    if (this.entries.has(mod.id)) throw new Error(`Module "${mod.id}" is already registered`);
    this.entries.set(mod.id, { mod, status: "pending", disposers: [] });
    if (this.started) void this.enqueue(() => this.load(mod.id));
    this.emit("modules");
    return () => void this.remove(mod.id);
  }

  async remove(id: string): Promise<void> {
    await this.enqueue(async () => {
      await this.unload(id);
      this.entries.delete(id);
    });
    this.emit("modules");
  }

  async start(): Promise<void> {
    this.started = true;
    await this.enqueue(async () => {
      for (const id of this.entries.keys()) await this.load(id);
    });
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.enqueue(async () => {
      for (const id of [...this.entries.keys()].reverse()) await this.unload(id);
    });
  }

  /** Retry modules whose dependency was missing (e.g. Excalidraw enabled after us). */
  async retryUnavailable(): Promise<void> {
    if (!this.started) return;
    const ids = [...this.entries.values()].filter((e) => e.status === "unavailable").map((e) => e.mod.id);
    if (!ids.length) return;
    await this.enqueue(async () => {
      for (const id of ids) {
        const entry = this.entries.get(id);
        if (entry) entry.status = "pending";
        await this.load(id);
      }
    });
    if (ids.some((id) => this.entries.get(id)?.status === "loaded")) this.emit("modules");
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (!this.entries.has(id)) throw new Error(`Unknown module "${id}"`);
    await this.host.setModuleEnabled(id, enabled);
    await this.enqueue(async () => {
      await this.unload(id);
      if (this.started) await this.load(id);
    });
    this.emit("modules");
  }

  isEnabled(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (entry.mod.required) return true;
    return this.host.isModuleEnabled(id) ?? entry.mod.enabledByDefault ?? true;
  }

  // ───────────────────────── queries ─────────────────────────

  list(): ModuleInfo[] {
    return [...this.entries.values()].map(({ mod, status, error }) => ({
      id: mod.id,
      name: mod.name,
      description: mod.description,
      status,
      error,
      required: !!mod.required,
    }));
  }

  getTools(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Providers applying to `viewType`, sorted by priority then registration order. */
  getProviders(viewType: string): ProviderEntry[] {
    return this.providers
      .filter((p) => p.provider.viewTypes.includes("*") || p.provider.viewTypes.includes(viewType))
      .sort((a, b) => (a.provider.priority ?? 100) - (b.provider.priority ?? 100));
  }

  getProvider(key: string): ProviderEntry | undefined {
    return this.providers.find((p) => p.key === key);
  }

  getSkills(): SkillDef[] {
    return [...this.skills.values()].map((s) => s.skill);
  }

  getSettingsSections(): { moduleId: string; section: SettingsSection }[] {
    return [...this.sections];
  }

  /** Everything a module currently has registered (empty unless it is loaded). */
  contentsOf(moduleId: string): ModuleContents {
    const mine = <T extends { moduleId: string }>(xs: Iterable<T>) => [...xs].filter((x) => x.moduleId === moduleId);
    return {
      tools: mine(this.tools.values()).map(({ def }) => ({
        name: def.name,
        description: def.description,
        readOnly: def.annotations?.readOnlyHint === true,
      })),
      contextProviders: mine(this.providers).map((p) => ({ id: p.provider.id, viewTypes: p.provider.viewTypes })),
      skills: mine(this.skills.values()).map((s) => s.skill.name),
      commands: mine(this.commands.values()).map((c) => c.name),
      views: [...this.viewFactories].filter(([, v]) => v.moduleId === moduleId).map(([type]) => type),
      settings: mine(this.sections).map((s) => s.section.title),
    };
  }

  onChange(fn: (change: RegistryChange) => void): Disposer {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ───────────────────────── internals ─────────────────────────

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private emit(change: RegistryChange): void {
    for (const fn of this.listeners) {
      try {
        fn(change);
      } catch (e) {
        this.log.error("change listener failed", e);
      }
    }
  }

  private async load(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.status === "loaded") return;
    const { mod } = entry;
    entry.error = undefined;

    if (mod.platforms && !mod.platforms.includes(this.host.platform)) {
      entry.status = "unsupported";
      return;
    }
    if (!this.isEnabled(id)) {
      entry.status = "disabled";
      return;
    }
    try {
      if (mod.isAvailable && !mod.isAvailable(this.host.app)) {
        entry.status = "unavailable";
        return;
      }
      await mod.onload(this.createContext(entry));
      entry.status = "loaded";
      this.log.debug(`loaded module ${id}`);
    } catch (e) {
      this.dispose(entry);
      entry.status = "failed";
      entry.error = e instanceof Error ? e.message : String(e);
      this.log.error(`module ${id} failed to load: ${entry.error}`);
    }
  }

  private async unload(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.status === "loaded") {
      try {
        await entry.mod.onunload?.();
      } catch (e) {
        this.log.error(`module ${id} onunload threw`, e);
      }
    }
    this.dispose(entry);
    entry.status = "pending";
  }

  private dispose(entry: Entry): void {
    for (const fn of entry.disposers.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        this.log.error(`dispose failed in module ${entry.mod.id}`, e);
      }
    }
  }

  private createContext(entry: Entry): ModuleContext {
    const { host } = this;
    const moduleId = entry.mod.id;
    const own = (fn: Disposer) => entry.disposers.push(fn);

    return {
      app: host.app,
      plugin: host.plugin,
      moduleId,
      log: createLogger(moduleId, () => host.isDebug()),

      registerTool: <S extends ZodRawShape>(def: ToolDef<S>) => {
        if (!def.name.startsWith(`${moduleId}_`)) {
          throw new Error(`Tool "${def.name}" must be prefixed with "${moduleId}_"`);
        }
        if (this.tools.has(def.name)) throw new Error(`Tool "${def.name}" is already registered`);
        this.tools.set(def.name, { moduleId, def });
        this.emit("tools");
        own(() => {
          this.tools.delete(def.name);
          this.emit("tools");
        });
      },

      registerContextProvider: (provider) => {
        const key = `${moduleId}.${provider.id}`;
        if (this.providers.some((p) => p.key === key)) throw new Error(`Context provider "${key}" already registered`);
        const item: ProviderEntry = { moduleId, key, provider };
        this.providers.push(item);
        this.emit("providers");
        own(() => {
          const i = this.providers.indexOf(item);
          if (i >= 0) this.providers.splice(i, 1);
          this.emit("providers");
        });
      },

      registerView: (type, factory) => {
        if (this.viewFactories.has(type)) throw new Error(`View type "${type}" already registered`);
        this.viewFactories.set(type, { moduleId, factory });
        if (!this.obsidianViewTypes.has(type)) {
          this.obsidianViewTypes.add(type);
          host.plugin.registerView(type, (leaf) => this.createView(type, leaf));
        }
        this.emit("views");
        own(() => {
          host.app.workspace.detachLeavesOfType(type);
          this.viewFactories.delete(type);
          this.emit("views");
        });
      },

      registerCommand: (cmd) => {
        const id = `${moduleId}-${cmd.id}`;
        host.plugin.addCommand({ ...cmd, id });
        this.commands.set(id, { moduleId, name: cmd.name });
        own(() => {
          host.plugin.removeCommand(id);
          this.commands.delete(id);
        });
      },

      registerSettings: (section) => {
        const item = { moduleId, section };
        this.sections.push(item);
        this.emit("settings");
        own(() => {
          const i = this.sections.indexOf(item);
          if (i >= 0) this.sections.splice(i, 1);
          this.emit("settings");
        });
      },

      registerSkill: (skill) => {
        if (!SKILL_NAME.test(skill.name)) throw new Error(`Invalid skill name "${skill.name}"`);
        if (this.skills.has(skill.name)) throw new Error(`Skill "${skill.name}" already registered`);
        this.skills.set(skill.name, { moduleId, skill });
        this.emit("skills");
        own(() => {
          this.skills.delete(skill.name);
          this.emit("skills");
        });
      },

      onDispose: own,
      getActiveContext: () => host.getActiveContext(),
      getActiveView: () => host.getActiveView(),
      notifyContextChanged: () => host.notifyContextChanged(),
      loadData: <T extends object>(defaults: T): T => ({ ...defaults, ...(host.loadModuleData(moduleId) ?? {}) }),
      saveData: (data) => host.saveModuleData(moduleId, data),
    };
  }

  private createView(type: string, leaf: WorkspaceLeaf) {
    const entry = this.viewFactories.get(type);
    // A layout restored after the module was disabled: show a placeholder instead of crashing.
    return entry ? entry.factory(leaf) : new DisabledModuleView(leaf, type);
  }
}

class DisabledModuleView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly type: string,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return this.type;
  }
  getDisplayText(): string {
    return "Module disabled";
  }
  override async onOpen(): Promise<void> {
    this.contentEl.setText("This view belongs to a Claude Workspace module that is disabled.");
  }
}
