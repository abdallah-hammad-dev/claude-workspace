# Module API

Source of truth: `src/core/module-api.ts`. This page explains the rules around it.

## Lifecycle

```
add(mod) ──► pending ──start()──► platform ok? ──► enabled? ──► isAvailable()? ──► onload(ctx) ──► loaded
                                     │ no            │ no           │ no                 │ throws
                                     ▼               ▼              ▼                    ▼
                                unsupported       disabled     unavailable     failed (registrations rolled back)
```

- `start()` runs on `workspace.onLayoutReady`, so plugins a module depends on (Excalidraw) are loaded.
- Toggling a module in settings unloads it (`onunload`, then every disposer in reverse order) and loads it again.
- Loads and unloads are serialized; rapid toggles can't interleave.

## What a module can register

| Call | Effect | Disposed by |
|---|---|---|
| `registerTool(def)` | Tool on the MCP server (`tools/list` changes) | removed from the registry |
| `registerContextProvider(p)` | Adds data/lines to the context block for matching view types | removed |
| `registerView(type, factory)` | Obsidian view type | leaves detached; placeholder until reload |
| `registerCommand(cmd)` | Command `claude-workspace:<module>-<id>` | `plugin.removeCommand` |
| `registerSettings(section)` | Section in the plugin's settings tab | removed |
| `registerSkill(skill)` | `.claude/skills/<name>/SKILL.md` on next install | removed from the next install |
| `onDispose(fn)` | Any other cleanup (events, intervals, DOM) | called |

## Rules

- Module id: `^[a-z][a-z0-9]*$`. Tool names must start with `<id>_`. Skill names: lowercase, digits, hyphens.
- Tool handlers return a `ToolResult` or any JSON value. Throw `ToolError("…how to recover…")` for expected
  failures; Claude sees it as `isError: true`.
- Context providers never return full file contents; cap selections. Claude reads files itself.
- Settings: `ctx.loadData(defaults)` / `ctx.saveData(data)` store under `modules.<id>.data` in plugin data.
- A module that needs Node APIs must declare `platforms: ["desktop"]` and import Node modules lazily.
