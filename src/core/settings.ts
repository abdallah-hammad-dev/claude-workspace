import { PluginSettingTab, Setting, setIcon, type App } from "obsidian";
import type ClaudeWorkspacePlugin from "../main";
import type { ModuleContents, ModuleStatus } from "./ModuleRegistry";
import { settingGroup } from "./setting-group";

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
  /** The chat panel is opened automatically once, so new users find it. */
  chatShownOnce: boolean;
}

export const DEFAULT_DATA: PluginData = {
  debug: false,
  modules: {},
  server: { port: null, token: "" },
  claudePath: "",
  chat: { model: "", permissionMode: "default" },
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

/** Extra settings sections contributed by the desktop layer (connection, installer). */
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
    containerEl.addClass("cw-settings");
    const refresh = () => this.display();

    for (const section of plugin.coreSettingsSections) section(containerEl, refresh);

    const intro = containerEl.createDiv({ cls: "cw-settings-section" });
    intro.createDiv({ cls: "cw-settings-title", text: "Modules" });
    intro.createDiv({ cls: "cw-settings-desc", text: "Each module gives Claude tools, context or skills for one part of Obsidian." });
    for (const info of plugin.registry.list()) {
      const list = settingGroup(containerEl, undefined, "cw-module-group");
      const badge = info.required && info.status === "loaded" ? { text: "Always on", tone: "ok" } : BADGES[info.status];
      new Setting(list)
        .setName(
          createFragment((f) => {
            f.createSpan({ text: info.name });
            f.createSpan({ cls: `cw-badge is-${badge.tone}`, text: badge.text });
          }),
        )
        .setDesc(info.error ? `Error: ${info.error}` : (info.description ?? ""))
        .addToggle((t) =>
          t
            .setValue(plugin.registry.isEnabled(info.id))
            .setDisabled(info.status === "unsupported" || info.required)
            .onChange(async (v) => {
              await plugin.registry.setEnabled(info.id, v);
              refresh();
            }),
        );
      if (info.status !== "loaded") continue;
      renderContents(list.createDiv({ cls: "setting-item cw-module-contents-row" }), plugin.registry.contentsOf(info.id));
      for (const { section } of plugin.registry.getSettingsSections().filter((x) => x.moduleId === info.id)) section.display(list);
    }

    const advanced = settingGroup(containerEl, "Advanced");
    new Setting(advanced)
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
