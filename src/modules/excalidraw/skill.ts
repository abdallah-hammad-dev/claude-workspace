/** Installed to `.claude/skills/excalidraw/SKILL.md` by the installer. */
export const EXCALIDRAW_SKILL = `---
name: excalidraw
description: Read and edit Excalidraw drawings that are open in Obsidian, live, through the obsidian MCP tools (excalidraw_get_scene, excalidraw_apply, excalidraw_screenshot, excalidraw_focus). Use whenever the user talks about a drawing, diagram, canvas, shapes or arrows in an .excalidraw.md file, or the context says they are looking at an Excalidraw view.
---

# Editing Excalidraw drawings in Obsidian

The drawing is edited **live** in the user's Obsidian window through the Excalidraw plugin.
Never edit the \`.excalidraw.md\` file while it is open (it is often compressed, and the open view
would overwrite your changes). If the drawing isn't open, open it with \`obsidian_open_file\`.

## Workflow

1. **Read first.** Call \`excalidraw_get_scene\` (or \`selectedOnly: true\` when the user says "this",
   "these", "the selected…"). Use the returned ids and coordinates; don't guess them.
2. **Plan a layout on a grid.** Keep shapes aligned: e.g. columns every 220 px, rows every 120 px,
   default box 160×70. Place new things next to existing ones, not on top of them.
3. **Apply in one call.** Send all ops to \`excalidraw_apply\` at once. Give new shapes a \`ref\`
   and use it in \`connect\` / \`update\` later in the same list:
   \`\`\`json
   [
     {"op": "add_shape", "ref": "api", "x": 0,   "y": 0, "text": "API"},
     {"op": "add_shape", "ref": "db",  "x": 220, "y": 0, "text": "Database", "shape": "ellipse"},
     {"op": "connect", "from": "api", "to": "db", "text": "SQL"}
   ]
   \`\`\`
   The list is validated before anything changes; if it fails, fix every reported problem and resend.
4. **Check.** After non-trivial edits call \`excalidraw_screenshot\` and fix overlaps or unreadable labels.
5. **Show.** Use \`excalidraw_focus\` with ids to select and zoom to what you changed or are talking about.

## Notes

- Labels: \`text\` on \`add_shape\` / \`connect\` creates a centered, bound label. \`update\` with \`text\`
  changes the label of a shape or arrow.
- Moving a shape with \`update\` moves its label; attached arrows may need to be reconnected
  (delete the arrow and \`connect\` again).
- \`delete\` removes labels and, unless \`withArrows: false\`, arrows attached to the deleted elements.
- Colors: use Excalidraw's palette, e.g. stroke \`#1971c2\` (blue), \`#2f9e44\` (green), \`#e03131\` (red),
  backgrounds \`#a5d8ff\`, \`#b2f2bb\`, \`#ffc9c9\`, \`#ffec99\`.
- Links: \`link: "[[Note name]]"\` makes a shape open a note when clicked.
- The user can undo your edit with Ctrl/Cmd+Z in Excalidraw.
`;
