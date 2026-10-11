import { describe, expect, it } from "vitest";
import { parseLocalCommand } from "../src/desktop/chat/local-commands";
import { relativeTime } from "../src/desktop/chat/modals";
import { filterCommands, filterFiles, mentionQuery, slashQuery } from "../src/desktop/chat/suggest";
import { describeSuggestions, permissionAsk, relPath } from "../src/desktop/chat/tool-render";

const VAULT = "C:\\Users\\me\\vault";

describe("slash and mention detection", () => {
  it("detects a slash command only at the start of the message", () => {
    expect(slashQuery("/co", 3)).toBe("co");
    expect(slashQuery("/", 1)).toBe("");
    expect(slashQuery("/compact now", 12)).toBeNull();
    expect(slashQuery("say /co", 7)).toBeNull();
  });

  it("detects the @mention under the cursor", () => {
    expect(mentionQuery("compare with @al", 16)).toEqual({ query: "al", start: 13 });
    expect(mentionQuery("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionQuery("mail me@example.com", 19)).toBeNull();
    expect(mentionQuery("@done and more", 14)).toBeNull();
  });
});

describe("parseLocalCommand", () => {
  it("handles /effort, /model and bare /clear locally", () => {
    expect(parseLocalCommand("/effort")).toEqual({ kind: "effort", level: null, arg: "" });
    expect(parseLocalCommand("/effort High")).toEqual({ kind: "effort", level: "high", arg: "High" });
    expect(parseLocalCommand("/effort extra high")).toEqual({ kind: "effort", level: "xhigh", arg: "extra high" });
    expect(parseLocalCommand("/effort auto")).toEqual({ kind: "effort", level: "", arg: "auto" });
    expect(parseLocalCommand("/effort turbo")).toEqual({ kind: "effort", level: null, arg: "turbo" });
    expect(parseLocalCommand("/model")).toEqual({ kind: "model", arg: "" });
    expect(parseLocalCommand("/model sonnet ")).toEqual({ kind: "model", arg: "sonnet" });
    expect(parseLocalCommand("/clear")).toEqual({ kind: "clear" });
  });

  it("passes everything else through to Claude Code", () => {
    expect(parseLocalCommand("/clear my-name")).toBeNull();
    expect(parseLocalCommand("/efforts")).toBeNull();
    expect(parseLocalCommand("/compact")).toBeNull();
    expect(parseLocalCommand("set /effort high")).toBeNull();
  });
});

describe("filterCommands", () => {
  const cmds = [
    { name: "compact", description: "Free up context", builtin: true },
    { name: "context", description: "Show context usage", builtin: true },
    { name: "cost", description: "Show cost", aliases: ["usage"], builtin: true },
    { name: "excalidraw", description: "Edit drawings, compact layout" },
    { name: "compact", description: "user override" },
  ];

  it("ranks prefix, then substring, then description matches; one row per name (built-in wins)", () => {
    expect(filterCommands(cmds, "co").map((c) => c.name)).toEqual(["compact", "context", "cost"]);
    expect(filterCommands(cmds, "co")[0]!.description).toBe("Free up context");
    expect(filterCommands(cmds, "draw").map((c) => c.name)).toEqual(["excalidraw"]);
    expect(filterCommands(cmds, "layout").map((c) => c.name)).toEqual(["excalidraw"]);
  });

  it("matches aliases before descriptions", () => {
    expect(filterCommands(cmds, "usa").map((c) => c.name)).toEqual(["cost", "context"]);
  });
});

describe("filterFiles", () => {
  const paths = ["Projects/Alpha.md", "Projects/Beta.md", "Archive/alpha-old.md", "Welcome.md"];

  it("puts recent files first for an empty query", () => {
    expect(filterFiles(paths, "", ["Welcome.md"])).toEqual(["Welcome.md", "Archive/alpha-old.md", "Projects/Alpha.md", "Projects/Beta.md"]);
  });

  it("prefers basename prefix matches, then shorter paths", () => {
    expect(filterFiles(paths, "al")).toEqual(["Projects/Alpha.md", "Archive/alpha-old.md"]);
    expect(filterFiles(paths, "proj")).toEqual(["Projects/Beta.md", "Projects/Alpha.md"]);
  });
});

describe("permission wording", () => {
  it("phrases common tools in plain words", () => {
    expect(permissionAsk("Edit", { file_path: `${VAULT}\\Projects\\Alpha.md` }, VAULT)).toMatchObject({ verb: "edit", target: "Projects/Alpha.md" });
    expect(permissionAsk("Bash", { command: "ls" })).toMatchObject({ verb: "run", target: "ls" });
    expect(permissionAsk("mcp__obsidian__excalidraw_apply", { ops: [] })).toMatchObject({ verb: "edit the open drawing", target: "" });
    expect(permissionAsk("mcp__obsidian__commands_run", { id: "daily-notes:goto-today" })).toMatchObject({ target: "daily-notes:goto-today" });
    expect(permissionAsk("mcp__github__create_issue", {})).toMatchObject({ verb: "use github's tool", target: "create_issue" });
  });

  it("describes always-allow suggestions", () => {
    expect(describeSuggestions([{ type: "setMode", mode: "acceptEdits", destination: "session" }])).toBe("Allow all edits for this conversation");
    expect(
      describeSuggestions([{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "localSettings" }]),
    ).toBe("Always allow `npm test …` commands in this vault");
    expect(
      describeSuggestions([{ type: "addRules", rules: [{ toolName: "mcp__obsidian__excalidraw_apply" }], behavior: "allow", destination: "userSettings" }]),
    ).toBe("Always allow excalidraw_apply everywhere");
    expect(
      describeSuggestions([
        { type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow", destination: "session" },
        { type: "addDirectories", directories: ["/tmp"], destination: "session" },
      ]),
    ).toBe("Always allow fetching from example.com for this conversation (+1 more)");
  });

  it("makes paths vault-relative", () => {
    expect(relPath("c:\\users\\me\\vault\\A.md", VAULT)).toBe("A.md");
    expect(relPath("/etc/hosts", VAULT)).toBe("/etc/hosts");
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);
  it("formats recent times", () => {
    expect(relativeTime(now - 20_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 2 * 86400_000, now)).toBe("2 days ago");
  });
});
