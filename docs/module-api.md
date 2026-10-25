# Module API

Source of truth: `src/core/module-api.ts`. This page explains the rules around it.

## Lifecycle

```
add(mod) ──► pending ──start()──► platform ok? ──► enabled? ──► plugin loaded and ──► isAvailable()? ──► onload(ctx) ──► loaded
                                     │ no            │ no         recent enough?           │ no                 │ throws
                                     ▼               ▼              │ no                   ▼                    ▼
                                unsupported       disabled          └──────────────► unavailable     failed (registrations rolled back)
```

- `start()` runs on `workspace.onLayoutReady`, so plugins a module depends on (Excalidraw) are loaded.
- `plugin: { id, minVersion? }` names the Obsidian plugin a module is for, by its manifest id (the one in
  `.obsidian/plugins/<id>/`). Obsidian has no dependencies between plugins, so `minVersion` is ours, modeled on
  a manifest's `minAppVersion`. Every 2 s the plugin checks which plugins are loaded (Obsidian has no event):
  a module loads when its plugin appears or is updated past `minVersion`, and unloads when it is turned off. A
  too-old plugin shows the reason in settings ("Needs Excalidraw 2.29.0 or newer; 2.28.1 is installed").
- Settings list modules without `plugin` under "Core modules", the others under their plugin's name and version.
- Toggling a module in settings unloads it (`onunload`, then every disposer in reverse order) and loads it again.
- Loads and unloads are serialized; rapid toggles can't interleave.

## What a module can register

| Call | Effect | Disposed by |
|---|---|---|
| `registerTool(def)` | Tool on the MCP server (`tools/list` changes) | removed from the registry |
| `registerContextProvider(p)` | Adds data/lines to the context block for matching view types | removed |
| `registerView(type, factory)` | Obsidian view type | leaves detached; placeholder until reload |
| `registerCommand(cmd)` | Command `claude-workspace:<module>-<id>` | `plugin.removeCommand` |
| `registerSettings(section)` | Rows in the module's card in the settings tab (Obsidian setting definitions + their values; a `page` row opens a sub-page) | removed |
| `registerSkill(skill)` | `.claude/skills/<name>/SKILL.md` once the vault is connected, marked as installed by the plugin; a user's own skill of that name is kept | no longer written; the file stays until the user deletes it (Settings → Skills) |
| `onDispose(fn)` | Any other cleanup (events, intervals, DOM) | called |

## Rules

- Module id: `^[a-z][a-z0-9-]*$` (a plugin's manifest id fits). Tool names must start with `<id>_`. Skill names:
  lowercase, digits, hyphens.
- Tool handlers return a `ToolResult` or any JSON value. Throw `ToolError("…how to recover…")` for expected
  failures; Claude sees it as `isError: true`.
- Context providers never return full file contents; cap selections. Claude reads files itself.
- Settings: `ctx.loadData(defaults)` / `ctx.saveData(data)` store under `modules.<id>.data` in plugin data.
  Show them with `registerSettings({ title, items, values })`: `items` are Obsidian setting definitions (prefer
  `control` rows), `values` maps each control key to `{ get, set }`. Keys are the module's own; the settings tab
  prefixes them (`modules.<id>.<key>`), on sub-pages too. Obsidian finds a `page` by its name among all the tab's
  pages (`SettingDefinitionPage` has no public id), so put the module's name in it ("Excalidraw CLI commands").
- A setting change that decides what the module registers (e.g. which tools) can call the registry's
  `reload(id)` from the code that created the module; modules don't reload themselves.
- A module that needs Node APIs must declare `platforms: ["desktop"]` and import Node modules lazily.

## CLI modules

`src/modules/cli/` turns the commands registered with Obsidian's CLI (`Plugin.registerCliHandler`, Obsidian
1.12.2+) into modules, one per plugin plus `cli` for Obsidian's own, without any code for a given plugin:

- The commands come from `app.cli.handlers` (undocumented, `handlers.ts`). Obsidian prefixes a community plugin's
  description with `[<manifest name>]: `; that names the plugin (`<plugin-id>:<action>` is only a convention).
- Module id = the plugin's manifest id; tool = `<module>_<action>` (`obsidian-excalidraw-plugin:read` →
  `obsidian-excalidraw-plugin_read`, `daily:read` → `cli_daily_read`), kept within 64 characters as
  `mcp__obsidian__<tool>`.
- Flags with a value placeholder become text parameters, the others switches; flag names the Claude API rejects
  (`help`'s `<command>`) are left out. A tool runs the handler inside Obsidian with the `key=value` params the CLI
  would pass and returns its text.
- Never offered: `__…` and Obsidian's developer commands (`eval`, `dev:…`, `devtools`). Off until switched on:
  Obsidian's own commands that restart the app, install/remove plugins or themes, delete or restore files, or run
  any palette command (`command`, which would bypass the Obsidian commands module's blocklist).
- A plugin module and a CLI module for the same plugin are shown side by side, under the plugin. Neither knows
  about the other; the user resolves any overlap with the switches.

## Origins

`registry.add(mod, origin)` records where a module comes from, shown on its card:

| Origin | Label | What |
|---|---|---|
| `builtin` | Built in | Ships here, about Obsidian itself (no `plugin`) |
| `custom` | Custom | Ships here, written for a plugin outside that plugin (it has a `plugin`; `ShippedModules`) |
| `cli` | CLI | Made from Obsidian CLI commands |
| `plugin` | From plugin | The default: added through `plugin.api.registerModule` |

Every module is about Obsidian itself or about one plugin. Only custom modules can be deleted: a trash button next
to the toggle (confirmed; `plugin.deleteModule`) leaves the module out (`data.deletedModules`) until it is restored
under "Deleted modules"; its settings and the skills it installed (marked SKILL.md, not the user's own) go too. A
plugin's own module and CLI modules can only be turned off. In every section the order is built in, the plugin's
own, custom, CLI.
