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
- **Voice input (optional, off by default).** Click the mic in the chat and talk; your words appear in the
  message box at each pause, for you to review. Speech-to-text goes through any OpenAI-compatible API (prefilled with Groq's
  free tier). See [Voice input](#voice-input).
- **Works from a terminal too.** `claude` started in the vault gets the same context and the same Obsidian
  tools.
- **Modules.** Features come as modules that you turn on or off in settings. The core modules are about Obsidian
  itself; the others are listed under the plugin they are for, with its version:
  - **Obsidian** (always on): open files and report the active context.
  - **Markdown:** cursor, section and selection in notes.
  - **Commands:** search and run command-palette commands from Obsidian and other plugins (with a blocklist).
  - **Obsidian CLI** (off by default): Obsidian's own command-line commands (search, daily notes, properties,
    tasks…) as tools. Developer commands (`eval`, `dev:…`) are never offered.
  - **Excalidraw:** read, edit, screenshot and zoom the open drawing live (needs the Excalidraw plugin).
  - **`<Plugin>` CLI:** for every plugin that adds commands to Obsidian's command line (Obsidian 1.12.2+;
    e.g. Excalidraw 2.29+, Templater, QuickAdd), those commands become tools, run inside Obsidian. Found
    automatically; a page in settings has a switch per command.

## Requirements

- Obsidian **1.13.2+** on desktop.
  - Tested on Windows and on Linux (1.14.4, tarball build).
  - macOS should work but is untested.
  - Flatpak and Snap builds of Obsidian are sandboxed and may not find `claude`.
  - On mobile the plugin loads but does nothing yet, since the chat needs a desktop.
