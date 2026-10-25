/**
 * Renders the real chat view and settings tab in a browser, in fixed scenarios,
 * for screenshots (see shoot.mjs). Not shipped in the plugin.
 */
import { ChatView, type ChatHost } from "../../src/desktop/chat/ChatView";
import { connectionSettings } from "../../src/desktop/connection-settings";
import { InstructionsSettings } from "../../src/desktop/instructions-settings";
import { markInstalled } from "../../src/desktop/skills";
import { voiceSettings } from "../../src/desktop/voice/voice-settings";
import type { VoiceService } from "../../src/desktop/voice/service";
import { ModuleRegistry } from "../../src/core/ModuleRegistry";
import { loadedPlugin } from "../../src/core/plugins";
import { CliBridge } from "../../src/modules/cli";
import { WorkspaceSettingTab, mergeData } from "../../src/core/settings";
import { builtinModules } from "../../src/modules";
import type { ActiveContext } from "../../src/core/module-api";
import { TFile } from "./obsidian-browser";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */

const VAULT = "C:\\Users\\abdal\\Documents\\cw-test-vault";
const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "chat-empty";
document.body.classList.add(params.get("theme") === "dark" ? "theme-dark" : "theme-light");

const files = ["Welcome.md", "Projects/Alpha.md", "Projects/Beta.md", "Drawings/Architecture.excalidraw.md", "Daily/2026-10-11.md"].map(
  (p) => new TFile(p),
);
// Instructions for the settings: the vault's CLAUDE.md and one folder's.
if (scenario.startsWith("settings")) files.push(new TFile("CLAUDE.md"), new TFile("Projects/CLAUDE.md"));

/** `.claude/skills`, read through the vault adapter: one skill of the user's, the two the modules install. */
const hidden = new Map<string, string>([
  [
    ".claude/skills/weekly-review/SKILL.md",
    '---\nname: weekly-review\ndescription: "Review the week: what changed in each project and what comes next. Use when the user asks for a weekly review."\n---\n\n1. List the notes changed this week.\n',
  ],
]);
const adapter = {
  exists: async (p: string) => hidden.has(p) || [...hidden.keys()].some((k) => k.startsWith(`${p}/`)),
  read: async (p: string) => hidden.get(p) ?? "",
  list: async (p: string) => ({
    files: [],
    folders: [...new Set([...hidden.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => `${p}/${k.slice(p.length + 1).split("/")[0]}`))],
  }),
};
const app: any = {
  workspace: {
    getLastOpenFiles: () => ["Projects/Alpha.md", "Welcome.md"],
    requestSaveLayout() {},
    revealLeaf: async () => undefined,
    openLinkText: async () => undefined,
    getLeaf: () => ({ openFile: async () => undefined }),
    detachLeavesOfType() {},
    getLeavesOfType: () => [],
    on: () => ({}),
  },
  vault: {
    getFiles: () => files,
    getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
    getFileByPath: (p: string) => files.find((f) => f.path === p) ?? null,
    adapter,
  },
  plugins: { plugins: { "obsidian-excalidraw-plugin": { manifest: { name: "Excalidraw", version: "2.29.0" } } } },
  cli: { handlers: cliHandlers() },
  commands: { commands: { "daily-notes:goto-today": { id: "daily-notes:goto-today", name: "Open today's daily note" } }, executeCommandById: () => true },
};
const plugin: any = { app, addCommand() {}, removeCommand() {}, registerView() {}, manifest: { id: "claude-workspace", version: "0.0.1" } };

const ctx: ActiveContext = {
  activeFile: { path: "Projects/Alpha.md", viewType: "markdown" },
  mode: "source",
  providers: { "markdown.editor": { cursor: { line: 12, ch: 0 }, section: ["Alpha", "Notes"], selection: { fromLine: 11, toLine: 12, text: "Select this paragraph…", truncated: false } } },
  openTabs: [{ path: "Projects/Alpha.md", viewType: "markdown" }, { path: "Welcome.md", viewType: "markdown" }],
};
const CONTEXT_TEXT = [
  "<obsidian_context>",
  "The user is currently looking at: Projects/Alpha.md (view: markdown, mode: source).",
  '"This file", "this note", "this drawing", "here" refer to it.',
  "Cursor at line 12 (section: Alpha › Notes).",
  '<selected_text lines="11-12">',
  "Select this paragraph and ask Claude \"what did I select?\"",
  "</selected_text>",
  "Other open tabs: Welcome.md",
  "</obsidian_context>",
].join("\n");

