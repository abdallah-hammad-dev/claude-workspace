import { appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { debounce, Notice } from "obsidian";
import { vaultBasePath } from "../core/paths";
import { createLogger, setLogSink } from "../core/logger";
import type ClaudeWorkspacePlugin from "../main";
import { CHAT_VIEW_TYPE, ChatView, type ChatHost } from "./chat/ChatView";
import { enhancedPath, locateClaude } from "./claude-binary";
import { patchSetMaxListenersForElectron } from "./electron-compat";
import { defaultPortFor, generateToken } from "./http-guard";
import { Installer } from "./Installer";
import { mcpAddCommand, type InstallTarget } from "./installer-merge";
import { renderConnectionSettings } from "./connection-settings";
import { McpHost, SERVER_NAME, type ServedContext } from "./McpHost";
import { createVoice } from "./voice";

export interface DesktopServices {
  host: McpHost;
  dispose(): Promise<void>;
}

/** Everything that needs Node: local server, installer, chat view. */
export async function startDesktop(plugin: ClaudeWorkspacePlugin): Promise<DesktopServices> {
  const { app } = plugin;
  const vaultPath = vaultBasePath(app) ?? "";

  // Warnings and errors also go to <vault>/.obsidian/plugins/claude-workspace/debug.log (no tokens, no note text).
  const logFile = join(vaultPath, app.vault.configDir, "plugins", plugin.manifest.id, "debug.log");
  const writeLog = (level: string, line: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`);
    } catch {
      // logging must never break the plugin
    }
  };
  setLogSink(writeLog);
  const unpatchEvents = patchSetMaxListenersForElectron();
  writeLog("info", `plugin ${plugin.manifest.version} starting on ${process.platform}`);
  // Uncaught errors coming from our code (stack frames are tagged plugin:claude-workspace).
  plugin.registerDomEvent(window, "error", (e: ErrorEvent) => {
    const stack = e.error instanceof Error ? (e.error.stack ?? "") : "";
    if (stack.includes(plugin.manifest.id)) writeLog("error", `uncaught: ${e.message}\n${stack}`);
  });
  plugin.registerDomEvent(window, "unhandledrejection", (e: PromiseRejectionEvent) => {
    const r: unknown = e.reason;
    const stack = r instanceof Error ? (r.stack ?? "") : "";
    if (stack.includes(plugin.manifest.id)) writeLog("error", `unhandled rejection: ${r instanceof Error ? r.message : String(r)}\n${stack}`);
  });

  if (!plugin.data.server.token) {
    plugin.data.server.token = generateToken();
    await plugin.persist();
  }
  const port = () => plugin.data.server.port ?? defaultPortFor(vaultPath);
  const target = (): InstallTarget => ({ serverName: SERVER_NAME, port: port(), token: plugin.data.server.token });

  const servedListeners = new Set<(s: ServedContext) => void>();
  const host = new McpHost({
    port: port(),
    token: plugin.data.server.token,
    version: plugin.manifest.version,
    getTools: () => plugin.registry.getTools(),
    renderContext: () => plugin.engine.renderCurrent(),
    onContextServed: (s) => servedListeners.forEach((fn) => fn(s)),
    log: createLogger("mcp", () => plugin.data.debug),
  });

  const restartServer = async () => {
    host.update({ port: port(), token: plugin.data.server.token });
    const state = await host.start();
    if (state.status === "error") new Notice(`Claude Workspace: ${state.message}. Change the port in settings.`, 10000);
    else if (state.status === "listening") writeLog("info", `server listening on 127.0.0.1:${state.port}`);
  };
  await restartServer();

  const installer = new Installer(app);
  const install = async () => {
    try {
      await installer.install(target(), plugin.registry.getSkills());
      // Details (files written, token) are in the plugin settings; keep the first-run message plain.
      new Notice("Vault connected: Claude now sees the note or drawing you're working in. Restart `claude` if it's open in a terminal.", 8000);
    } catch (e) {
      new Notice(`Claude Workspace: install failed — ${e instanceof Error ? e.message : String(e)}`, 10000);
    }
  };

  // Keep skills in sync once the vault is set up (e.g. a module became available later).
  const syncSkills = debounce(
    () =>
      void installer.status(target()).then(async (ok) => {
        if (!ok) return;
        const written = await installer.writeSkills(plugin.registry.getSkills());
        if (written.length) writeLog("info", `updated skills: ${written.join(", ")}`);
      }),
    500,
    true,
  );
  plugin.register(plugin.registry.onChange((c) => c === "skills" && syncSkills()));
  app.workspace.onLayoutReady(() => syncSkills());

  const resolveClaude = (): string | null => {
    if (plugin.data.claudePath) return plugin.data.claudePath;
    return locateClaude({ platform: process.platform, home: homedir(), env: process.env, isFile });
  };

  const voiceLog = createLogger("voice", () => plugin.data.debug);
  const openSettings = () => {
    const setting = (app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(plugin.manifest.id);
  };
  const voice = createVoice({
    app,
    prefs: () => plugin.data.voice,
    savePrefs: async (p) => {
      plugin.data.voice = { ...plugin.data.voice, ...p };
      await plugin.persist();
    },
    openSettings,
    // Voice info lines (service, timings; never audio or text) also go to debug.log.
    log: {
      ...voiceLog,
      info: (msg, ...meta) => {
        voiceLog.info(msg, ...meta);
        writeLog("info", `[voice] ${msg}`);
      },
    },
  });

  const chatHost: ChatHost = {
    app,
    plugin,
    vaultPath,
    engine: plugin.engine,
    registry: plugin.registry,
    prefs: () => plugin.data.chat,
    savePrefs: async (p) => {
      plugin.data.chat = { ...plugin.data.chat, ...p };
      await plugin.persist();
    },
    resolveClaude,
    spawnEnv: (claudePath) => ({
      ...process.env,
      PATH: enhancedPath({ platform: process.platform, home: homedir(), env: process.env }, claudePath),
    }),
    mcpServers: (): Record<string, McpServerConfig> =>
      host.state.status === "listening"
        ? {
            [SERVER_NAME]: {
              type: "http",
              url: `http://127.0.0.1:${port()}/mcp`,
              headers: { Authorization: `Bearer ${plugin.data.server.token}` },
            },
          }
        : {},
    serverState: () => host.state,
    isInstalled: () => installer.status(target()),
    install,
    onContextServed: (fn) => {
      servedListeners.add(fn);
      return () => servedListeners.delete(fn);
    },
    openSettings,
    log: createLogger("chat", () => plugin.data.debug),
    voice: voice.service,
  };

  plugin.registerView(CHAT_VIEW_TYPE, (leaf) => new ChatView(leaf, chatHost));
  plugin.addRibbonIcon("bot", "Open Claude chat", () => void openChat(plugin, false));
  // Status bar button: easier to find than the ribbon icon.
  const status = plugin.addStatusBarItem();
  status.addClass("mod-clickable", "cw-statusbar");
  status.setText("✳ Claude");
  status.setAttr("aria-label", "Open Claude chat");
  status.onClickEvent(() => void openChat(plugin, false));
  // First run: open the chat panel once so it's obvious where it lives.
  app.workspace.onLayoutReady(() => {
    if (plugin.data.chatShownOnce || app.workspace.getLeavesOfType(CHAT_VIEW_TYPE).length) return;
    plugin.data.chatShownOnce = true;
    void plugin.persist().then(() => openChat(plugin, false));
  });
  plugin.addCommand({ id: "open-chat", name: "Open chat", callback: () => void openChat(plugin, false) });
  plugin.addCommand({ id: "new-chat-tab", name: "New chat in a tab", callback: () => void openChat(plugin, true) });
  plugin.addCommand({
    id: "toggle-voice",
    name: "Start or stop voice input",
    // Only offered once voice input is turned on in settings.
    checkCallback: (checking) => {
      if (!voice.service.isEnabled()) return false;
      if (!checking) {
        void openChat(plugin, false).then(() => {
          const view = app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0]?.view;
          if (view instanceof ChatView) view.toggleVoice();
        });
      }
      return true;
    },
  });
  plugin.addCommand({ id: "install-claude-config", name: "Install Claude Code config in this vault", callback: () => void install() });
  plugin.addCommand({
    id: "copy-mcp-add-command",
    name: "Copy `claude mcp add` command (register for all projects)",
    callback: () => void navigator.clipboard.writeText(mcpAddCommand(target())).then(() => new Notice("Copied")),
  });

  plugin.coreSettingsSections.push((el, refresh) =>
    renderConnectionSettings(
      el,
      {
        claudePathOverride: plugin.data.claudePath,
        setClaudePathOverride: async (v) => {
          plugin.data.claudePath = v;
          await plugin.persist();
        },
        detectedClaude: locateClaude({ platform: process.platform, home: homedir(), env: process.env, isFile }),
        serverState: host.state,
        port: plugin.data.server.port,
        defaultPort: defaultPortFor(vaultPath),
        setPort: async (n) => {
          plugin.data.server.port = n;
          await plugin.persist();
        },
        restartServer,
        installStatus: () => installer.status(target()),
        install,
        copyMcpAddCommand: async () => {
          await navigator.clipboard.writeText(mcpAddCommand(target()));
          new Notice("Copied");
        },
        regenerateToken: async () => {
          plugin.data.server.token = generateToken();
          await plugin.persist();
          await restartServer();
          new Notice("New token saved. Install again so Claude Code uses it.");
        },
      },
      refresh,
    ),
  );

  plugin.coreSettingsSections.push((el, refresh) => voice.renderSettings(el, refresh));

  writeLog("info", `claude executable: ${resolveClaude() ?? "NOT FOUND"}`);

  return {
    host,
    dispose: async () => {
      setLogSink(null);
      unpatchEvents();
      await host.stop();
    },
  };
}

async function openChat(plugin: ClaudeWorkspacePlugin, newTab: boolean): Promise<void> {
  const ws = plugin.app.workspace;
  const existing = ws.getLeavesOfType(CHAT_VIEW_TYPE)[0];
  if (existing && !newTab) {
    await ws.revealLeaf(existing);
    return;
  }
  const leaf = newTab ? ws.getLeaf("tab") : (ws.getRightLeaf(false) ?? ws.getLeaf("tab"));
  await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
  await ws.revealLeaf(leaf);
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}
