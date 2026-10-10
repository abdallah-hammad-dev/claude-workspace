# claude-workspace — notes for Claude

Obsidian plugin that makes Claude Code the brain of a vault. Founding spec: `docs/BRIEF.md` (read it).
Behavioral reference for M1–M2: `reference/claude-bridge/main.js` (prototype, don't build on its code).

## Commands
- `npm test` (Vitest) · `npm run lint` · `npm run typecheck` · `npm run build` (tsc + esbuild → `main.js`)
- `TEST_VAULT=/mnt/c/Users/abdal/Documents/cw-test-vault npm run deploy` — build + copy into a test vault.
  The script refuses non-empty folders without the `.claude-workspace-test-vault` marker.

## Hard rules
- Never write to the user's real vault (`C:\Users\abdal\Documents\aaa`). Only `test-vault/` or a marked test vault.
- Never log tokens, note contents or tool arguments.
- Plugin is a thin host: agent logic stays in Claude Code (MCP, hooks, skills, settings).
- Core knows nothing about drawings/calendars/tasks. If a module needs a core change, fix the Module API.

## Layout
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
- **Context injected exactly once** (planned for M3): the ChatView uses an in-process `UserPromptSubmit` SDK
  hook; the vault's settings hook POSTs its stdin to `/context`, and the server returns nothing for session
  ids owned by the ChatView. Hook input's `source` field can't be used (`claude -p` is also `sdk`).

## Gotchas
- WSL here runs in **NAT** networking mode: `claude` inside WSL cannot reach Obsidian's `127.0.0.1` server on
  Windows. Test with the native Windows `claude.exe` (installed at `%USERPROFILE%\.local\bin\claude.exe`).
- Agent SDK ≥0.3's "built-in executable" is a ~240 MB per-platform native binary — can't ship in a plugin.
  ChatView must always pass `pathToClaudeCodeExecutable` (auto-detected).
- Agent SDK: omitting `permissionMode` may start in `auto`; pass `"default"` so `canUseTool` prompts appear.
- `Plugin.removeCommand(id)` takes the id *without* the plugin prefix (Obsidian ≥1.7.2 → our `minAppVersion`).
- Obsidian `onunload` is sync; async cleanup is fire-and-forget.
