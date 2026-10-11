# Claude Workspace for Obsidian

Turns Obsidian into a workspace for [Claude Code](https://code.claude.com): Claude sees what you're looking at
(active note, cursor, selection, open drawing) and acts on it through a local MCP server. The same setup works in
the plugin's chat view and in a `claude` terminal opened in the vault.

> Status: **early but usable** — live context, local MCP server, chat view, Excalidraw module.
> Plan and roadmap: `docs/BRIEF.md`. Manual test checklists: `docs/testing.md`.

## How it works

```
Obsidian ── plugin ── 127.0.0.1:<port>/mcp      MCP server (tools from modules)
                  └── 127.0.0.1:<port>/context  Claude Code HTTP hook (UserPromptSubmit)
                           ▲
         Claude Code: chat view (Agent SDK)  or  `claude` in a terminal in the vault
```

- **Context follows you.** Before every prompt Claude Code calls the plugin's `/context` hook and gets an
  `<obsidian_context>` block: the note or drawing you're looking at, cursor, section, selection, selected
  Excalidraw elements, other open tabs. Never file contents (Claude reads files itself). The chat view shows the
  exact block it sent under each of your messages.
- **Same setup everywhere.** `Install Claude Code config in this vault` writes `.mcp.json`, the hook in
  `.claude/settings.json` and module skills. The chat view loads the same settings (`settingSources`), so a
  terminal `claude` session in the vault behaves the same, and sessions can be resumed from either side.
- **No hidden prompting.** What you type is sent as is. The system prompt is Claude Code's own plus one short
  paragraph (`SYSTEM_PROMPT_APPEND` in `src/desktop/chat/ChatView.ts`) saying it runs inside Obsidian.
- **Security.** The server listens on 127.0.0.1 only, requires a bearer token, and rejects browser requests
  (any `Origin` header) and unexpected `Host` headers. `.mcp.json` and `.claude/settings.json` contain the token:
  keep them out of git and sync.

## Use it

1. Install [Claude Code](https://code.claude.com) natively (Windows: the native installer, not only in WSL — a
   WSL `claude` can't reach Obsidian's localhost unless WSL uses mirrored networking).
2. Enable the plugin, open **Settings → Claude Workspace**, click **Install**.
3. Click the bot icon in the ribbon to chat, or run `claude` in a terminal inside the vault.

| Tool | What it does |
|---|---|
| `obsidian_get_active_context` | Structured version of the context block |
| `obsidian_open_file` | Open a vault file (optionally at a line) |
| `excalidraw_get_scene` | Live elements of the open drawing (labels merged, bindings, selection) |
| `excalidraw_apply` | Batch of add_shape / add_text / connect / update / delete, validated before applying |
| `excalidraw_screenshot` | PNG of the live drawing |
| `excalidraw_focus` | Select + zoom to elements |

## Compared to Claudian

[Claudian](https://github.com/YishenTu/claudian) (MIT) inspired this plugin; a few patterns (Windows CLI detection,
spawning the SDK in Electron) follow it. Differences: context is re-read on every message (not frozen at the
first one) and injected by a Claude Code hook rather than by the UI; Obsidian tools are served over a local MCP
server so the terminal CLI gets them too; sessions are Claude Code's own; features are modules.

## Develop

```sh
npm install
npm test            # unit tests (Vitest, with an obsidian stub)
npm run lint
npm run build       # → main.js
npm run test:e2e    # real Claude Code CLI against the real MCP server (uses your login; Haiku, a few cents)
```

### Try it in a test vault

```sh
# Linux/macOS: deploys into ./test-vault
npm run deploy
# Windows Obsidian, building from WSL: deploy to a vault on the Windows side
TEST_VAULT=/mnt/c/Users/<you>/Documents/cw-test-vault npm run deploy
```

Open that folder as a vault in Obsidian, trust it, and enable **Claude Workspace** under Community plugins.
The deploy script refuses to write into any non-empty folder that isn't marked as a test vault.

## Modules

Features live in modules (`src/modules/<id>`) that register tools, context providers, views, commands, settings
and Claude Code skills through one API (`src/core/module-api.ts`). Other plugins can add modules:

```ts
const cw = app.plugins.plugins["claude-workspace"]?.api;
const dispose = cw?.registerModule({ id: "mymod", name: "My module", onload(ctx) { /* ctx.registerTool(…) */ } });
```

## License

MIT
