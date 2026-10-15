import {
  debounce,
  PluginSettingTab,
  setIcon,
  type App,
  type SettingDefinition,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
} from "obsidian";
import type ClaudeWorkspacePlugin from "../main";
import type { ControlValue, SettingsSection } from "./module-api";
import type { ModuleContents, ModuleInfo, ModuleRegistry, ModuleStatus } from "./ModuleRegistry";

export interface ModuleSettings {
  enabled?: boolean;
  data?: object;
}

export interface ServerSettings {
  /** null → derived from the vault so several vaults don't collide. */
  port: number | null;
  token: string;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatPrefs {
  /** "" = Claude Code's default model. */
  model: string;
  permissionMode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto";
  /** Reasoning effort; "" = Claude Code's default for the model. */
  effort: EffortLevel | "";
}

export interface VoicePrefs {
  /** Show the mic in the chat. Off until the user turns voice input on. */
  enabled: boolean;
  /** OpenAI-compatible API base; the plugin calls `<url>/audio/transcriptions`. */
  url: string;
  model: string;
  /** Name of the API key in Obsidian's keychain (app.secretStorage); the key itself is never stored here. */
  secret: string;
  /** Spoken language code; "" = detected by the service. */
  language: string;
  /** Send each phrase at pauses so text appears while talking; off = one request when the user stops. */
  live: boolean;
}

/** Everything persisted in `.obsidian/plugins/claude-workspace/data.json`. */
export interface PluginData {
  debug: boolean;
  modules: Record<string, ModuleSettings>;
  server: ServerSettings;
  /** Override for the Claude Code executable; "" = auto-detect. */
  claudePath: string;
  chat: ChatPrefs;
  voice: VoicePrefs;
  /** The chat panel is opened automatically once, so new users find it. */
  chatShownOnce: boolean;
}

export const DEFAULT_DATA: PluginData = {
  debug: false,
  modules: {},
  server: { port: null, token: "" },
  claudePath: "",
  chat: { model: "", permissionMode: "default", effort: "" },
  // Groq's free tier, prefilled; any OpenAI-compatible endpoint works (desktop/voice/providers.ts).
  voice: { enabled: false, url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", secret: "", language: "", live: true },
  chatShownOnce: false,
};

export function mergeData(saved: unknown): PluginData {
  const s = (saved && typeof saved === "object" ? saved : {}) as Partial<PluginData>;
  return {
    ...DEFAULT_DATA,
    ...s,
    modules: { ...(s.modules && typeof s.modules === "object" ? s.modules : {}) },
    server: { ...DEFAULT_DATA.server, ...s.server },
    chat: { ...DEFAULT_DATA.chat, ...s.chat },
    voice: { ...DEFAULT_DATA.voice, ...s.voice },
  };
}

const BADGES: Record<ModuleStatus, { text: string; tone: string }> = {
  loaded: { text: "On", tone: "ok" },
  disabled: { text: "Off", tone: "off" },
  pending: { text: "Starting…", tone: "off" },
  unavailable: { text: "Needs its plugin", tone: "warn" },
  unsupported: { text: "Desktop only", tone: "off" },
  failed: { text: "Error", tone: "error" },
};

/** Part of the settings tab: Obsidian setting definitions, and where the values of their `control` rows live, by key. */
export interface SettingsBlock {
  items: SettingDefinitionItem[];
  values: Record<string, ControlValue>;
}

/** Settings added by the desktop layer (connection, voice input). `refresh` re-reads the definitions and redraws the tab. */
export type CoreSettingsSection = (refresh: () => void) => SettingsBlock;

/**
 * Declarative settings tab (Obsidian 1.13+): Obsidian renders and indexes for search what
 * `getSettingDefinitions()` returns. Values live in `plugin.data`, module data and the desktop
 * services, not in `plugin.settings`, so controls go through `values` by key.
 */
export class WorkspaceSettingTab extends PluginSettingTab {
  /** Rebuilt with the definitions. */
  private values = new Map<string, ControlValue>();

  constructor(
    app: App,
    private readonly plugin: ClaudeWorkspacePlugin,
  ) {
    super(app, plugin);
    this.containerEl.addClass("cw-settings");
    // Obsidian draws the definitions kept by the last update(): re-read them when modules change.
    const refresh = debounce(() => this.update(), 50, true);
    plugin.register(plugin.registry.onChange(() => refresh()));
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const refresh = () => this.update();
    const blocks = [...this.plugin.coreSettingsSections.map((section) => section(refresh)), this.modules(), this.advanced()];
    this.values = new Map(blocks.flatMap((b) => Object.entries(b.values)));
    return blocks.flatMap((b) => b.items);
  }

  override getControlValue(key: string): unknown {
    return this.values.get(key)?.get();
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    await this.values.get(key)?.set(value);
  }

  /** One card per module: name and status, on/off, what it adds, its own settings. */
  private modules(): SettingsBlock {
    const { registry } = this.plugin;
    const values: Record<string, ControlValue> = {};
    const items = registry.list().map((info, i): SettingDefinitionGroup => {
      const rows = [moduleRow(info, registry)];
      if (info.status === "loaded") {
        rows.push(contentsRow(registry.contentsOf(info.id)));
        for (const { section } of registry.getSettingsSections().filter((x) => x.moduleId === info.id)) {
          rows.push(...scoped(`modules.${info.id}`, section, values));
        }
      }
      return { type: "group", heading: i === 0 ? "Modules" : undefined, cls: "cw-module-group", items: rows };
    });
    return { items, values };
  }

  private advanced(): SettingsBlock {
    const { plugin } = this;
    return {
      items: [
        {
          type: "group",
          heading: "Advanced",
          items: [
            {
              name: "Debug logging",
              desc: "Log debug messages to the developer console. Never logs tokens or note contents.",
              control: { type: "toggle", key: "debug" },
            },
          ],
        },
      ],
      values: {
        debug: {
          get: () => plugin.data.debug,
          set: async (v) => {
            plugin.data.debug = v === true;
            await plugin.persist();
          },
        },
      },
    };
  }
}

/** Name with a status badge, description, on/off toggle. A render row for the badge. */
function moduleRow(info: ModuleInfo, registry: ModuleRegistry): SettingDefinition {
  const badge = info.required && info.status === "loaded" ? { text: "Always on", tone: "ok" } : BADGES[info.status];
  return {
    name: info.name,
    desc: info.error ? `Error: ${info.error}` : (info.description ?? ""),
    render: (setting) => {
      setting.nameEl.createSpan({ cls: `cw-badge is-${badge.tone}`, text: badge.text });
      setting.addToggle((t) =>
        t
          .setValue(registry.isEnabled(info.id))
          .setDisabled(info.status === "unsupported" || info.required)
          // The registry announces the change, which redraws the tab.
          .onChange((v) => registry.setEnabled(info.id, v)),
      );
    },
  };
}

function contentsRow(c: ModuleContents): SettingDefinition {
  return {
    name: "What it adds",
    searchable: false,
    render: (setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClass("cw-module-contents-row");
      renderContents(setting.settingEl, c);
    },
  };
}

/** A module's rows, with control keys prefixed so that modules can't collide. */
function scoped(prefix: string, section: SettingsSection, values: Record<string, ControlValue>): SettingDefinition[] {
  return section.items.map((def) => {
    if (!def.control) return def;
    const key = `${prefix}.${def.control.key}`;
    const value = section.values[def.control.key];
    if (value) values[key] = value;
    return { ...def, control: { ...def.control, key } };
  });
}

/** Collapsible "what this module adds", inside the module's card. */
function renderContents(parent: HTMLElement, c: ModuleContents): void {
  const details = parent.createEl("details", { cls: "cw-module-contents" });
  const parts = [
    plural(c.tools.length, "tool"),
    plural(c.contextProviders.length, "context source"),
    plural(c.skills.length, "skill"),
    plural(c.commands.length, "command"),
    plural(c.views.length, "view"),
  ].filter(Boolean);
  const summary = details.createEl("summary");
  setIcon(summary.createSpan({ cls: "cw-module-contents-chevron" }), "chevron-right");
  summary.createSpan({ text: `What it adds: ${parts.join(" · ") || "nothing"}` });

  const body = details.createDiv({ cls: "cw-module-contents-body" });
  const section = (icon: string, title: string, hint: string, items: { name: string; desc?: string; tag?: string }[]) => {
    if (!items.length) return;
    const head = body.createDiv({ cls: "cw-module-contents-title" });
    setIcon(head.createSpan(), icon);
    head.createSpan({ text: title });
    body.createDiv({ cls: "cw-module-contents-hint", text: hint });
    const list = body.createDiv({ cls: "cw-module-contents-list" });
    for (const it of items) {
      const row = list.createDiv({ cls: "cw-module-contents-item" });
      const top = row.createDiv();
      top.createEl("code", { text: it.name });
      if (it.tag) top.createSpan({ cls: "cw-badge is-off", text: it.tag });
      if (it.desc) row.createDiv({ cls: "cw-module-contents-desc", text: it.desc });
    }
  };
  section(
    "wrench",
    "MCP tools",
    "What Claude can do. Claude Code asks your permission according to the chat's permission mode.",
    c.tools.map((t) => ({ name: t.name, desc: firstSentence(t.description), tag: t.readOnly ? "read-only" : undefined })),
  );
  section(
    "eye",
    "Context",
    "What Claude sees with each of your messages.",
    c.contextProviders.map((p) => ({ name: p.id, desc: `When the focused view is ${p.viewTypes.includes("*") ? "any view" : p.viewTypes.join(", ")}` })),
  );
  section(
    "book-open",
    "Claude Code skills",
    "Instructions Claude loads when a request is about this topic (.claude/skills/<name>/SKILL.md).",
    c.skills.map((name) => ({ name })),
  );
  section("command", "Obsidian commands", "For you, in the command palette.", c.commands.map((name) => ({ name })));
  section("layout-panel-left", "Views", "Panels this module can open.", c.views.map((name) => ({ name })));
}

function plural(n: number, word: string): string {
  return n ? `${n} ${word}${n > 1 ? "s" : ""}` : "";
}

function firstSentence(text: string): string {
  const m = /^.*?[.!?](\s|$)/.exec(text);
  return (m ? m[0] : text).trim();
}