/** A few of Obsidian's own CLI commands and Excalidraw 2.29's, as `registerCliHandler` stores them. */
function cliHandlers(): Map<string, unknown> {
  const handler = () => "";
  const ex = (cmd: string, desc: string) => [`obsidian-excalidraw-plugin:${cmd}`, { handler, description: `[Excalidraw]: ${desc}`, flags: null }];
  return new Map<string, unknown>([
    ["search", { handler, description: "Search vault for text", flags: { query: { value: "<text>", description: "Search query", required: true } } }],
    ["daily:read", { handler, description: "Read daily note contents", flags: null }],
    ["restart", { handler, description: "Restart the app", flags: null }],
    ["eval", { handler, description: "Execute JavaScript and return result", flags: null }],
    ...["api", "apply", "create", "export", "help", "list", "open", "read", "result", "schema", "script", "skill", "status"].map((c) =>
      ex(c, `Native Excalidraw CLI — ${c}`),
    ),
  ] as [string, unknown][]);
}

const data = mergeData({ modules: { "obsidian-excalidraw-plugin": { data: { commands: { "obsidian-excalidraw-plugin:script": false } } } } });
const registry = new ModuleRegistry({
  app,
  plugin,
  platform: "desktop",
  isDebug: () => false,
  isModuleEnabled: (id) => data.modules[id]?.enabled,
  setModuleEnabled: async (id, enabled) => {
    data.modules[id] = { ...data.modules[id], enabled };
  },
  loadModuleData: (id) => data.modules[id]?.data,
  saveModuleData: async () => undefined,
  getActiveContext: async () => ctx,
  getActiveView: () => null,
  notifyContextChanged: () => undefined,
  getPlugin: (id) => loadedPlugin(app, id),
});
for (const m of builtinModules) registry.add(m);
new CliBridge(app, registry).sync();
const instructions = new InstructionsSettings({
  app,
  moduleSkills: () => {
    const markdown = new Map(registry.getSkills().map((sk) => [sk.name, sk.markdown]));
    return registry.list().flatMap((m) => registry.contentsOf(m.id).skills.map((name) => ({ name, module: m.name, markdown: markdown.get(name) ?? "" })));
  },
  closeSettings: () => undefined,
});

async function main(): Promise<void> {
  await registry.start();
  // What the installer writes for the loaded modules.
  for (const sk of registry.getSkills()) hidden.set(`.claude/skills/${sk.name}/SKILL.md`, markInstalled(sk.markdown));
  if (scenario.startsWith("settings")) await renderSettings();
  else await renderChat();
  (window as any).__ready = true;
}

// ───────────────────────── settings ─────────────────────────

