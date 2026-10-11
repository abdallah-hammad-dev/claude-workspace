# claude-workspace — notes for Claude

Obsidian plugin that makes Claude Code the brain of a vault. Founding spec: `docs/BRIEF.md` (read it).
Behavioral reference for M1–M2: `reference/claude-bridge/main.js` (prototype, don't build on its code).

## Commands
- `npm test` (Vitest) · `npm run lint` · `npm run typecheck` · `npm run build` (tsc + esbuild → `main.js`)
- `npm run test:e2e` — real Claude Code CLI + real MCP host in a temp vault (Haiku, a few cents). Run after
  touching McpHost, the installer's hook format or ChatSession.
- `TEST_VAULT=/mnt/c/Users/abdal/Documents/cw-test-vault npm run deploy` — build + copy into a test vault.
  The script refuses non-empty folders without the `.claude-workspace-test-vault` marker.

## Hard rules
- Never write to the user's real vault (`C:\Users\abdal\Documents\aaa`). Only `test-vault/` or a marked test vault.
- Never log tokens, note contents or tool arguments.
- Plugin is a thin host: agent logic stays in Claude Code (MCP, hooks, skills, settings).
- Core knows nothing about drawings/calendars/tasks. If a module needs a core change, fix the Module API.

## Layout
- `src/main.ts` — plugin; creates registry + ContextEngine; `await import("./desktop")` only on desktop.
- `src/core/context/` — ContextEngine (tracks last file leaf, asks providers) + pure `renderContext`.
- `src/desktop/McpHost.ts` — node:http server: `/mcp` (MCP SDK, stateless), `/context` (hook), `/health`.
- `src/desktop/installer-merge.ts` (pure) + `Installer.ts` — `.mcp.json`, `.claude/settings.json`, skills.
- `src/desktop/chat/` — ChatSession (Agent SDK wrapper, no DOM), ChatView, Transcript, modals, tool-render.
- `src/modules/obsidian` (core tools, required), `src/modules/markdown` (cursor/section/selection).
- `src/core/module-api.ts` — the Module API (types only + `ToolError`). No MCP/Agent SDK types here.
- `src/core/ModuleRegistry.ts` — loads modules, collects registrations, scoped disposal, change events.
- `src/core/settings.ts` — persisted data shape + settings tab.
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
  loads on mobile (checked by loading main.js with a require that only knows `obsidian`).

## Gotchas
- WSL here runs in **NAT** networking mode: `claude` inside WSL cannot reach Obsidian's `127.0.0.1` server on
  Windows. Test with the native Windows `claude.exe` (installed at `%USERPROFILE%\.local\bin\claude.exe`).
- Agent SDK ≥0.3's "built-in executable" is a ~240 MB per-platform native binary — can't ship in a plugin.
  ChatView must always pass `pathToClaudeCodeExecutable` (auto-detected).
- Agent SDK: omitting `permissionMode` may start in `auto`; pass `"default"` so `canUseTool` prompts appear.
- `Plugin.removeCommand(id)` takes the id *without* the plugin prefix (Obsidian ≥1.7.2 → our `minAppVersion`).
- Obsidian `onunload` is sync; async cleanup is fire-and-forget.
- `spawnClaudeCodeProcess`: never pass the SDK's AbortSignal to Node's spawn in Electron (realm mismatch);
  we kill on abort manually. Windows: spawn `claude.exe` or `cli.js`, never npm `.cmd` shims.
- The HTTP hook fails "open" (default `onFailure: continue`): with Obsidian closed, terminal prompts still go
  through, just without context.
- **Never declare class fields that shadow Obsidian base-class members** (`titleEl`, `contentEl`, `containerEl`,
  `headerEl`, `icon`, `navigation`, `scope`, `modalEl`, `inputEl`…). With ES2022 define-semantics they reset the
  base value to undefined after `super()`; `ChatView.titleEl` did exactly that and Obsidian's header update threw
  before `onOpen` ran (blank panel, no error in our log). tsconfig now has `useDefineForClassFields: false` too.
- Electron realm: the SDK calls `events.setMaxListeners(n, abortSignal)` with a browser AbortSignal → Node throws
  "eventTargets … Received an instance of AbortSignal". `src/desktop/electron-compat.ts` patches it (applied in
  `startDesktop`). Patch the **default** import of `node:events` — `import * as` gives esbuild's read-only interop copy.
