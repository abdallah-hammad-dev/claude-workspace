import { describe, expect, it } from "vitest";
import { capText, renderContext } from "../src/core/context/render";
import { toVaultPath } from "../src/core/paths";
import { renderMarkdown } from "../src/modules/markdown";

const none = () => undefined;

describe("renderContext", () => {
  it("renders the active file, provider lines and other tabs", () => {
    const text = renderContext(
      {
        activeFile: { path: "Projects/Olera.md", viewType: "markdown" },
        mode: "source",
        providers: { "markdown.editor": { cursor: { line: 42, ch: 0 } } },
        openTabs: [
          { path: "Projects/Olera.md", viewType: "markdown" },
          { path: "Inbox.md", viewType: "markdown" },
          { path: "Inbox.md", viewType: "markdown" },
        ],
      },
      (key) => (key === "markdown.editor" ? () => ["Cursor at line 42."] : undefined),
    );
    expect(text).toBe(
      [
        "<obsidian_context>",
        "The user is currently looking at: Projects/Olera.md (view: markdown, mode: source).",
        '"This file", "this note", "this drawing", "here" refer to it.',
        "Cursor at line 42.",
        "Other open tabs: Inbox.md",
        "</obsidian_context>",
      ].join("\n"),
    );
  });

  it("is empty when nothing is open", () => {
    expect(renderContext({ activeFile: null, providers: {}, openTabs: [] }, none)).toBe("");
  });

  it("still lists tabs when no file is focused", () => {
    const text = renderContext({ activeFile: null, providers: {}, openTabs: [{ path: "A.md", viewType: "markdown" }] }, none);
    expect(text).toContain("No file is focused");
    expect(text).toContain("Other open tabs: A.md");
  });

  it("reports provider errors and render exceptions instead of throwing", () => {
    const text = renderContext(
      {
        activeFile: { path: "D.excalidraw.md", viewType: "excalidraw" },
        providers: { "excalidraw.scene": { error: "plugin not loaded" }, "x.y": { a: 1 } },
        openTabs: [],
      },
      () => () => {
        throw new Error("bad render");
      },
    );
    expect(text).toContain("(context from excalidraw.scene unavailable: plugin not loaded)");
    expect(text).toContain("(context from x.y unavailable: bad render)");
  });
});

describe("markdown provider rendering", () => {
  it("renders cursor with section and a bounded selection", () => {
    expect(
      renderMarkdown({
        cursor: { line: 12, ch: 3 },
        section: ["Alpha", "Notes"],
        selection: { fromLine: 11, toLine: 12, text: "Select this", truncated: false },
      }),
    ).toEqual([
      "Cursor at line 12 (section: Alpha › Notes).",
      '<selected_text lines="11-12">',
      "Select this",
      "</selected_text>",
    ]);
  });

  it("marks truncated selections", () => {
    const { text, truncated } = capText("x".repeat(7000));
    expect(text).toHaveLength(6000);
    expect(renderMarkdown({ selection: { text, truncated } }).join("\n")).toContain("…[truncated]");
  });
});

describe("toVaultPath", () => {
  it("handles relative, ./ and leading slash on Windows vaults", () => {
    expect(toVaultPath("Projects/A.md", "C:\\Users\\me\\vault")).toBe("Projects/A.md");
    expect(toVaultPath("./Projects/A.md", "C:\\Users\\me\\vault")).toBe("Projects/A.md");
    expect(toVaultPath("Projects\\A.md", "C:\\Users\\me\\vault")).toBe("Projects/A.md");
    expect(toVaultPath("/Projects/A.md", "C:\\Users\\me\\vault")).toBe("Projects/A.md");
  });

  it("strips the vault prefix from absolute paths (case-insensitive on Windows)", () => {
    expect(toVaultPath("c:\\users\\ME\\vault\\Projects\\A.md", "C:\\Users\\me\\vault")).toBe("Projects/A.md");
    expect(toVaultPath("/home/me/vault/Projects/A.md", "/home/me/vault")).toBe("Projects/A.md");
    expect(toVaultPath("/home/me/vault", "/home/me/vault")).toBe("");
  });

  it("rejects paths outside the vault", () => {
    expect(toVaultPath("D:\\other\\A.md", "C:\\Users\\me\\vault")).toBeNull();
    expect(toVaultPath("/etc/passwd", "/home/me/vault")).toBeNull();
    expect(toVaultPath("../secret.md", "/home/me/vault")).toBeNull();
    expect(toVaultPath("/home/me/vault2/A.md", "/home/me/vault")).toBeNull();
  });
});
