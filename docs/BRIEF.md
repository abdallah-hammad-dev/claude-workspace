# Project brief — Claude Code workspace for Obsidian

> Paste this into Claude Code at the root of an empty repo (or save it as `docs/BRIEF.md` and tell Claude Code to read it). It is the founding spec: read it fully before writing code, then work milestone by milestone.

---

## 1. Who I am and what I want

I'm Abdallah, a 5th‑year EPITECH student (strong C/C++, Go, TypeScript/Svelte, Linux/KDE). I want **Obsidian to be my personal operating system, with Claude Code as the brain**. Claude must see what I'm working on — exactly like the Claude Code VS Code extension — and act on it: notes, Excalidraw drawings, and later my calendar, tasks and email invites.

I'm building this as **one Obsidian plugin with a module system**. The first release is the core (chat + live context + local MCP server) and the Excalidraw module. Calendar, tasks and mail-invites modules come later and must slot in without touching the core.

Inspiration: [Claudian](https://github.com/YishenTu/claudian) (MIT). It embeds Claude Code in Obsidian well, but it makes UI-level decisions I don't want (e.g. the linked note is frozen after the first message, context is built by the UI). Read its source for patterns (SDK spawning, Windows CLI detection, rendering, permission prompts) — **don't copy it wholesale**; if you reuse code, keep the MIT notice.

---

## 2. Principles (non‑negotiable)

1. **Claude Code is the engine, the plugin is a thin host.** Everything that can live in the Claude Code layer does: MCP servers, hooks, skills, `CLAUDE.md`, settings. The plugin never re-implements agent logic.
2. **Same setup in the chat view and in the terminal.** Whatever I configure must work identically if I run `claude` in a terminal inside the vault (locally or over SSH). So tools are exposed over a **local HTTP MCP server**, and context is injected by a **hook**, not by hidden prompt-building in the UI.
3. **Context follows me, VS Code style.** Every message carries what I'm looking at *now*: active file, view type, cursor, selection, selected Excalidraw elements, open tabs. Nothing is frozen per conversation.
4. **No hidden prompt manipulation.** What I type is what's sent (plus the context block, which is visible in the UI as chips). System prompt = Claude Code preset + a short, documented `append`.
5. **Standards over custom formats.** Calendar = CalDAV/iCalendar, tasks = `VTODO` and Obsidian markdown, links = `obsidian://` / Advanced URI. Other apps (Apple Calendar, KOrganizer, Thunderbird) must keep working on the same data.
6. **Modules are plugins-within-the-plugin.** A module registers tools, context providers, views, commands, settings and skills through one API. Core knows nothing about calendars or drawings.
7. **Local-first and secure.** Servers listen on `127.0.0.1` only, bearer token, reject browser `Origin`, never log tokens or note contents.

---

## 3. Architecture

```
┌──────────────────────────── Obsidian (desktop) ────────────────────────────┐
│  Plugin "claude-workspace"                                                 │
│                                                                            │
│  core/                                                                     │
│   ├─ ContextEngine ── tracks last file leaf, asks ContextProviders         │
│   ├─ McpHost ──────── HTTP MCP server 127.0.0.1:<port>/mcp (token)         │
│   │                   + GET /context (text block for the hook)            │
│   ├─ ChatView ─────── thin UI over @anthropic-ai/claude-agent-sdk          │
│   ├─ ModuleRegistry ─ load/enable modules, collect tools/providers/views   │
│   └─ Installer ────── writes .mcp.json, .claude/settings.json hook,        │
│                       .claude/skills/<module>/… into the vault             │
│                                                                            │
│  modules/                                                                  │
│   ├─ markdown/    (context provider: cursor, selection, headings)          │
│   ├─ excalidraw/  (context provider + live canvas tools)    ← v1           │
│   ├─ tasks/       (later)                                                  │
│   ├─ calendar/    (later, CalDAV)                                          │
│   └─ invites/     (later, talks to a Go service on my VPS)                 │
└────────────────────────────────────────────────────────────────────────────┘
          ▲  MCP (HTTP) + hook (GET /context)
          │
   Claude Code — via the Agent SDK (chat view) or the `claude` CLI (terminal)
```

### 3.1 Module API (design this first, keep it small)

```ts
interface WorkspaceModule {
  id: string;                         // "excalidraw"
  name: string;
  isAvailable?(app: App): boolean;    // e.g. Excalidraw plugin installed
  onload(ctx: ModuleContext): void | Promise<void>;
  onunload?(): void;
}

interface ModuleContext {
  app: App;
  plugin: Plugin;
  registerTool(def: ToolDef): void;                 // zod input schema + handler
  registerContextProvider(p: ContextProvider): void;
  registerView(type: string, factory: ViewCreator): void;
  registerCommand(cmd: Command): void;
  registerSettings(section: SettingsSection): void;
  registerSkill(skill: { name: string; markdown: string }): void; // installed to .claude/skills
  getActiveContext(): ActiveContext;
  log: Logger;
}

interface ContextProvider {
  viewTypes: string[];                               // ["markdown"], ["excalidraw"], ["*"]
  collect(view: View): Promise<Record<string, unknown> | null>; // structured
  render?(data: Record<string, unknown>): string;    // lines for the context block
}
```

- Tools are namespaced by module: `excalidraw_get_scene`, `calendar_list_events`…
- External plugins may also register modules: expose `plugin.api.registerModule(mod)`.
- Disabled/unavailable modules register nothing (tools disappear from `tools/list`).

### 3.2 ContextEngine

- Track the **last leaf that holds a file** (`active-leaf-change`), ignoring side panels — clicking into the chat view must not reset it.
- Build `ActiveContext = { activeFile, viewType, mode, providersData, openTabs }`.
- Render a compact block:
  ```
  <obsidian_context>
  The user is currently looking at: Projects/Olera.md (view: markdown, mode: source).
  "This file", "this note", "this drawing", "here" refer to it.
  Cursor at line 42.
  Selected text (lines 40-45): …
  Other open tabs: …
  </obsidian_context>
  ```
- Cap selections (~6k chars) and never include full file contents — Claude reads files itself.
- Expose: `GET /context` (text, for the CLI hook), `get_active_context` MCP tool (structured), and an event the ChatView subscribes to for its chips.

### 3.3 Context injection — one source of truth

- **CLI:** a `UserPromptSubmit` hook in `<vault>/.claude/settings.json` runs `curl -s -m 2 -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/context`.
- **ChatView:** use the SDK's in-process hook mechanism if available (check the `hooks` option in the SDK docs) to call `ContextEngine.render()` directly; otherwise rely on the same settings hook via `settingSources`. **Make sure context is injected exactly once per turn** (test it).
- The chips in the ChatView display the same data, so UI and model never disagree.

### 3.4 McpHost

- Use the official `@modelcontextprotocol/sdk` server with Streamable HTTP (don't hand-roll JSON-RPC; my prototype did, see §7).
- Bind `127.0.0.1`, require `Authorization: Bearer <token>`, reject requests with an `Origin` header or unexpected `Host`.
- Token generated on first run, stored in plugin data, regenerable in settings.
- The ChatView passes this server in `mcpServers` so chat and CLI see identical tools.
- Tool errors return `isError: true` with a human-readable message that tells Claude how to recover.

### 3.5 ChatView (thin UI over the Agent SDK)

Package: `@anthropic-ai/claude-agent-sdk`, `query({ prompt, options })`. Relevant options (verify against the current docs — https://code.claude.com/docs/en/agent-sdk/typescript):

- `cwd`: vault path
- `settingSources: ["user", "project", "local"]` so my CLAUDE.md, skills, hooks and MCP config load exactly as in the CLI
- `systemPrompt: { type: "preset", preset: "claude_code", append: "<short note: you run inside Obsidian; use obsidian_* / module tools for live views>" }`
- `mcpServers`: the McpHost entry
- `includePartialMessages: true` for streaming
- `canUseTool`: permission requests → Obsidian modal (allow once / always / deny)
- `permissionMode`: picker in the UI
- `resume`: session id — sessions are **Claude Code's own sessions**, so I can resume a chat from the CLI and vice versa
- `abortController` / `interrupt()` for the stop button (interrupt needs streaming input mode)
- `pathToClaudeCodeExecutable`: settings override, with auto-detection like Claudian (Windows: avoid `.cmd`/`.ps1` wrappers)

UI features:
- Streaming markdown via `MarkdownRenderer`, clickable `[[links]]` and file paths.
- Tool calls as collapsible blocks; `Edit`/`Write` shown as a diff with "open file".
- Context chips (active file, selection, Excalidraw selection) — display only, from ContextEngine.
- `@` file picker (inserts a path mention, nothing magic), image paste/drop.
- Slash commands passed through to Claude Code untouched.
- Tabs/sessions list, model picker, token/context usage indicator.
- Built with **Svelte** (I know it) or vanilla TS; no heavy framework.

### 3.6 Installer

Command + settings button that **merges** (never clobbers):
- `<vault>/.mcp.json` → our server entry (http, url, header)
- `<vault>/.claude/settings.json` → `enabledMcpjsonServers` + the `UserPromptSubmit` hook (dedupe previous versions)
- `<vault>/.claude/skills/<module>/SKILL.md` from each module's `registerSkill`
- Also offer "copy `claude mcp add --scope user …`" for registering globally.
- Warn that `.mcp.json` / `.claude/settings.json` contain the token → suggest gitignore.

---

## 4. Module v1 — Excalidraw (live canvas)

Goal: Claude sees and edits the **open drawing live** through the Excalidraw plugin's API (ExcalidrawAutomate), never by editing the `.excalidraw.md` file — so compression doesn't matter and edits appear instantly.

Context provider (`viewTypes: ["excalidraw"]`): element count, selected element ids + compact summaries, and a hint to use the tools below instead of editing the file.

Tools:
| Tool | Purpose |
|---|---|
| `excalidraw_get_scene` | Live elements (incl. unsaved): id, type, x/y/w/h, label text (merge bound text into its container), colors, arrow `from`/`to` bindings, groups, frame, link; selection; `selectedOnly` flag |
| `excalidraw_apply` | Ordered ops: `add_shape` (rectangle/ellipse/diamond, text label, colors, link, `ref`), `add_text`, `connect` (from/to = id or `ref`, label, arrowheads), `update` (geometry, style, text — re-center bound labels), `delete` (with bound text + attached arrows). Returns `ref → id` map |
| `excalidraw_screenshot` | PNG of the live canvas (MCP image content) so Claude can verify its layout |
| `excalidraw_focus` | Select / zoom to given elements so I see what Claude means |
| `obsidian_open_file` (core) | Open a drawing if it isn't open yet |

Implementation notes:
- `window.ExcalidrawAutomate.getAPI(view)` → `ea.setView(view)`; read with `getViewElements()` / `getViewSelectedElements()`; edit with `copyViewElementsToEAforEditing()` + `addRect/addEllipse/addDiamond/addText/connectObjects` + `addElementsToView()`; delete via `getExcalidrawAPI().updateScene()` with `isDeleted: true` and bumped `version`/`versionNonce`.
- Check how the Excalidraw plugin exposes undo; ideally each `excalidraw_apply` is one undo step. If not possible, document it.
- Validate the whole op list before applying anything (unknown ids/ops → error, no partial writes).
- Ship a skill `excalidraw/SKILL.md`: always `get_scene` first, use refs to chain shapes and arrows, keep a grid layout, screenshot after non-trivial edits, never edit the file while it's open.
- Prototype already exists (see §7) — port its op semantics, but rebuild on the real MCP SDK with tests.

---

## 5. Roadmap (design the core so these drop in)

**tasks module** — Obsidian Tasks-style markdown is the authoring surface; tasks with dates sync to CalDAV as `VTODO` (`DUE` = deadline). Tools: list/create/complete tasks, link task ↔ note (`uid` in frontmatter, Advanced URI links).

**calendar module** — my own calendar view inside Obsidian (desktop + mobile).
- Source of truth: my **CalDAV server on my VPS** (Radicale or Davis). Obsidian is a client, so Apple Calendar/Reminders and KOrganizer show the same data.
- Libraries: `ical.js` (parse/serialize, RRULE expansion), CalDAV via `tsdav` or raw `PROPFIND`/`REPORT`/`PUT`/`DELETE` — **all HTTP through Obsidian's `requestUrl`** (CORS on mobile).
- Three display types: **event** (`VEVENT`, block), **deadline** (`VTODO` with `DUE`, thin line + checkbox), **span** (multi-day all-day `VEVENT`, subtle banner).
- **Time blocking:** work sessions are `VEVENT`s with `RELATED-TO:<task UID>`; hovering a deadline highlights its sessions; warn when a deadline has no time blocked.
- Event `URL` → `obsidian://adv-uri?uid=…` so tapping in Apple Calendar opens the note.
- Tools: list/create/update/delete events, schedule a task ("tomorrow 2pm"), find free slots.

**invites module + Go service on the VPS** — watches several mailboxes (IMAP IDLE) for `text/calendar` parts (iMIP `REQUEST`/`CANCEL`), logs every scanned invite (account, sender, subject, Message-ID, UID) in SQLite, routes per account to a CalDAV collection, dedupes by UID, stores `X-SOURCE-ACCOUNT`/`X-SOURCE-MESSAGE-ID` + a link to the email. Replies (`METHOD:REPLY`) are sent **from the invited account's SMTP**; the service also watches CalDAV for PARTSTAT changes so accepting in Apple Calendar sends the reply too. Obsidian module = dashboard (accounts, scanned invites, open email, accept/decline). References: calbridge, calmailproc (Go).

Each later module = its own milestone, its own skill, its own tests. The core should need no changes; if it does, the Module API was wrong — fix the API, not the module.

---

## 6. Milestones (do them in order; stop and show me at each)

- **M0 — Skeleton.** Obsidian sample-plugin layout, TypeScript strict, esbuild, ESLint, Vitest with an `obsidian` stub, test vault in `test-vault/`, `CLAUDE.md` for this repo, README. Module registry with a dummy module.
- **M1 — ContextEngine + McpHost.** `/context`, `get_active_context`, `obsidian_open_file`, token auth, Installer. Verify with the real `claude` CLI in the test vault: switch files between prompts → context follows.
- **M2 — Excalidraw module.** Tools + context provider + skill. Test against the real Excalidraw plugin in the test vault (and unit tests with a fake EA).
- **M3 — ChatView MVP.** Streaming, markdown, tool blocks, permissions, stop, resume, context chips. Context injected exactly once.
- **M4 — ChatView polish.** Diffs, `@` picker, images, tabs/sessions, model & permission pickers, usage indicator, Windows path detection.
- **M5 — Hardening.** Error surfaces, reconnects, port conflicts, settings UI, docs, release build.
- Then: tasks → calendar → invites.

---

## 7. Existing prototype

`reference/claude-bridge/main.js` (I'll put it there) is a working single-file prototype: active-leaf tracking, `/context` endpoint, a hand-rolled JSON-RPC MCP server, and Excalidraw tools (`get_scene`, `apply` with add_shape/add_text/connect/update/delete, `screenshot`), plus an installer. It was only tested against stubs. Use it as the behavioral reference for M1–M2, not as the code base.

---

## 8. Environment & constraints

- I use **Windows and Fedora KDE** on separate machines; Claude Code is installed natively on Linux and in **WSL** on Windows. Support: native Windows CLI path, Linux, macOS (I may switch to a Mac). If Obsidian runs on Windows and Claude Code only in WSL, document the limitation (127.0.0.1 differences, mirrored networking) and prefer installing Claude Code natively on Windows.
- Desktop only for the ChatView (spawns processes). The calendar view must also work on **Obsidian mobile** (iPhone): no Node APIs there, `requestUrl` only.
- My vault will later be synced to my VPS; secrets must never live in synced notes.

---

## 9. How I want you to work

- Read: this brief, Obsidian API docs, Agent SDK TypeScript docs, MCP TypeScript SDK docs, ExcalidrawAutomate docs, and Claudian's source for the SDK/Windows parts. Summarize anything that contradicts this brief before coding.
- Ask me before decisions that are hard to undo (module API shape, storage formats, anything touching my real vault).
- Small commits per milestone, conventional commit messages. Keep `CLAUDE.md` updated with architecture decisions and gotchas.
- Tests for every tool handler and the context renderer. Manual test checklist per milestone in `docs/testing.md`.
- Never write to my real vault during development — only `test-vault/`.
- Prefer boring, documented APIs; flag anything that relies on undocumented internals (e.g. Claude Code's IDE protocol) and isolate it behind an interface.