async function renderSettings(): Promise<void> {
  // settings: everything set up. settings-first-run: Claude Code not found, server down, vault not connected, voice off.
  // settings-cli-page: the "Excalidraw CLI commands" page. settings-skills-page: the "Skills" page.
  const firstRun = scenario === "settings-first-run";
  const frame = document.body.createDiv({ cls: "modal mod-settings cw-preview-settings" });
  const content = frame.createDiv({ cls: "vertical-tab-content-container" });
  const voice = { ...data.voice, enabled: !firstRun, secret: firstRun ? "" : "groq" };
  const fakePlugin: any = {
    ...plugin,
    registry,
    data,
    persist: async () => undefined,
    register() {},
    coreSettingsSections: [
      (refresh: () => void) =>
        connectionSettings(
          {
            claudePath: () => "",
            setClaudePath: async () => undefined,
            detectClaude: () => (firstRun ? null : "C:\\Users\\abdal\\.local\\bin\\claude.exe"),
            serverState: () => (firstRun ? { status: "error", message: "Port 27557 is already in use" } : { status: "listening", port: 27557 }),
            port: () => null,
            defaultPort: 27557,
            setPort: async () => undefined,
            restartServer: async () => undefined,
            installStatus: async () => !firstRun && params.get("installed") !== "0",
            install: async () => undefined,
            copyMcpAddCommand: async () => undefined,
            regenerateToken: async () => undefined,
          },
          refresh,
        ),
      (refresh: () => void) => instructions.block(refresh),
      () =>
        voiceSettings({
          prefs: () => voice,
          setPrefs: async (p) => void Object.assign(voice, p),
          check: async () => "api.groq.com answered in 0.4 s.",
        }),
    ],
  };
  const tab = new WorkspaceSettingTab(app, fakePlugin);
  content.appendChild(tab.containerEl);
  tab.update(); // what addSettingTab does; it draws too, since the tab is in the page
  await tick();
  const pageName = { "settings-cli-page": "Excalidraw CLI commands", "settings-skills-page": "Skills" }[scenario];
  if (pageName) {
    // Obsidian opens a page by drawing its items in place of the tab's.
    const page = tab.settingItems.flatMap((g) => ("items" in g ? (g.items ?? []) : [])).find((r) => "type" in r && r.type === "page" && r.name === pageName);
    tab.settingItems = page && "items" in page ? (page.items ?? []) : [];
    tab.display();
    return;
  }
  // Show the contents of the Excalidraw module card.
  if (!firstRun) tab.containerEl.querySelectorAll<HTMLDetailsElement>(".cw-module-contents")[3]?.setAttribute("open", "");
}

// ───────────────────────── chat ─────────────────────────

