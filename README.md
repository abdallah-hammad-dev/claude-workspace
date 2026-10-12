# Claude Workspace for Obsidian

Claude Code inside Obsidian: a chat panel that knows which note or drawing you're looking at, plus a local MCP
server that lets Claude act on Obsidian itself. The same setup also works when you run `claude` in a terminal
inside your vault.

> [!WARNING]
> **Vibe-coded. Use at your own risk.**
> I built this plugin by describing what I wanted to Claude Code and testing the result, not by writing the
> code myself. It's a personal tool that I use on my own vault and share as is. Don't expect a deep, low-level
> understanding of the code from me, quick fixes, or support. It lets Claude read and edit files in your
> vault, so try it on a test vault or a backed-up vault first.

## What it does

- **Chat panel.** Claude Code runs in a side panel, with streaming replies, tool calls (including diffs), and
  inline permission prompts. Modes: *Ask before edits*, *Accept edits*, *Plan*, *Auto*, *Bypass*. You can
  also pick the model and the reasoning effort.
- **Live context.** Before each message, Claude gets a short description of what you're doing. That covers
  the open note or drawing, cursor, section, selection, selected Excalidraw elements and other open tabs, but
  not file contents (Claude reads files itself). Each of your messages shows exactly what was sent.
- **Claude Code features.** `/` commands are autocompleted, including their argument values, and `@` mentions
  vault files. You can resume earlier conversations, including ones started in a terminal. Your CLAUDE.md,
  skills, hooks and permissions all apply.
- **Attachments.**
  - Paste or drop images and PDFs (up to 10 MB).
  - Other files and bigger PDFs are referenced by path.
  - Drag notes from Obsidian's file list to mention them.
  - Long pastes collapse to `[Pasted text #1 +40 lines]`, like in Claude Code.
- **Works from a terminal too.** `claude` started in the vault gets the same context and the same Obsidian
  tools.
- **Modules.** Features come as modules that you turn on or off in settings:
  - **Obsidian** (always on): open files and report the active context.
  - **Markdown:** cursor, section and selection in notes.
  - **Commands:** search and run command-palette commands from Obsidian and other plugins (with a blocklist).
  - **Excalidraw:** read, edit, screenshot and zoom the open drawing live (needs the Excalidraw plugin).

## Requirements

- Obsidian **1.7.2+** on desktop.
  - Tested on Windows and on Linux (1.14.4, tarball build).
  - macOS should work but is untested.
  - Flatpak and Snap builds of Obsidian are sandboxed and may not find `claude`.
  - On mobile the plugin loads but does nothing yet, since the chat needs a desktop.
- [Claude Code](https://code.claude.com) installed **natively** and logged in once (run `claude` in a terminal).
  On Windows, use the native installer. A `claude` that only exists inside WSL can't reach Obsidian.

## Install

There's no release yet, so build it from source (needs Node.js 20+):

```sh
git clone git@github.com:abdallah-hammad-dev/claude-workspace.git
cd claude-workspace
npm install
npm run build
mkdir -p "<your vault>/.obsidian/plugins/claude-workspace"
cp main.js manifest.json styles.css "<your vault>/.obsidian/plugins/claude-workspace/"
```

Then in Obsidian:
1. Go to **Settings → Community plugins** and turn off Restricted mode.
2. Enable **Claude Workspace**.
3. The chat panel opens. Click **Install** in the "Connect this vault" banner.

## What it changes in your vault

- **Install** writes these files and merges with what's already there:
  - `.mcp.json`
  - `.claude/settings.json` (the context hook)
  - `.claude/skills/<name>/SKILL.md`
- `.obsidian/plugins/claude-workspace/data.json` holds the settings and the local server token.
  `debug.log` sits next to it, and never contains tokens or note contents.
- `.mcp.json` and `.claude/settings.json` contain the token. **Keep them out of git and out of any public sync.**

## Safety and privacy

- The plugin's server listens on `127.0.0.1` only. It requires a token and rejects browser requests.
- Claude Code can read and edit files and run commands in your vault folder, depending on the permission mode.
  Start with *Ask before edits*. Don't use *Bypass permissions* on a vault you care about.
- Your messages, the context block and anything Claude reads go to Anthropic through Claude Code, under your own
  account. That's the same as using Claude Code in a terminal.

## How it works

```
Obsidian ── plugin ── 127.0.0.1:<port>/mcp      MCP server (tools from modules)
                  └── 127.0.0.1:<port>/context  Claude Code HTTP hook (UserPromptSubmit)
                           ▲
         Claude Code: chat panel (Agent SDK)  or  `claude` in a terminal in the vault
```

- **The plugin is a thin host.** The agent itself is Claude Code, and the plugin only serves context and tools.
- **Context comes from a hook.** Claude Code calls `/context` before every prompt, and the reply is added to the
  prompt as context.
- **No hidden prompting.** The system prompt is Claude Code's own, plus one short paragraph saying it runs inside
  Obsidian (`SYSTEM_PROMPT_APPEND` in `src/desktop/chat/ChatView.ts`).

More detail: `CLAUDE.md` (architecture and decisions), `docs/module-api.md`, `docs/testing.md`. The original plan
is in `docs/BRIEF.md`.

## Develop

```sh
npm test            # unit tests (Vitest, with an obsidian stub)
npm run lint
npm run build       # → main.js
npm run test:e2e    # real Claude Code CLI against the real MCP server (uses your login; Haiku, a few cents)
npm run ui:preview  # screenshots of the chat view and settings with Obsidian's real stylesheet
```

Try it in a test vault:

```sh
npm run deploy                                                # Linux/macOS: into ./test-vault
TEST_VAULT=/mnt/c/Users/<you>/Documents/cw-test-vault npm run deploy   # Windows Obsidian, building from WSL
```

The deploy script refuses to write into a non-empty folder that isn't marked as a test vault.

### Modules from other plugins

```ts
const cw = app.plugins.plugins["claude-workspace"]?.api;
const dispose = cw?.registerModule({ id: "mymod", name: "My module", onload(ctx) { /* ctx.registerTool(…) */ } });
```

## Credits

[Claudian](https://github.com/YishenTu/claudian) (MIT) inspired this plugin. A few patterns follow it and were
reimplemented here: Windows CLI detection, and spawning the SDK inside Electron. The differences:
- Context is re-read on every message and injected by a Claude Code hook.
- Obsidian tools go through a local MCP server, so terminal `claude` gets them too.
- Features are modules.

## License

[MIT](LICENSE). The software is provided "as is", without warranty of any kind.
