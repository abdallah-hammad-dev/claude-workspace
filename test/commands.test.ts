import { describe, expect, it } from "vitest";
import { isBlocked, obsidianCommands, searchCommands } from "../src/modules/commands/registry";

const all = [
  { id: "daily-notes:goto-today", name: "Daily notes: Open today's daily note" },
  { id: "editor:toggle-bold", name: "Toggle bold" },
  { id: "templater-obsidian:insert-templater", name: "Templater: Open insert template modal" },
];

describe("commands registry adapter", () => {
  it("returns null when the internal API is missing", () => {
    expect(obsidianCommands({} as never)).toBeNull();
    expect(obsidianCommands({ commands: { commands: {} } } as never)).toBeNull();
  });

  it("lists and runs through app.commands", () => {
    const ran: string[] = [];
    const app = {
      commands: {
        commands: Object.fromEntries(all.map((c) => [c.id, c])),
        executeCommandById(id: string) {
          ran.push(id);
          return id !== "editor:toggle-bold";
        },
      },
    };
    const r = obsidianCommands(app as never)!;
    expect(r.list()).toHaveLength(3);
    expect(r.exists("editor:toggle-bold")).toBe(true);
    expect(r.run("daily-notes:goto-today")).toBe(true);
    expect(r.run("editor:toggle-bold")).toBe(false);
    expect(ran).toEqual(["daily-notes:goto-today", "editor:toggle-bold"]);
  });
});

describe("searchCommands", () => {
  it("matches every word against id and name, case-insensitively, sorted by name", () => {
    expect(searchCommands(all, "DAILY today").map((c) => c.id)).toEqual(["daily-notes:goto-today"]);
    expect(searchCommands(all, "templater").map((c) => c.id)).toEqual(["templater-obsidian:insert-templater"]);
    expect(searchCommands(all, undefined).map((c) => c.name)).toEqual([
      "Daily notes: Open today's daily note",
      "Templater: Open insert template modal",
      "Toggle bold",
    ]);
  });
});

describe("isBlocked", () => {
  it("supports exact ids and * prefixes, ignores blank lines", () => {
    const list = ["app:reload", "claude-workspace:*", "  ", ""];
    expect(isBlocked("app:reload", list)).toBe(true);
    expect(isBlocked("app:reload-extra", list)).toBe(false);
    expect(isBlocked("claude-workspace:open-chat", list)).toBe(true);
    expect(isBlocked("editor:toggle-bold", list)).toBe(false);
  });
});
