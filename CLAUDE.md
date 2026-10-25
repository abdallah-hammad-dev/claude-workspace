# claude-workspace — notes for Claude

Obsidian plugin that makes Claude Code the brain of a vault. Founding spec: `docs/BRIEF.md` (read it).
Behavioral reference for M1–M2: `reference/claude-bridge/main.js` (prototype, don't build on its code).

## Commands
- `npm test` (Vitest) · `npm run lint` · `npm run typecheck` · `npm run build` (tsc + esbuild → `main.js`)
- `npm run test:e2e` — real Claude Code CLI + real MCP host in a temp vault (Haiku, a few cents). Run after
  touching McpHost, the installer's hook format or ChatSession.
- `npm run ui:preview [scenario…]` — renders the real chat view / settings tab in headless Chromium with
  Obsidian's own app.css (read from the installed obsidian.asar) → `tools/ui-preview/out/*.png`, light + dark.
  **Look at the screenshots after any UI change.** Scenarios live in `tools/ui-preview/harness.ts`.
- `TEST_VAULT=/mnt/c/Users/abdal/Documents/cw-test-vault npm run deploy` — build + copy into a test vault.
  The script refuses non-empty folders without the `.claude-workspace-test-vault` marker.
- Release: `npm version patch|minor|major` then `git push --follow-tags` → the Release workflow checks
  tag = manifest = package version, runs lint/tests/build, publishes `main.js`/`manifest.json`/`styles.css`.
  Details and rules in `docs/releasing.md`. Never hand-edit the manifest version or hand-create tags.

## Hard rules
- Never write to the user's real vault (`C:\Users\abdal\Documents\aaa`). Only `test-vault/` or a marked test vault.
- Never log tokens, note contents or tool arguments.
- Plugin is a thin host: agent logic stays in Claude Code (MCP, hooks, skills, settings).
- Core knows nothing about what modules handle (drawings…). If a module needs a core change, fix the Module API.

## Layout
- `src/main.ts` — plugin; creates registry + ContextEngine; `await import("./desktop")` only on desktop.
- `src/core/context/` — ContextEngine (tracks last file leaf, asks providers) + pure `renderContext`.
- `src/desktop/McpHost.ts` — node:http server: `/mcp` (MCP SDK, stateless), `/context` (hook), `/health`.
- `src/desktop/installer-merge.ts` (pure) + `Installer.ts` — `.mcp.json`, `.claude/settings.json`, skills.
- `src/desktop/chat/` — ChatSession (Agent SDK wrapper, no DOM; `warmup()` + `initialization()` give slash
  commands/models before the first message), ChatView (layout, composer, pickers), Transcript (messages, tool
  rows), PromptDock (inline permission / plan / question cards), suggest (`/` and `@` popup + pure filters),
  tool-render (icons, plain-language permission wording, diffs), modals (conversation picker).
- `src/desktop/connection-settings.ts` — settings "Connection" section (definitions + values); no Node imports
  (preview-friendly).
- `src/desktop/instructions-settings.ts` — settings "Instructions" (vault and folder `CLAUDE.md`, "Skills" page,
  skill editor/viewer modals, folder picker); no Node imports. `skills.ts` — SKILL.md parse/compose (Obsidian's
  `getFrontMatterInfo`/`parseYaml`/`stringifyYaml`), name rules, installed marker, `SkillStore` (vault adapter,
  reaches `.claude`). `settings-window.ts` — the `app.setting` adapter (open/close the settings window).
- `src/desktop/voice/` — voice input: `providers.ts` (pure: OpenAI-compatible request/response, defaults),
  `audio.ts` (pure: WAV, silence check), `MicRecording.ts` (AudioWorklet capture), `index.ts` (service:
  keychain, requestUrl), `voice-settings.ts`; the button is `chat/MicButton.ts`.
- `tools/ui-preview/` — browser stand-in for `obsidian` (including a renderer for setting definitions modeled on
  Obsidian's app.js) + scenarios + screenshot script (dev only).
- `src/modules/obsidian` (core tools, required), `src/modules/markdown` (cursor/section/selection).
- `src/core/plugins.ts` — the `app.plugins` adapter (loaded plugins: id, name, version) + `compareVersions`.
- `src/modules/cli/` — CLI modules: `handlers.ts` (`app.cli.handlers` adapter), `bridge.ts` (pure: grouping by
  plugin, tool names, flag → zod), `index.ts` (`CliBridge`: adds/reloads/removes one module per plugin).
- `src/modules/shipped.ts` — `ShippedModules`: adds the built-in list with each module's origin, deletes and
  restores the custom ones (`data.deletedModules`).
- `src/core/ConfirmModal.ts` — "Delete …?" dialog shared by the settings tab and the Instructions section.
- `src/core/module-api.ts` — the Module API (types only + `ToolError`). No MCP/Agent SDK types here.
- `src/core/ModuleRegistry.ts` — loads modules, collects registrations, scoped disposal, change events.
- `src/core/settings.ts` — persisted data shape + declarative settings tab (`getSettingDefinitions`).
- `src/modules/<id>/` — one folder per module; `src/modules/index.ts` lists built-ins.
- `test/stubs/obsidian.ts` — runtime stub aliased as `obsidian` in Vitest. Tests import fakes from the stub
  directly (for stub-specific helpers); source code imports `obsidian`.

## Decisions
- **One plugin, desktop + mobile** (`isDesktopOnly: false`). Node-only parts (MCP server, ChatView, installer)
  must be loaded only when `Platform.isDesktopApp` and `require`d lazily; Node builtins are esbuild externals.
  Modules declare `platforms`.
- **Module API** (approved 2026-10-10): brief §3.1 plus scoped auto-disposal, provider `id`/`priority`,
  `collect(view, file)`, zod raw-shape `ToolDef` with `annotations` and `AbortSignal`, `platforms`,
  `enabledByDefault`, per-module `loadData/saveData`, `onDispose`.
- **Tool names** must be `${moduleId}_…`; enforced by the registry. Core tools use the `obsidian_` prefix.
- **Command ids** become `${moduleId}-${cmd.id}`.
- **Views**: Obsidian can't unregister a view type, so the registry registers a trampoline once per type;
  a disabled module's views are detached and any restored leaf shows a placeholder.
- **Token storage**: for now in plugin data + vault config files (gitignored in the test vault). The user
  deferred the "secrets must not sync to the VPS" question; revisit before any sync.
- **Context injection = one HTTP hook** (`type: "http"` UserPromptSubmit hook in `.claude/settings.json`,
  POST to `/context`, response `hookSpecificOutput.additionalContext`). No curl, no shell differences.
  The ChatView adds **no** hook of its own: it loads project settings, so the same hook fires once per turn
  (verified by `npm run test:e2e`). The server reports what it served (with `session_id`) and the chat shows
  exactly that on the user's message ("context sent"). No served event by turn end → "not installed" chip.
- **MCP server is stateless** (fresh McpServer per POST, built from the registry). Obsidian restarts never
  strand a Claude Code session; module toggles appear after `/mcp` reconnect in Claude Code.
- **Server name** `obsidian` → tools are `mcp__obsidian__<module>_<tool>`.
- **Port** defaults to a hash of the vault path (27200–27999) so several vaults can run at once.
- **ChatView passes `mcpServers` explicitly** (works before Install) and the same server is in `.mcp.json`;
  same name, no duplication observed.
- **Bundling the Agent SDK into the renderer** (see `esbuild.config.mjs` banner): module-scope shims for
  `setTimeout`/`setInterval` handles with `.unref()`, and `import.meta.url` → `__cwImportMetaUrl`. Desktop
  code is only reached through `await import("./desktop")`, which esbuild turns into lazy init, so the bundle
  loads on mobile — check with `npm run check:mobile` after a build.
- **Undocumented Obsidian APIs** are isolated in one adapter file each and make their module "unavailable"
  if missing: `app.commands` (commands module, `src/modules/commands/registry.ts`), `app.plugins.plugins`
  (`src/core/plugins.ts`), `app.cli.handlers` (`src/modules/cli/handlers.ts`), `app.setting`
  (`src/desktop/settings-window.ts`; without it the buttons just don't close/open settings).
- **Modules for a plugin** (2026-10-25): `WorkspaceModule.plugin = { id, minVersion? }`, the plugin's manifest id
  as Obsidian uses it; `minVersion` is ours (Obsidian has no plugin dependencies), modeled on `minAppVersion`.
  The registry loads such a module only while the plugin is loaded and recent enough (`unavailable` + `reason`
  otherwise) and unloads it when the plugin goes away (`refreshAvailability`). Settings: "Core modules" (no
  `plugin`), then one section per plugin headed "<name> <version>". Module ids may contain hyphens (so a
  plugin's id fits). Obsidian has no plugin enable/disable event: `main.ts` polls loaded plugins every 2 s
  (`watchPlugins`, which also runs the CLI bridge) and on `visibilitychange`. This replaced the old retry on
  `layout-change`/`active-leaf-change`.
- **CLI modules** (2026-10-25): every command registered with `Plugin.registerCliHandler` becomes a tool run in
  process (no shell): one module per plugin (id = manifest id, name "<Plugin> CLI"), `cli` for Obsidian's own
  (off by default). Rules in `docs/module-api.md` § CLI modules. A handwritten module and the CLI module of the
  same plugin are shown side by side and never reference each other (the user's call: a module written before
  the plugin had a CLI can't know about it); overlap is resolved by the user's switches. Per-command switches
  live on a settings sub-page; a change saves module data and calls `registry.reload(id)`. Verified with
  Excalidraw 2.29.0 in Obsidian 1.14.5: 14 tools, `status`/`list`/`read` answer through the tools.
- **Module origins and custom modules** (2026-10-25): every module is about Obsidian itself or about one plugin,
  and its card shows where it comes from (`registry.add(mod, origin)`, default `plugin`). The user's words: **Built
  in** = about Obsidian itself (obsidian, markdown, commands); **Custom** = written for a plugin outside that
  plugin, i.e. a shipped module with `plugin` (Excalidraw: "this one isn't from Excalidraw, it is a custom module",
  "made by the user technically"); **CLI**; **From plugin** = the plugin's own module via the API. Only custom
  modules can be deleted: trash icon next to the toggle → confirmation → left out until restored under "Deleted
  modules" (`ShippedModules`, `data.deletedModules`), its settings and the skills it installed (marked) go too. A
  plugin's own module is treated like its CLI module: it can only be turned off (test "lets only custom modules be
  deleted"). Module files in the vault (`.claude/obsidian-modules`, a "Your modules" section) were built from a
  misread question and removed the same day: "modules are for plugins", "it is always about a plugin". Verified in
  Obsidian 1.14.5 (test vault): the Excalidraw module deleted (tools and skill gone, CLI module kept) and restored.
- **Instructions in settings** (2026-10-25): the plugin edits Claude Code's own files, it adds no prompt of its
  own. Vault `CLAUDE.md` (Open/Create, opens as a note in a new tab and closes settings), folder `CLAUDE.md`
  files (a `list` with a + that picks a folder; also a folder's right-click menu), and a "Skills" page: your
  skills in a `list` (+ new, click to edit, × to delete with a confirmation, to the system trash), module skills
  read-only. New files get a short template whose hint is a block HTML comment, which Claude Code strips from
  CLAUDE.md before Claude sees it (documented). The installer puts `INSTALLED_MARKER` after a module skill's
  frontmatter: a marked SKILL.md (or the module's exact unmarked text, from before the marker) is overwritten on
  install, any other SKILL.md of that name is the user's and is kept (Notice on install, logged on sync).
  A marked skill whose module is off stays on disk and is listed with a Delete in its viewer. Since the tab
  draws the definitions of its last `update()`, vault create/delete/rename of a `CLAUDE.md` calls `update()`;
  `.claude` is hidden from the vault events, so skills are re-read when the Skills row draws (`displayValue`)
  and the tab updates only if they changed.
- **Settings show module contents** via `ModuleRegistry.contentsOf(id)`, computed from live registrations
  (only for loaded modules).
- **Settings tab is declarative** (Obsidian 1.13 `getSettingDefinitions`, `minAppVersion` 1.13.2 for the
  `secret` control). Obsidian renders and search-indexes the definitions. Values live in `plugin.data`, module
  data and desktop services, not in `plugin.settings`, so each block returns `{ items, values }` (key → `get`/
  `set`, with conversions such as port text ↔ number|null) and the tab's `getControlValue`/`setControlValue`
  route by key. Module control keys become `modules.<id>.<key>`; the Module API's `SettingsSection` is
  `items` + `values` (2026-10-15; was `display(el)`). `control` rows wherever a value is edited; `render` rows
  only for custom UI: status rows, module badge + toggle, "what it adds", buttons (Obsidian's own tabs put
  buttons in render rows too; `action` rows are for list entries). Verified in app.js 1.14.4: opening the tab
  draws the definitions kept by the **last `update()`**, it does not re-read them, so the tab calls `update()`
  on registry changes (debounced) and is added after the desktop sections exist. `update()` redraws rows in
  place (same `Setting`, controls cleared): a render row with async work returns a cleanup that marks it stale.
  Every control change is followed by `refreshDomState()` (voice rows use `visible` predicates).

- **Prompts are inline cards** (PromptDock), not modals. Typing in the composer while a card is shown answers
  it ("do this instead" → deny with message; plan → feedback; question → free-text answer). Plan approval
  sends `updatedPermissions: setMode` (acceptEdits/default) like Claude Code.
- **Slash commands** come from `initializationResult().commands` of a warmed-up session (process started on
  input focus or on `/`). `/clear`, `/effort` and `/model` are handled by the view (`local-commands.ts`):
  their terminal versions are interactive pickers that only print "Usage" over the SDK, so the view opens
  its own picker or applies the argument. Everything else passes through. Messages starting with `/` don't
  expect hook context (local commands don't fire UserPromptSubmit).
- **Slash command arguments**: after `/cmd `, the popup offers the first argument's values. Effort/model come
  from the view (picking applies at once); every other command's values come from the `a|b|c` alternatives in
  its documented `argumentHint` (`argChoices`). Never parse command *output* ("Usage: …") — not a stable format.
  Terminal-only built-ins (`color`, `focus`, `heapdump`, `__*`) are hidden from the popup (`TERMINAL_ONLY`).
  Claude Code itself omits TUI-only commands (`/permissions`, `/resume`, `/login`…) from the SDK list.
- **Effort** is a chat pref ("" = Claude Code's default): `effort` query option at start, then
  `applyFlagSettings({ effortLevel })` mid-session (verified by e2e via `CLAUDE_EFFORT` in Bash). The button
  hides for models without effort levels.
- **"Default" shows its value**: the model button names the model the default row resolves to (documented
  `ModelInfo.resolvedModel`); the effort button shows the level Claude Code really applies, from the
  **undocumented** `Query.getSettings().applied` (isolated in `applied-settings.ts`, degrades to "Default";
  the e2e test asserts it still works).
- **Images and long pastes**: pasted/dropped PNG/JPEG/GIF/WebP go as base64 image blocks (Claude Code downsizes
  big ones itself; a 43 MB 7680×4320 PNG worked). Pastes over 800 chars or 12 lines become
  `[Pasted text #n +L lines]` in the composer and are expanded on send (`paste.ts`), like Claude Code; the
  bubble shows them as chips. Long user messages (e.g. from history) fold with "Show more".
- **Files and drags** (`drop.ts`): PDFs ≤10 MB are sent as `document` blocks (verified with real Claude Code);
  other files and bigger PDFs are referenced by path like Claude Code's terminal drop — `@vault/relative` inside
  the vault, `@"absolute"` outside (Claude Code loads @-mentioned files itself). OS paths come from Electron's
  `webUtils.getPathForFile` (`File.path` is gone since Electron 32). Notes/files dragged out of Obsidian carry
  documented `obsidian://open?vault=…&file=…` URIs in `text/uri-list` (no `.md`); folders only their path in
  `text/plain`. Local commands (`/model`…) run even with attachments, which wait for the next message.
- **Distribution = GitHub releases** (public repo `abdallah-hammad-dev/claude-workspace`), installed with BRAT
  (verified: BRAT 2.2.0 installs 0.1.0 from the repo URL, no token) or manually. Tags have no `v` (`.npmrc`).
  CI (`.github/workflows/ci.yml`) runs lint/tests/build/mobile check on every push; e2e and UI screenshots stay
  local (need a Claude login / Obsidian install).
- **Voice input** is opt-in (`voice.enabled`, default off: no mic, no command) and generic: any
  OpenAI-compatible `POST <url>/audio/transcriptions`, set as endpoint URL + model + key (prefilled with Groq's
  free tier; no per-provider code, OpenAI and self-hosted Whisper servers work the same). Claude Code's `/voice` is terminal-only and absent from the SDK command list
  (verified on 2.1.296 Linux and Windows). Mic audio comes raw from an AudioWorklet at 16 kHz and is sent as a
  16-bit WAV through `requestUrl` (no CORS). The API key lives in Obsidian's keychain (`app.secretStorage`,
  picked with the settings' `secret` control); `data.json` stores only the secret's name. Silent recordings are not
  sent. Logs: host, model and timings only, never audio, text or key. A local-Whisper version (transformers.js,
  WebGPU) was built and dropped as too heavy: hundreds of MB of downloads, ~1 GB of RAM, +0.6 MB of bundle.
  **Text at each pause** (`voice.live`, on by default): `PauseSplitter` (pure, `audio.ts`) cuts the take after
  ≥3 s of speech + 1 s of quiet (0.5 s after 20 s), against an adaptive noise floor capped at 0.04 RMS; pieces
  are sent in order with the end of the text so far as `prompt` (≤150 tokens). A failed piece and the ones after
  it are held and sent with the rest at stop. Esc keeps typed text and drops the rest. Not word by word: Groq
  has no streaming, OpenAI streams only finished files (live needs its Realtime API, provider-specific), and
  re-sending audio every second would break Groq's free 20 requests/minute.
- **Icons**: only Lucide names that exist in Obsidian's bundled set (checked against app.js: names appear as
  `"name":[[` or `name:[[`). The preview marks unknown icons red.

## Gotchas
- Settings pages: Obsidian finds a `page` definition by name (`id ?? name`; `id` isn't in the public type) among
  all of the tab's pages, groups being transparent. Two pages with the same name open the first one. Hence
  "<module name> commands".
- Claude API: tool input property names must match `^[a-zA-Z0-9_.-]{1,64}$`; one bad name breaks the whole tools
  list. CLI flags like help's `<command>` are dropped.
- Chromium throttles timers in a hidden window to about once a minute (seen: 0 polls in 5 s with Obsidian hidden).
- Checking the real app from WSL: `Obsidian.com vault=cw-test-vault eval code="…"` (Windows interop, no NAT
  issue), `plugin:reload id=claude-workspace` after a deploy. On this machine settings open in a popout window;
  `dev:screenshot` captures the main window only, so capture with
  `require('@electron/remote').BrowserWindow…webContents.capturePage()` inside `eval`. The settings DOM is in
  `app.setting.win.document`. `capturePage()` of that (unfocused) window can return the previous frame: call
  `webContents.invalidate()`, capture once, wait, capture again.
- WSL here runs in **NAT** networking mode: `claude` inside WSL cannot reach Obsidian's `127.0.0.1` server on
  Windows. Test with the native Windows `claude.exe` (installed at `%USERPROFILE%\.local\bin\claude.exe`).
- Agent SDK ≥0.3's "built-in executable" is a ~240 MB per-platform native binary — can't ship in a plugin.
  ChatView must always pass `pathToClaudeCodeExecutable` (auto-detected).
- Agent SDK: omitting `permissionMode` may start in `auto`; pass `"default"` so `canUseTool` prompts appear.
- `Plugin.removeCommand(id)` takes the id *without* the plugin prefix (Obsidian ≥1.7.2).
- Obsidian `onunload` is sync; async cleanup is fire-and-forget.
- `spawnClaudeCodeProcess`: never pass the SDK's AbortSignal to Node's spawn in Electron (realm mismatch);
  we kill on abort manually. Windows: spawn `claude.exe` or `cli.js`, never npm `.cmd` shims.
- The HTTP hook fails "open" (default `onFailure: continue`): with Obsidian closed, terminal prompts still go
  through, just without context.
- **Never declare class fields that shadow Obsidian base-class members** (`titleEl`, `contentEl`, `containerEl`,
  `headerEl`, `icon`, `navigation`, `scope`, `modalEl`, `inputEl`, `Plugin.settings` since 1.13…). Our plugin
  data is `plugin.data`. With ES2022 define-semantics they reset the
  base value to undefined after `super()`; `ChatView.titleEl` did exactly that and Obsidian's header update threw
  before `onOpen` ran (blank panel, no error in our log). tsconfig now has `useDefineForClassFields: false` too.
- Electron realm: the SDK calls `events.setMaxListeners(n, abortSignal)` with a browser AbortSignal → Node throws
  "eventTargets … Received an instance of AbortSignal". `src/desktop/electron-compat.ts` patches it (applied in
  `startDesktop`). Patch the **default** import of `node:events` — `import * as` gives esbuild's read-only interop copy.
