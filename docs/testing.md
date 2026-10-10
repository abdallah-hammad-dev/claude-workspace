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
