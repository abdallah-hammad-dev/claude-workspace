import { Setting, setIcon } from "obsidian";
import { settingGroup } from "../core/setting-group";
import type { HostState } from "./McpHost";

export interface ConnectionSettingsDeps {
  claudePathOverride: string;
  setClaudePathOverride(v: string): Promise<void>;
  detectedClaude: string | null;
  serverState: HostState;
  port: number | null;
  defaultPort: number;
  setPort(port: number | null): Promise<void>;
  restartServer(): Promise<void>;
  installStatus(): Promise<boolean>;
  install(): Promise<void>;
  copyMcpAddCommand(): Promise<void>;
  regenerateToken(): Promise<void>;
}

type Tone = "ok" | "warn" | "error";

/** "Connection" section of the settings tab: status at a glance, then the knobs. No Node imports here. */
export function renderConnectionSettings(el: HTMLElement, d: ConnectionSettingsDeps, refresh: () => void): void {
  const intro = el.createDiv({ cls: "cw-settings-section" });
  intro.createDiv({ cls: "cw-settings-title", text: "Connection" });
  const card = el.createDiv({ cls: "cw-status-card" });
  const row = (tone: Tone, label: string, value: string, detail?: string) => {
    const r = card.createDiv({ cls: `cw-status-row is-${tone}` });
    setIcon(r.createSpan({ cls: "cw-status-icon" }), tone === "ok" ? "circle-check" : tone === "warn" ? "circle-dot" : "circle-alert");
    const text = r.createDiv({ cls: "cw-status-text" });
    const line = text.createDiv({ cls: "cw-status-line" });
    line.createSpan({ cls: "cw-status-label", text: label });
    line.createSpan({ cls: "cw-status-value", text: value });
    if (detail) text.createDiv({ cls: "cw-status-detail", text: detail });
    return r;
  };

  const claude = d.claudePathOverride || d.detectedClaude;
  row(claude ? "ok" : "error", "Claude Code", claude ? "Found" : "Not found", claude ?? "Install Claude Code from code.claude.com, or set its path below.");

  const s = d.serverState;
  if (s.status === "listening") row("ok", "Local server", "Running", `127.0.0.1:${s.port}, only reachable from this computer`);
  else row("error", "Local server", s.status === "error" ? "Not running" : "Stopped", s.status === "error" ? s.message : undefined);

  const vault = row("warn", "This vault", "Checking…");
  void d.installStatus().then((ok) => {
    vault.className = `cw-status-row is-${ok ? "ok" : "warn"}`;
    setIcon(vault.querySelector(".cw-status-icon") as HTMLElement, ok ? "circle-check" : "circle-dot");
    vault.querySelector(".cw-status-value")?.setText(ok ? "Connected" : "Not connected");
    const text = vault.querySelector(".cw-status-text") as HTMLElement;
    text.createDiv({
      cls: "cw-status-detail",
      text: ok
        ? "Context hook, MCP server and module skills are installed in this vault."
        : "Claude can't see what you're looking at yet. Install writes the hook and MCP config into this vault.",
    });
    if (!ok) {
      const b = vault.createEl("button", { cls: "mod-cta", text: "Install" });
      b.onclick = async () => {
        await d.install();
        refresh();
      };
    }
  });

  const list = settingGroup(el);
  new Setting(list)
    .setName("Claude Code executable")
    .setDesc(d.claudePathOverride ? "Using this path instead of the auto-detected one." : "Leave empty to auto-detect.")
    .addText((t) =>
      t
        .setPlaceholder(d.detectedClaude ?? "path to claude or claude.exe")
        .setValue(d.claudePathOverride)
        .onChange(async (v) => d.setClaudePathOverride(v.trim())),
    );

  new Setting(list)
    .setName("Server port")
    .setDesc("Change it if another app uses the port. Restart the server and install again afterwards.")
    .addText((t) =>
      t
        .setPlaceholder(String(d.defaultPort))
        .setValue(d.port ? String(d.port) : "")
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          await d.setPort(n > 1024 && n < 65536 ? n : null);
        }),
    )
    .addButton((b) =>
      b.setButtonText("Restart server").onClick(async () => {
        await d.restartServer();
        refresh();
      }),
    );

  new Setting(list)
    .setName("Reinstall vault config")
    .setDesc("Rewrites .mcp.json, the context hook in .claude/settings.json and module skills. Merges with what is already there. These files contain the server token: keep them out of git and sync.")
    .addButton((b) =>
      b.setButtonText("Install again").onClick(async () => {
        await d.install();
        refresh();
      }),
    );

  new Setting(list)
    .setName("Use the tools from any folder")
    .setDesc("Copies a `claude mcp add --scope user …` command that registers this vault's MCP server for every project.")
    .addButton((b) => b.setButtonText("Copy command").onClick(() => void d.copyMcpAddCommand()));

  new Setting(list)
    .setName("Regenerate token")
    .setDesc("Invalidates the current server token, for example if a config file leaked. Install again afterwards.")
    .addButton((b) =>
      b
        .setButtonText("Regenerate")
        .setWarning()
        .onClick(async () => {
          await d.regenerateToken();
          refresh();
        }),
    );
}
