import { setIcon, type Setting, type SettingDefinition } from "obsidian";
import type { SettingsBlock } from "../core/settings";
import type { HostState } from "./McpHost";

export interface ConnectionSettingsDeps {
  /** Path set by the user; "" = auto-detect. */
  claudePath(): string;
  setClaudePath(v: string): Promise<void>;
  detectClaude(): string | null;
  serverState(): HostState;
  port(): number | null;
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
export function connectionSettings(d: ConnectionSettingsDeps, refresh: () => void): SettingsBlock {
  const button = (name: string, desc: string, text: string, run: () => Promise<void>, warning = false): SettingDefinition => ({
    name,
    desc,
    render: (s) => {
      s.addButton((b) => {
        b.setButtonText(text).onClick(run);
        if (warning) b.setWarning();
      });
    },
  });

  return {
    items: [
      {
        type: "group",
        heading: "Connection",
        cls: "cw-status-group",
        items: [
          {
            name: "Claude Code",
            render: (s) => {
              const claude = d.claudePath() || d.detectClaude();
              showStatus(s, claude ? "ok" : "error", claude ? "Found" : "Not found", claude ?? "Install Claude Code from code.claude.com, or set its path below.");
            },
          },
          {
            name: "Local server",
            render: (s) => {
              const state = d.serverState();
              if (state.status === "listening") showStatus(s, "ok", "Running", `127.0.0.1:${state.port}, only reachable from this computer`);
              else showStatus(s, "error", state.status === "error" ? "Not running" : "Stopped", state.status === "error" ? state.message : undefined);
              s.addButton((b) =>
                b.setButtonText("Restart").onClick(async () => {
                  await d.restartServer();
                  refresh();
                }),
              );
            },
          },
          {
            name: "This vault",
            render: (s) => {
              let stale = false;
              showStatus(s, "warn", "Checking…");
              void d.installStatus().then((ok) => {
                if (stale) return;
                showStatus(
                  s,
                  ok ? "ok" : "warn",
                  ok ? "Connected" : "Not connected",
                  ok
                    ? "Context hook, MCP server and module skills are installed in this vault."
                    : "Claude can't see what you're looking at yet. Install writes the hook and MCP config into this vault.",
                );
                if (!ok) {
                  s.addButton((b) =>
                    b
                      .setButtonText("Install")
                      .setCta()
                      .onClick(async () => {
                        await d.install();
                        refresh();
                      }),
                  );
                }
              });
              // The row is redrawn in place: an answer for the previous drawing must not land in it.
              return () => {
                stale = true;
              };
            },
          },
        ],
      },
      {
        type: "group",
        items: [
          {
            name: "Claude Code executable",
            desc: d.claudePath() ? "Using this path instead of the auto-detected one." : "Leave empty to auto-detect.",
            control: { type: "text", key: "claudePath", placeholder: d.detectClaude() ?? "path to claude or claude.exe" },
          },
          {
            name: "Server port",
            desc: "Change it if another app uses the port, then restart the server and install again.",
            control: { type: "text", key: "server.port", placeholder: String(d.defaultPort) },
          },
          button(
            "Reinstall vault config",
            "Rewrites .mcp.json, the context hook in .claude/settings.json and module skills. Merges with what is already there. These files contain the server token: keep them out of git and sync.",
            "Install again",
            async () => {
              await d.install();
              refresh();
            },
          ),
          button(
            "Use the tools from any folder",
            "Copies a `claude mcp add --scope user …` command that registers this vault's MCP server for every project.",
            "Copy command",
            () => d.copyMcpAddCommand(),
          ),
          button(
            "Regenerate token",
            "Invalidates the current server token, for example if a config file leaked. Install again afterwards.",
            "Regenerate",
            async () => {
              await d.regenerateToken();
              refresh();
            },
            true,
          ),
        ],
      },
    ],
    values: {
      claudePath: { get: () => d.claudePath(), set: (v) => d.setClaudePath(String(v).trim()) },
      "server.port": {
        get: () => (d.port() ? String(d.port()) : ""),
        set: (v) => d.setPort(parsePort(String(v))),
      },
    },
  };
}

/** The port typed in settings; empty or out of range means "derived from the vault". */
export function parsePort(text: string): number | null {
  const n = parseInt(text, 10);
  return n > 1024 && n < 65536 ? n : null;
}

/** Status line: icon, name followed by its value, detail below. Can be called again on the same row. */
function showStatus(s: Setting, tone: Tone, value: string, detail?: string): void {
  s.settingEl.removeClass("is-ok", "is-warn", "is-error");
  s.settingEl.addClass("cw-status-row", `is-${tone}`);
  let icon = s.settingEl.querySelector<HTMLElement>(":scope > .cw-status-icon");
  if (!icon) {
    icon = s.settingEl.createSpan({ cls: "cw-status-icon" });
    s.settingEl.prepend(icon);
  }
  setIcon(icon, tone === "ok" ? "circle-check" : tone === "warn" ? "circle-dot" : "circle-alert");
  s.nameEl.querySelector(".cw-status-value")?.remove();
  s.nameEl.createSpan({ cls: "cw-status-value", text: value });
  s.setDesc(detail ?? "");
}
