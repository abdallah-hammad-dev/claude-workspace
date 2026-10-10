# Claude Workspace for Obsidian

Turns Obsidian into a workspace for [Claude Code](https://code.claude.com): Claude sees what you're looking at
(active note, cursor, selection, open drawing) and acts on it through a local MCP server. The same setup works in
the plugin's chat view and in a `claude` terminal opened in the vault.

> Status: **M0 — skeleton.** Module registry and an example module only. See `docs/BRIEF.md` for the plan.

## Develop

```sh
npm install
npm test            # unit tests (Vitest, with an obsidian stub)
npm run lint
npm run build       # → main.js
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
