import { describe, expect, it } from "vitest";
import type { App, DataAdapter } from "obsidian";
import { Installer } from "../src/desktop/Installer";
import {
  composeSkill,
  descriptionProblem,
  INSTALLED_MARKER,
  isInstalledSkill,
  markInstalled,
  parseSkill,
  skillNameProblem,
  SkillStore,
} from "../src/desktop/skills";

/** In-memory vault adapter: files by path, folders as a set. */
function memoryAdapter(files: Record<string, string> = {}) {
  const data = new Map(Object.entries(files));
  const dirs = new Set<string>();
  for (const p of data.keys()) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
  const trashed: string[] = [];
  const fs = {
    exists: async (p: string) => data.has(p) || dirs.has(p),
    read: async (p: string) => data.get(p) ?? "",
    write: async (p: string, text: string) => void data.set(p, text),
    mkdir: async (p: string) => void dirs.add(p),
    list: async (p: string) => ({
      files: [...data.keys()].filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes("/")),
      folders: [...dirs].filter((d) => d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes("/")),
    }),
    rename: async (from: string, to: string) => {
      for (const [k, v] of [...data]) {
        if (!k.startsWith(`${from}/`)) continue;
        data.delete(k);
        data.set(to + k.slice(from.length), v);
      }
      for (const d of [...dirs]) {
        if (d !== from && !d.startsWith(`${from}/`)) continue;
        dirs.delete(d);
        dirs.add(to + d.slice(from.length));
      }
    },
    trashSystem: async (p: string) => {
      trashed.push(p);
      for (const k of [...data.keys()]) if (k.startsWith(`${p}/`)) data.delete(k);
      dirs.delete(p);
      return true;
    },
    trashLocal: async () => undefined,
  };
  return { fs: fs as unknown as DataAdapter, data, trashed };
}

const MODULE_SKILL = "---\nname: drawing\ndescription: Edit drawings.\n---\n\n# Drawings\n\nUse the tools.\n";

describe("skill files", () => {
  it("reads the frontmatter and instructions, keeping other keys", () => {
    const s = parseSkill("review", '---\nname: review\ndescription: "Weekly review: plan the next week."\nmodel: sonnet\n---\n\n1. List the notes.\n');
    expect(s).toEqual({ name: "review", description: "Weekly review: plan the next week.", body: "1. List the notes.\n", extra: { model: "sonnet" } });
    expect(composeSkill({ ...s, description: "Changed" })).toBe('---\nname: "review"\ndescription: "Changed"\nmodel: "sonnet"\n---\n\n1. List the notes.\n');
  });

  it("names a skill without frontmatter after its folder", () => {
    expect(parseSkill("notes", "Just text\n")).toMatchObject({ name: "notes", description: "", body: "Just text\n" });
  });

  it("puts the installed mark after the frontmatter and leaves it out of the instructions", () => {
    const marked = markInstalled(MODULE_SKILL);
    expect(marked).toBe(`---\nname: drawing\ndescription: Edit drawings.\n---\n${INSTALLED_MARKER}\n\n# Drawings\n\nUse the tools.\n`);
    expect(isInstalledSkill(marked)).toBe(true);
    expect(isInstalledSkill(MODULE_SKILL)).toBe(false);
    expect(parseSkill("drawing", marked).body).toBe("# Drawings\n\nUse the tools.\n");
  });

  it("checks names and descriptions like Agent Skills do", () => {
    const taken = (n: string) => n === "excalidraw";
    expect(skillNameProblem("weekly-review", taken)).toBeNull();
    expect(skillNameProblem("", taken)).toMatch(/name/);
    for (const bad of ["Weekly", "two  words", "-lead", "trail-", "a--b", "a_b", "x".repeat(65)]) expect(skillNameProblem(bad, taken)).not.toBeNull();
    expect(skillNameProblem("excalidraw", taken)).toMatch(/already/);
    expect(descriptionProblem("  ")).not.toBeNull();
    expect(descriptionProblem("x".repeat(1025))).not.toBeNull();
    expect(descriptionProblem("Use for reviews.")).toBeNull();
  });
});

describe("SkillStore", () => {
  it("lists skill folders that have a SKILL.md, renames with the folder's other files, trashes", async () => {
    const { fs, data, trashed } = memoryAdapter({
      ".claude/skills/b/SKILL.md": "B",
      ".claude/skills/a/SKILL.md": "A",
      ".claude/skills/a/ref.md": "ref",
      ".claude/skills/empty/notes.txt": "",
    });
    const store = new SkillStore(fs);
    expect(await store.list()).toEqual([
      { name: "a", markdown: "A" },
      { name: "b", markdown: "B" },
    ]);
    await store.write("c", "C", "a");
    expect(data.get(".claude/skills/c/SKILL.md")).toBe("C");
    expect(data.get(".claude/skills/c/ref.md")).toBe("ref");
    expect(data.has(".claude/skills/a/SKILL.md")).toBe(false);
    await store.trash("b");
    expect(trashed).toEqual([".claude/skills/b"]);
    expect((await store.list()).map((s) => s.name)).toEqual(["c"]);
  });
});

describe("Installer.writeSkills", () => {
  const installer = (files: Record<string, string>) => {
    const m = memoryAdapter(files);
    return { ...m, installer: new Installer({ vault: { adapter: m.fs } } as unknown as App) };
  };
  const file = ".claude/skills/drawing/SKILL.md";

  it("writes a module skill marked as installed, then leaves it alone", async () => {
    const { installer: i, data } = installer({});
    expect(await i.writeSkills([{ name: "drawing", markdown: MODULE_SKILL }])).toEqual({ written: [file], kept: [] });
    expect(data.get(file)).toBe(markInstalled(MODULE_SKILL));
    expect(await i.writeSkills([{ name: "drawing", markdown: MODULE_SKILL }])).toEqual({ written: [], kept: [] });
  });

  it("marks a copy written before the mark existed, and overwrites a marked one that was edited", async () => {
    for (const before of [MODULE_SKILL, `${markInstalled(MODULE_SKILL)}\nMy addition\n`]) {
      const { installer: i, data } = installer({ [file]: before });
      expect(await i.writeSkills([{ name: "drawing", markdown: MODULE_SKILL }])).toEqual({ written: [file], kept: [] });
      expect(data.get(file)).toBe(markInstalled(MODULE_SKILL));
    }
  });

  it("keeps the user's own skill of the same name", async () => {
    const mine = "---\nname: drawing\ndescription: My way of drawing.\n---\n\nMine.\n";
    const { installer: i, data } = installer({ [file]: mine });
    expect(await i.writeSkills([{ name: "drawing", markdown: MODULE_SKILL }])).toEqual({ written: [], kept: [file] });
    expect(data.get(file)).toBe(mine);
  });
});
