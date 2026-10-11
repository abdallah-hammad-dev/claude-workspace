import { PluginSettingTab, Setting, type App } from "obsidian";
import type ClaudeWorkspacePlugin from "../main";
import type { ModuleContents, ModuleStatus } from "./ModuleRegistry";

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
      renderContents(containerEl, plugin.registry.contentsOf(info.id), info.status);
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

/** Collapsible "what this module adds" under its toggle. */
function renderContents(parent: HTMLElement, c: ModuleContents, status: ModuleStatus): void {
  const details = parent.createEl("details", { cls: "cw-module-contents" });
  const parts = [
    plural(c.tools.length, "tool"),
    plural(c.contextProviders.length, "context provider"),
    plural(c.skills.length, "skill"),
    plural(c.commands.length, "command"),
    plural(c.views.length, "view"),
  ].filter(Boolean);
  details.createEl("summary", {
    text: status !== "loaded" ? "What it adds: shown once the module is enabled and loaded" : `What it adds: ${parts.join(" · ") || "nothing"}`,
  });
  if (status !== "loaded") return;

  const section = (title: string, hint: string, items: { name: string; desc?: string }[]) => {
    if (!items.length) return;
    details.createEl("div", { cls: "cw-module-contents-title", text: title });
    details.createEl("div", { cls: "cw-muted", text: hint });
    const ul = details.createEl("ul");
    for (const it of items) {
      const li = ul.createEl("li");
      li.createEl("code", { text: it.name });
      if (it.desc) li.createSpan({ text: ` — ${it.desc}` });
    }
  };
  section(
    "MCP tools",
    "What Claude can do. Served by the local MCP server as mcp__obsidian__<name>; Claude Code asks your permission per your mode.",
    c.tools.map((t) => ({ name: t.name, desc: (t.readOnly ? "read-only. " : "") + firstSentence(t.description) })),
  );
  section(
    "Context",
    "What Claude sees before each of your messages (the <obsidian_context> block).",
    c.contextProviders.map((p) => ({ name: p.id, desc: `when the focused view is ${p.viewTypes.includes("*") ? "any view" : p.viewTypes.join(", ")}` })),
  );
  section(
    "Claude Code skills",
    "Instructions Claude loads when a request is about this topic. Written to .claude/skills/<name>/SKILL.md.",
    c.skills.map((name) => ({ name })),
  );
  section("Obsidian commands", "For you, in the command palette.", c.commands.map((name) => ({ name })));
  section("Views", "Panels this module can open.", c.views.map((name) => ({ name })));
}

function plural(n: number, word: string): string {
  return n ? `${n} ${word}${n > 1 ? "s" : ""}` : "";
}

function firstSentence(text: string): string {
  const m = /^.*?[.!?](\s|$)/.exec(text);
  return (m ? m[0] : text).trim();
}
