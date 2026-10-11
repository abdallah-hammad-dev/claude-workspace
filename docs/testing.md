# Manual test checklist

Automated: `npm test && npm run lint && npm run build` must pass before each checklist.

Setup (Windows Obsidian, building in WSL):

```sh
TEST_VAULT=/mnt/c/Users/abdal/Documents/cw-test-vault npm run deploy
```

Open `C:\Users\abdal\Documents\cw-test-vault` in Obsidian ("Open folder as vault"), trust the author, enable
**Claude Workspace**. Open the developer console (Ctrl+Shift+I) to watch for errors.

## M0 — Skeleton

- [ ] Plugin enables with no console errors.
- [ ] Settings → Claude Workspace lists **Hello (example module)**, toggle off.
- [ ] Toggle Hello on → a "Hello" settings section appears; command palette has "Claude Workspace: Hello: say hello"
      and it shows a notice.
- [ ] Change the greeting, run the command again → the notice uses the new greeting.
- [ ] Toggle Hello off → the settings section and the command disappear (no reload needed).
- [ ] Disable and re-enable the plugin → the Hello toggle state and greeting persisted.
- [ ] Console: `app.plugins.plugins["claude-workspace"].api.registerModule({id:"ext",name:"Ext",onload(c){c.registerCommand({id:"x",name:"Ext: x",callback(){new Notice("ext")}})}})`
      → "Ext" appears in settings and its command works; calling the returned function removes both.

## M1 — Context + MCP server + installer

Automated: `npm test` (renderer, installer merge, MCP over HTTP, auth) and `npm run test:e2e` (real CLI).

- [ ] Settings → Claude Workspace → "Local server" says *Listening on 127.0.0.1:<port>*.
- [ ] Click **Install** → notice lists the files; status turns ✅. Check `.mcp.json` and `.claude/settings.json`
      in the vault (merged, not overwritten, if they existed).
- [ ] In **Windows Terminal / PowerShell** (not WSL — NAT networking), `cd` into the test vault, run `claude`.
      `/mcp` shows `obsidian` connected with `obsidian_get_active_context`, `obsidian_open_file`.
- [ ] Open `Projects/Alpha.md` in Obsidian, ask "which note am I in?" → Alpha. Switch to Beta, ask again → Beta.
- [ ] Select lines in Alpha, ask "what did I select?" → quotes it with line numbers, without reading the file.
- [ ] "Open Welcome.md in Obsidian" → it opens.
- [ ] Close Obsidian, send a prompt in the terminal → still works (hook fails open), no context.

## M3/M4 — Chat view

- [ ] Ribbon bot icon / "Claude Workspace: Open chat" opens the chat in the right sidebar.
- [ ] Before install, a banner offers **Install**; after it, the banner disappears.
- [ ] Chips under the input follow the focused note, cursor line and selection — also while the chat has focus.
- [ ] Send "which note am I in?" → answer streams; your message shows chips + "context sent" (expand: exact block).
- [ ] Ask Claude to edit a note (mode "Ask before edits") → permission modal with a diff; Allow once / Deny work.
      The tool block in the transcript shows the diff and "Open file".
- [ ] Mode "Plan" → plan modal with Approve / Keep planning.
- [ ] Stop button (or Esc) interrupts a long answer.
- [ ] `@` opens a file picker and inserts `@path`.
- [ ] Paste an image → thumbnail; Claude can describe it.
- [ ] Model and mode pickers apply mid-conversation; usage shows tokens / context window and cost.
- [ ] History button lists sessions (including ones started with `claude` in a terminal in this vault) and resumes.
- [ ] Reload Obsidian → the chat reopens the same conversation.
- [ ] `/compact`, `/cost` and other slash commands pass through.

## M2 — Excalidraw

Setup: in the test vault install + enable the **Excalidraw** community plugin, then Settings → Claude Workspace →
Modules shows *Excalidraw* loaded (if it says "unavailable", reload the plugin after enabling Excalidraw).
Click **Install** again so the `excalidraw` skill lands in `.claude/skills/`. Create a drawing (`Ctrl+P` →
"Excalidraw: Create new drawing").

- [ ] With the drawing focused, chips show "N elements"; select two shapes → "2 elements selected" (within ~1 s).
- [ ] "What did I select?" → Claude describes the selected shapes from the context, without reading the file.
- [ ] "Draw a three-box architecture: Browser → API → Database" → shapes + labelled arrows appear live, in one batch.
- [ ] Ctrl+Z in Excalidraw undoes the whole batch in one step (**verify — if it takes several steps, note it in CLAUDE.md**).
- [ ] "Make the selected box red and rename it Gateway" → label changes and stays centered.
- [ ] "Delete the database" → the shape, its label and attached arrows disappear.
- [ ] Claude takes `excalidraw_screenshot` after a bigger edit (image appears in the tool block result as `[image]`).
- [ ] "Show me the API box" → it gets selected and zoomed (`excalidraw_focus`).
- [ ] Ask for an impossible edit (unknown id) → tool error lists the problem, drawing unchanged.
- [ ] The `.excalidraw.md` file is never edited directly by Claude while the drawing is open.