async function renderChat(): Promise<void> {
  const prefs = { model: "", permissionMode: (params.get("mode") ?? "default") as "default", effort: (params.get("effort") ?? "") as "" };
  const host: ChatHost = {
    app,
    plugin,
    vaultPath: VAULT,
    engine: {
      onChange: () => () => undefined,
      collect: async () => ctx,
      renderCurrent: async () => ({ ctx, text: CONTEXT_TEXT }),
    } as any,
    registry,
    prefs: () => prefs,
    savePrefs: async (p) => void Object.assign(prefs, p),
    resolveClaude: () => (scenario === "chat-banner" ? null : "C:\\Users\\abdal\\.local\\bin\\claude.exe"),
    spawnEnv: () => ({}),
    mcpServers: () => ({}),
    serverState: () => ({ status: "listening", port: 27557 }),
    isInstalled: async () => scenario !== "chat-banner",
    install: async () => undefined,
    onContextServed: () => () => undefined,
    openSettings() {},
    log: { debug() {}, info() {}, warn() {}, error: console.error },
    voice: fakeVoice(),
  };

  const shell = document.body.createDiv({ cls: "workspace" });
  const split = shell.createDiv({ cls: "workspace-split mod-horizontal mod-sidedock mod-right-split" });
  const tabs = split.createDiv({ cls: "workspace-tabs mod-top mod-top-right-space" });
  const container = tabs.createDiv({ cls: "workspace-tab-container" });
  const leafEl = container.createDiv({ cls: "workspace-leaf mod-active" });
  const view = new ChatView({ app } as any, host) as any;
  leafEl.appendChild(view.containerEl);
  view.containerEl.dataset.type = "claude-workspace-chat";
  const status = document.body.createDiv({ cls: "status-bar" });
  for (const t of ["0 backlinks", "35 words  246 characters", "✳ Claude"]) status.createDiv({ cls: "status-bar-item", text: t });

  await view.onOpen();
  await tick();

  const t = view.transcript;
  const say = (m: any) => view.onMessage(m);
  const assistant = (id: string, content: any[]) => say({ type: "assistant", message: { id, content, usage: { input_tokens: 61000, output_tokens: 1200 } }, parent_tool_use_id: null });
  const result = (id: string, text: string, isError = false) =>
    say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] }, parent_tool_use_id: null });

  const conversation = async () => {
    view.showTranscript();
    t.addUser("Summarize this note and fix the typo in the goals").setContext(["Alpha.md", "L11–12 selected"], CONTEXT_TEXT);
    assistant("m1", [
      { type: "thinking", thinking: "The user is in Projects/Alpha.md with lines 11–12 selected. I'll read the note first." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: `${VAULT}\\Projects\\Alpha.md` } },
    ]);
    result("t1", "1\t---\n2\tstatus: active\n3\t---\n4\t# Alpha\n…");
    assistant("m2", [
      { type: "text", text: "**Alpha** tracks the plugin skeleton. Two goals:\n\n1. Ship the skeleton.\n2. Make context follow the cursor.\n\nThere's a typo in goal 2, fixing it in `Projects/Alpha.md`:" },
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: `${VAULT}\\Projects\\Alpha.md`, old_string: "2. Make contxt follow the cursor.", new_string: "2. Make context follow the cursor." } },
    ]);
    result("t2", "The file has been updated.");
    t.addUser("/compact", { expectContext: false });
    t.addNote("Conversation compacted", "divider");
    t.addUser("Now draw the architecture in my drawing").setContext(["Architecture.excalidraw.md", "2 elements selected"], CONTEXT_TEXT);
    assistant("m3", [
      { type: "tool_use", id: "t3", name: "mcp__obsidian__excalidraw_get_scene", input: {} },
    ]);
    result("t3", '{"elementCount": 2}');
    assistant("m4", [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "git log --oneline -5", description: "Show recent commits" } }]);
    view.contextWindow = 200000;
    view.trackUsage({ input_tokens: 61000, output_tokens: 7000 });
    view.costUsd = 0.42;
    view.updateUsage();
    view.setBusy(true);
  };

  const abort = new AbortController().signal;
  switch (scenario) {
    case "chat-conversation":
      await conversation();
      break;
    case "chat-permission-edit":
      view.showTranscript();
      t.addUser("Fix the typo in goal 2").setContext(["Alpha.md"], CONTEXT_TEXT);
      view.setBusy(true);
      void view.dock.askPermission({
        toolName: "Edit",
        input: { file_path: `${VAULT}\\Projects\\Alpha.md`, old_string: "## Goals\n1. Ship the skeleton.\n2. Make contxt follow the cursor.", new_string: "## Goals\n1. Ship the skeleton.\n2. Make context follow the cursor." },
        suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        signal: abort,
      });
      break;
    case "chat-permission-bash":
      view.showTranscript();
      t.addUser("Run the tests").setContext(["Alpha.md"], CONTEXT_TEXT);
      view.setBusy(true);
      void view.dock.askPermission({
        toolName: "Bash",
        input: { command: "npm test -- --reporter=verbose", description: "Run the unit tests" },
        suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }],
        decisionReason: "Commands that run code always ask in this mode.",
        signal: abort,
      });
      void view.dock.askPermission({ toolName: "Bash", input: { command: "ls" }, signal: abort });
      break;
    case "chat-permission-mcp":
      view.showTranscript();
      t.addUser("Add a database box connected to the API").setContext(["Architecture.excalidraw.md"], CONTEXT_TEXT);
      view.setBusy(true);
      void view.dock.askPermission({
        toolName: "mcp__obsidian__excalidraw_apply",
        input: { ops: [{ op: "add_shape", ref: "db", shape: "ellipse", x: 440, y: 0, text: "Database" }, { op: "connect", from: "api", to: "db", text: "SQL" }] },
        suggestions: [{ type: "addRules", rules: [{ toolName: "mcp__obsidian__excalidraw_apply" }], behavior: "allow", destination: "localSettings" }],
        signal: abort,
      });
      break;
    case "chat-plan":
      view.showTranscript();
      t.addUser("Reorganize my Projects folder").setContext(["Alpha.md"], CONTEXT_TEXT);
      view.setBusy(true);
      void view.dock.askPermission({
        toolName: "ExitPlanMode",
        input: { plan: "## Plan\n\n1. Create `Projects/Archive/` for finished projects.\n2. Move **Beta** there (status: done).\n3. Add a `Projects/Index.md` linking every active project.\n\nNothing else changes." },
        signal: abort,
      });
      break;
    case "chat-question":
      view.showTranscript();
      t.addUser("Set up a weekly review note").setContext(["Welcome.md"], CONTEXT_TEXT);
      view.setBusy(true);
      void view.dock.askQuestions(
        {
          questions: [
            { header: "Day", question: "Which day should the weekly review be on?", multiSelect: false, options: [{ label: "Friday", description: "End of the work week" }, { label: "Sunday", description: "Before the new week starts" }] },
            { header: "Sections", question: "What should it include?", multiSelect: true, options: [{ label: "Wins", description: "" }, { label: "Open tasks", description: "From the Tasks plugin" }, { label: "Next week", description: "" }] },
          ],
        },
        abort,
      );
      break;
    case "chat-slash":
      view.input.focus();
      view.input.value = "/co";
      view.input.setSelectionRange(3, 3);
      await tick(50);
      view.onInput();
      break;
    case "chat-effort-args":
    case "chat-advisor-args": {
      const text = scenario === "chat-effort-args" ? "/effort " : "/advisor ";
      view.input.focus();
      await tick(50);
      view.input.value = text;
      view.input.setSelectionRange(text.length, text.length);
      view.onInput();
      break;
    }
    case "chat-mention":
      view.input.value = "Compare this with @al";
      view.input.focus();
      view.input.setSelectionRange(21, 21);
      view.onInput();
      break;
    case "chat-mode-menu":
      await conversation();
      view.setBusy(false);
      view.modeBtn.click();
      break;
    case "chat-paste": {
      view.showTranscript();
      const log = Array.from({ length: 40 }, (_, i) => `2026-10-12 10:${String(i).padStart(2, "0")} ERROR sync failed: ETIMEDOUT (attempt ${i + 1})`).join("\n");
      t.addUser("Explain this log [Pasted text #1 +40 lines] and tell me what to fix", { pastes: new Map([[1, log]]) }).setContext(["Alpha.md"], CONTEXT_TEXT);
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      const g = canvas.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 320, 200);
      grad.addColorStop(0, "#7c3aed");
      grad.addColorStop(1, "#38bdf8");
      g.fillStyle = grad;
      g.fillRect(0, 0, 320, 200);
      const png = canvas.toDataURL("image/png").split(",")[1]!;
      t.addUser("What's wrong in this screenshot? Compare with the report.", { images: [{ mediaType: "image/png", data: png }, { mediaType: "image/png", data: png }], documents: ["Q3 report.pdf"] }).setContext(["Alpha.md"], CONTEXT_TEXT);
      t.addUser(Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of a long message typed or resumed from history.`).join("\n"), { expectContext: false });
      (view.contentEl.querySelector(".cw-paste-chip") as HTMLElement | null)?.click();
      view.input.focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", log);
      view.input.value = "Compare with ";
      view.input.setSelectionRange(13, 13);
      view.input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      view.attachments.push({ kind: "pdf", name: "Quarterly report 2026.pdf", data: "", size: 2_400_000 }, { kind: "image", mediaType: "image/png", name: "shot.png", data: png });
      view.renderAttachments();
      break;
    }
    case "chat-defaults":
      view.warm();
      await tick(100);
      view.effortBtn.click();
      break;
    case "chat-effort-menu":
      view.warm();
      await tick(50);
      await view.changeEffort("high");
      view.effortBtn.click();
      break;
    case "chat-voice":
      view.input.value = "Summarize the three open tasks and";
      view.mic.el.click();
      await tick(400);
      break;
    case "chat-context-preview":
      view.contextRowEl.querySelector("button")?.click();
      break;
    default:
      break;
  }
  await tick(100);
}

/** Voice input that "records" a steady level, for the mic button's states. */
function fakeVoice(): VoiceService {
  return {
    isEnabled: () => scenario === "chat-voice",
    isLive: () => true,
    onChange: () => () => undefined,
    ready: () => true,
    record: async () => ({ level: () => 0.7, stop: async () => new Float32Array(16000), cancel() {} }),
    transcribe: async () => "add a reminder to call the dentist on Friday",
    describe: () => "api.groq.com · whisper-large-v3-turbo, last 0.4 s",
  };
}

function tick(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void main();
