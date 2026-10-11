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

Visual check first: `npm run ui:preview` and look at `tools/ui-preview/out/` (light + dark).

- [ ] Ribbon bot icon / status-bar "✳ Claude" / "Claude Workspace: Open chat" open the chat in the right sidebar.
- [ ] Empty state shows suggestions that match the focused view (note vs drawing); clicking one fills the input.
- [ ] Before install, a "Connect this vault" banner offers **Install**; after it, the banner disappears.
- [ ] The context chip in the composer follows the focused note, cursor line and selection, also while the chat
      has focus. Clicking it previews the exact `<obsidian_context>` text.
- [ ] Send "which note am I in?" → answer streams; your message is a tinted bubble with an eye pill under it;
      clicking the pill shows exactly what was sent.
- [ ] Type `/` → command list (built-ins, your skills) appears within ~1 s; arrows + Enter/Tab pick; Esc closes.
      `/compact`, `/context`, `/cost` run; `/clear` starts a new conversation.
- [ ] Type `@al` → file list (recent first); picking inserts `@path`.
- [ ] Ask Claude to edit a note ("Ask before edits") → inline card above the composer: title names the file,
      diff below, **Allow / Deny**, "Allow all edits for this conversation". Esc denies.
- [ ] While the card is shown, type "use a bullet list instead" + Enter → denied with that message, shown as an
      "Instead" bubble; Claude adapts.
- [ ] Bash permission shows the command in the body and the "Always allow `cmd …` commands in this vault" option.
- [ ] Mode "Plan" → plan card with "Yes, and accept edits" / "Yes, ask before each edit" / "Keep planning";
      approving switches the mode button accordingly.
- [ ] AskUserQuestion → question card with option buttons + "Something else…".
- [ ] With the chat panel hidden, a permission request shows a notice; clicking it reveals the panel.
- [ ] Stop button (square) or Esc interrupts a long answer; "Claude is working" dots show while busy.
- [ ] Paste an image → thumbnail with a remove button; Claude can describe it.
- [ ] Mode and model menus open upwards with descriptions; changes apply mid-conversation. Usage ring shows the
      context share; tooltip shows tokens and cost.
- [ ] History button lists conversations (including terminal ones in this vault) with relative dates and resumes.
- [ ] Reload Obsidian → the chat reopens the same conversation.

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

## Obsidian commands module + module contents in settings

- [ ] Settings: Connection status card (Claude Code / Local server / This vault) on top; each module is one card
      with its toggle, "What it adds" (loaded modules only) and its own settings inside the card.
- [ ] "Open today's daily note" → Claude calls `commands_list` then `commands_run` (`daily-notes:goto-today`);
      the note opens in the main area and the chat input keeps focus.
- [ ] With a note focused and the chat focused: "make the selected text bold using the command" → applies to the note.
- [ ] Editor command while a drawing is focused → `ran: false`, Claude explains instead of retrying.
- [ ] "Reload Obsidian" → refused (blocked); edit the blocklist in settings and it takes effect immediately.
