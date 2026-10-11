import { Setting } from "obsidian";
import { z } from "zod";
import { ToolError, type WorkspaceModule } from "../../core/module-api";
import { DEFAULT_BLOCKLIST, isBlocked, obsidianCommands, searchCommands } from "./registry";

const DEFAULT_LIMIT = 40;

const SKILL = `---
name: obsidian-commands
description: Run Obsidian commands (core features and any installed plugin) through the obsidian MCP tools commands_list and commands_run. Use when the user asks Obsidian, or a plugin without a dedicated tool (Templater, Dataview, Daily notes, Excalidraw…), to do something it has a command for, or says "run the … command".
---

# Running Obsidian commands

Every action in Obsidian's command palette (Ctrl/Cmd+P) can be run with \`commands_run\`.

1. Find the id with \`commands_list\` and a short query (\`"daily note"\`, \`"templater"\`, \`"fold"\`).
   Ids look like \`plugin-id:command\` (\`daily-notes:goto-today\`, \`editor:toggle-bold\`).
2. Run it with \`commands_run\`. It runs against the note or drawing the user is working in
   (the one in <obsidian_context>), exactly as if they used the palette there.
3. \`ran: false\` means the command isn't available in that view (e.g. an editor command while
   a drawing is focused). Say so instead of retrying.

Prefer a dedicated tool when one exists (e.g. excalidraw_* for drawings) and plain file edits
for changing note text. Use commands for things only the app can do: open today's daily note,
insert a template, toggle a view, trigger a plugin's action. Some commands open a dialog for the
user (e.g. a template picker) — tell them to complete it.
`;

/** Generic access to Obsidian's command palette: any plugin becomes usable without its own module. */
export const commandsModule: WorkspaceModule = {
  id: "commands",
  name: "Obsidian commands",
  description: "Lets Claude list and run command-palette commands (core and other plugins). Uses an undocumented Obsidian API.",
  isAvailable: (app) => obsidianCommands(app) !== null,

  onload(ctx) {
    const settings = ctx.loadData({ blocklist: DEFAULT_BLOCKLIST.join("\n") });
    const blocklist = () => settings.blocklist.split("\n");
    const registry = () => {
      const r = obsidianCommands(ctx.app);
      if (!r) throw new ToolError("Obsidian's command registry isn't reachable in this Obsidian version.");
      return r;
    };

    ctx.registerTool({
      name: "commands_list",
      title: "Search Obsidian commands",
      description:
        "Search the command palette (core Obsidian and every enabled plugin). Returns ids to pass to commands_run. " +
        "Use a short query; omit it to list everything (truncated to `limit`).",
      inputSchema: {
        query: z.string().optional().describe('Words to match in the id or name, e.g. "daily note"'),
        limit: z.number().int().min(1).max(500).optional().describe(`Default ${DEFAULT_LIMIT}`),
      },
      annotations: { readOnlyHint: true },
      handler: async ({ query, limit }) => {
        const all = registry().list();
        const hits = searchCommands(all, query).filter((c) => !isBlocked(c.id, blocklist()));
        const max = limit ?? DEFAULT_LIMIT;
        return { total: hits.length, shown: Math.min(max, hits.length), commands: hits.slice(0, max) };
      },
    });

    ctx.registerTool({
      name: "commands_run",
      title: "Run an Obsidian command",
      description:
        "Run a command-palette command by id (from commands_list), in the note or drawing the user is working in. " +
        "Returns ran: false if the command isn't available there.",
      inputSchema: { id: z.string().describe("Command id, e.g. daily-notes:goto-today") },
      annotations: { destructiveHint: true, openWorldHint: false },
      handler: async ({ id }) => {
        const r = registry();
        if (isBlocked(id, blocklist())) {
          throw new ToolError(`"${id}" is blocked in Claude Workspace settings (Obsidian commands → blocked commands). Ask the user to run it.`);
        }
        if (!r.exists(id)) throw new ToolError(`No command "${id}". Find the right id with commands_list.`);

        // Focus the user's working view first: with the chat focused, editor commands would have no target.
        const view = ctx.getActiveView();
        const previousFocus = activeDocument.activeElement;
        if (view) ctx.app.workspace.setActiveLeaf(view.leaf, { focus: true });
        const ran = r.run(id);
        // Give keyboard focus back (e.g. to the chat input), unless the command opened a dialog for the user.
        window.setTimeout(() => {
          const dialogOpen = !!activeDocument.querySelector(".modal-container, .prompt");
          if (!dialogOpen && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        }, 50);
        ctx.notifyContextChanged();
        const target = (view as { file?: { path: string } } | null)?.file?.path ?? null;
        return ran
          ? { ran: true, id, target }
          : { ran: false, id, target, reason: "The command exists but isn't available in the current view." };
      },
    });

    ctx.registerSettings({
      title: "Obsidian commands",
      display: (el) => {
        new Setting(el)
          .setName("Blocked commands")
          .setDesc("Claude can't list or run these. One id per line; a trailing * matches a prefix (e.g. app:*).")
          .addTextArea((t) => {
            t.inputEl.rows = 6;
            t.setValue(settings.blocklist).onChange(async (v) => {
              settings.blocklist = v;
              await ctx.saveData(settings);
            });
          });
      },
    });

    ctx.registerSkill({ name: "obsidian-commands", markdown: SKILL });
  },
};
