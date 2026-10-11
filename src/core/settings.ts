import { PluginSettingTab, Setting, type App } from "obsidian";
import type ClaudeWorkspacePlugin from "../main";

export interface ModuleSettings {
  enabled?: boolean;
  data?: object;
}

export interface ServerSettings {
  /** null → derived from the vault so several vaults don't collide. */
  port: number | null;
  token: string;
}

export interface ChatPrefs {
  /** "" = Claude Code's default model. */
  model: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto";
}

/** Everything persisted in `.obsidian/plugins/claude-workspace/data.json`. */
export interface PluginData {
  debug: boolean;
  modules: Record<string, ModuleSettings>;
  server: ServerSettings;
  /** Override for the Claude Code executable; "" = auto-detect. */
  claudePath: string;
  chat: ChatPrefs;
}

export const DEFAULT_DATA: PluginData = {
  debug: false,
  modules: {},
  server: { port: null, token: "" },
  claudePath: "",
  chat: { model: "", permissionMode: "default" },
};

export function mergeData(saved: unknown): PluginData {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<PluginData>;
  return {
    ...DEFAULT_DATA,
    ...s,
    modules: { ...(s.modules && typeof s.modules === "object" ? s.modules : {}) },
    server: { ...DEFAULT_DATA.server, ...s.server },
    chat: { ...DEFAULT_DATA.chat, ...s.chat },
  };
}

const STATUS_LABEL: Record<string, string> = {
  unavailable: " — unavailable (dependency missing)",
  unsupported: " — not supported on this platform",
  failed: " — failed to load",
};

/** Extra settings sections contributed by the desktop layer (server, installer, chat). */
export type CoreSettingsSection = (containerEl: HTMLElement, refresh: () => void) => void;

export class WorkspaceSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ClaudeWorkspacePlugin,
  ) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl, plugin } = this;
    containerEl.empty();
    const refresh = () => this.display();

    for (const section of plugin.coreSettingsSections) section(containerEl, refresh);

    new Setting(containerEl).setName("Modules").setHeading();
    for (const info of plugin.registry.list()) {
      const setting = new Setting(containerEl)
        .setName(info.name + (STATUS_LABEL[info.status] ?? ""))
        .setDesc(info.error ? `Error: ${info.error}` : (info.description ?? ""));
      setting.addToggle((t) =>
        t
          .setValue(plugin.registry.isEnabled(info.id))
          .setDisabled(info.status === "unsupported" || info.required)
          .onChange(async (v) => {
            await plugin.registry.setEnabled(info.id, v);
            refresh();
          }),
      );
    }

    for (const { section } of plugin.registry.getSettingsSections()) {
      new Setting(containerEl).setName(section.title).setHeading();
      section.display(containerEl.createDiv());
    }

    new Setting(containerEl).setName("Advanced").setHeading();
    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Log debug messages to the developer console. Never logs tokens or note contents.")
      .addToggle((t) =>
        t.setValue(plugin.data.debug).onChange(async (v) => {
          plugin.data.debug = v;
          await plugin.persist();
        }),
      );
  }
}