- [Claude Code](https://code.claude.com) installed **natively** and logged in once (run `claude` in a terminal).
  On Windows, use the native installer. A `claude` that only exists inside WSL can't reach Obsidian.

## Install

First install [Claude Code](https://code.claude.com) and log in once by running `claude` in a terminal.
Then pick one of the methods below.

### With BRAT (recommended: one paste, automatic updates)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins straight from a GitHub repository and
keeps them up to date.

1. In Obsidian, open **Settings → Community plugins**, turn off Restricted mode, then **Browse**. Search for
   **BRAT**, then **Install** and **Enable** it.
2. Open the command palette (`Ctrl/Cmd + P`) and run **BRAT: Plugins: Add a beta plugin for testing (with or without version)**.
3. In **Repository**, paste:
   ```
   https://github.com/abdallah-hammad-dev/claude-workspace
   ```
4. Keep **Latest version** and **Enable after installing the plugin**, then click **Add plugin**.
5. The Claude panel opens on the right. Click **Install** in the "Connect this vault" banner.

**Updates:** BRAT checks for new versions every time Obsidian starts (on by default). To update right away, run
**BRAT: Plugins: Check for updates to all beta plugins and UPDATE**.

No GitHub token is needed: the repository is public.

### Manually, from a release

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/abdallah-hammad-dev/claude-workspace/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/claude-workspace/`.
3. In **Settings → Community plugins**, turn off Restricted mode and enable **Claude Workspace**.
4. Click **Install** in the "Connect this vault" banner.

Updates are manual: download the three files again.

### From source

Needs Node.js 20+:

```sh
git clone https://github.com/abdallah-hammad-dev/claude-workspace.git
cd claude-workspace
npm install
npm run build
mkdir -p "<your vault>/.obsidian/plugins/claude-workspace"
cp main.js manifest.json styles.css "<your vault>/.obsidian/plugins/claude-workspace/"
```

## What it changes in your vault

- **Install** writes these files and merges with what's already there:
  - `.mcp.json`
  - `.claude/settings.json` (the context hook)
  - `.claude/skills/<name>/SKILL.md`
- `.obsidian/plugins/claude-workspace/data.json` holds the settings and the local server token.
  `debug.log` sits next to it, and never contains tokens or note contents.
- `.mcp.json` and `.claude/settings.json` contain the token. **Keep them out of git and out of any public sync.**

## Voice input

Off by default: there's no mic until you turn it on in **Settings → Claude Workspace → Voice input**.

Then click the mic in the chat box and talk. Each time you pause for a second, what you just said is typed in
the message box while you keep talking; click the mic again when you're done. You edit the text before sending.
Enter also stops the recording (without sending), and Esc stops it and drops what isn't typed yet. The
**Start or stop voice input** command can take a hotkey.

- **Where the speech-to-text happens:** the recording (a WAV, about 2 MB per minute) is sent, one phrase at a
  time, to the OpenAI-compatible API you set: an **endpoint URL** (the plugin calls `<URL>/audio/transcriptions`), a
  **model** and an **API key**. For example:

  | Service | Endpoint URL | Model | Key |
  |---|---|---|---|
  | Groq (prefilled; free tier with daily limits) | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | [console.groq.com/keys](https://console.groq.com/keys) |
  | OpenAI (paid) | `https://api.openai.com/v1` | `whisper-1` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
  | Your own server (e.g. a self-hosted Whisper) | its URL | its model name | if it needs one |
- **The API key stays out of your vault.** It's kept in Obsidian's keychain (**Settings → Keychain**). The
  plugin's settings only store the key's name.
- **Nothing is recorded or sent** unless you click the mic. Silent recordings aren't sent.
- **Phrase by phrase:** a phrase is sent after at least 3 s of speech and a 1 s pause, so one request every
  4 s at most (Groq's free tier allows 20 a minute). Each phrase goes with the text before it, so sentences
  continue in the same style. If a phrase fails (say, a rate limit), it's kept and sent with the rest when you
  stop. Turn off **Type at each pause** to send everything in one request when you stop.
- **Language:** detected by the service by default; pick yours in settings if short sentences come out wrong.
- **Why not Claude Code's `/voice`?** It only works in a terminal: it records there and uses Anthropic's speech
  service through your Claude login, which plugins can't reach.
- **Microphone access:** if Obsidian can't use the mic, allow it in your system settings (Windows: Privacy &
  security → Microphone → let desktop apps use it; macOS: Privacy & Security → Microphone → Obsidian).

## Safety and privacy

- The plugin's server listens on `127.0.0.1` only. It requires a token and rejects browser requests.
- Claude Code can read and edit files and run commands in your vault folder, depending on the permission mode.
  Start with *Ask before edits*. Don't use *Bypass permissions* on a vault you care about.
- Your messages, the context block and anything Claude reads go to Anthropic through Claude Code, under your own
  account. That's the same as using Claude Code in a terminal.
- With voice input on, your recordings go to the speech-to-text endpoint you set (Groq by default).

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

More detail: `CLAUDE.md` (architecture and decisions), `docs/module-api.md`, `docs/testing.md` and
`docs/releasing.md`. The original plan is in `docs/BRIEF.md`.

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

Releasing a new version (also what BRAT users receive): see [`docs/releasing.md`](docs/releasing.md). In short,
`npm version patch` then `git push --follow-tags`.

### Modules from other plugins

```ts
const cw = app.plugins.plugins["claude-workspace"]?.api;
const dispose = cw?.registerModule({
  id: "mymod",
  name: "My module",
  // Optional: the plugin it is for (its manifest id) and the lowest version it works with.
  plugin: { id: "my-plugin", minVersion: "1.2.0" },
  onload(ctx) { /* ctx.registerTool(…) */ },
});
```

A module with `plugin` loads only while that plugin is enabled and recent enough, and the settings tab lists it
under the plugin's name, next to the plugin's CLI module if it has one.

## Credits

[Claudian](https://github.com/YishenTu/claudian) (MIT) inspired this plugin. A few patterns follow it and were
reimplemented here: Windows CLI detection, and spawning the SDK inside Electron. The differences:
- Context is re-read on every message and injected by a Claude Code hook.
- Obsidian tools go through a local MCP server, so terminal `claude` gets them too.
- Features are modules.

## License

[MIT](LICENSE). The software is provided "as is", without warranty of any kind.
