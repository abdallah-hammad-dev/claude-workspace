import { describe, expect, it } from "vitest";
import { isInstalled, isOurHook, mcpAddCommand, mergeClaudeSettings, mergeMcpJson } from "../src/desktop/installer-merge";

const t = { serverName: "obsidian", port: 27500, token: "abc" };

describe("mergeMcpJson", () => {
  it("adds our server and keeps others", () => {
    const out = mergeMcpJson({ mcpServers: { other: { command: "x" } }, extra: 1 }, t);
    expect(out).toEqual({
      extra: 1,
      mcpServers: {
        other: { command: "x" },
        obsidian: { type: "http", url: "http://127.0.0.1:27500/mcp", headers: { Authorization: "Bearer abc" } },
      },
    });
  });

  it("handles a missing or weird file", () => {
    expect(mergeMcpJson(undefined, t).mcpServers).toHaveProperty("obsidian");
    expect(mergeMcpJson([], t).mcpServers).toHaveProperty("obsidian");
  });
});

describe("mergeClaudeSettings", () => {
  it("adds the server approval and the HTTP hook, keeping unrelated settings", () => {
    const out = mergeClaudeSettings(
      { permissions: { allow: ["Read"] }, enabledMcpjsonServers: ["x"], hooks: { Stop: [{ hooks: [] }] } },
      t,
    );
    expect(out.permissions).toEqual({ allow: ["Read"] });
    expect(out.enabledMcpjsonServers).toEqual(["x", "obsidian"]);
    expect((out.hooks as Record<string, unknown>).Stop).toEqual([{ hooks: [] }]);
    expect((out.hooks as Record<string, unknown>).UserPromptSubmit).toEqual([
      {
        hooks: [
          { type: "http", url: "http://127.0.0.1:27500/context", headers: { Authorization: "Bearer abc" }, timeout: 3 },
        ],
      },
    ]);
  });

  it("replaces previous versions of our hook (old port, prototype curl hook) but keeps the user's", () => {
    const userHook = { type: "command", command: "echo hi" };
    const existing = {
      enabledMcpjsonServers: ["obsidian"],
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: 'curl -s -m 2 -H "Authorization: Bearer old" http://127.0.0.1:27200/context' }] },
          { hooks: [userHook, { type: "http", url: "http://127.0.0.1:27111/context" }] },
        ],
      },
    };
    const out = mergeClaudeSettings(existing, t);
    const groups = (out.hooks as { UserPromptSubmit: { hooks: unknown[] }[] }).UserPromptSubmit;
    expect(groups).toHaveLength(2);
    expect(groups[0]!.hooks).toEqual([userHook]);
    expect(out.enabledMcpjsonServers).toEqual(["obsidian"]);
  });

  it("is idempotent", () => {
    const once = mergeClaudeSettings({}, t);
    expect(mergeClaudeSettings(once, t)).toEqual(once);
  });
});

describe("isInstalled / isOurHook / mcpAddCommand", () => {
  it("detects a matching install and a stale token", () => {
    const mcp = mergeMcpJson({}, t);
    const settings = mergeClaudeSettings({}, t);
    expect(isInstalled(mcp, settings, t)).toBe(true);
    expect(isInstalled(mcp, settings, { ...t, token: "new" })).toBe(false);
    expect(isInstalled({}, settings, t)).toBe(false);
  });

  it("recognizes only localhost /context hooks", () => {
    expect(isOurHook({ url: "http://127.0.0.1:1/context" })).toBe(true);
    expect(isOurHook({ url: "https://example.com/context" })).toBe(false);
    expect(isOurHook({ command: "echo" })).toBe(false);
  });

  it("builds the user-scope command", () => {
    expect(mcpAddCommand(t)).toBe(
      'claude mcp add --scope user --transport http obsidian http://127.0.0.1:27500/mcp --header "Authorization: Bearer abc"',
    );
  });
});
