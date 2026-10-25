import { getFrontMatterInfo, parseYaml, stringifyYaml, type DataAdapter } from "obsidian";

/** Claude Code's project skills: `.claude/skills/<name>/SKILL.md`. */
export const SKILLS_DIR = ".claude/skills";

/**
 * Put after the frontmatter of the skills the installer writes for modules. A SKILL.md without it is the user's:
 * the installer never overwrites one, and the settings list it as theirs.
 */
export const INSTALLED_MARKER = "<!-- Installed by Claude Workspace for one of its modules. Installing again overwrites changes made here. -->";

export interface Skill {
  name: string;
  /** When Claude should use it: Claude Code reads it to decide whether to load the skill. */
  description: string;
  /** The instructions, after the frontmatter. */
  body: string;
  /** The frontmatter's other keys (allowed-tools, model…), written back as they are. */
  extra: Record<string, unknown>;
}

export function skillFile(name: string): string {
  return `${SKILLS_DIR}/${name}/SKILL.md`;
}

export function isInstalledSkill(markdown: string): boolean {
  return markdown.includes(INSTALLED_MARKER);
}

/** A module's SKILL.md as the installer writes it: the marker on the line after the frontmatter. */
export function markInstalled(markdown: string): string {
  const fm = getFrontMatterInfo(markdown);
  const at = fm.exists ? fm.contentStart : 0;
  return `${markdown.slice(0, at)}${INSTALLED_MARKER}\n${markdown.slice(at)}`;
}

/** `dirName` is used when the frontmatter has no name, as Claude Code does. Unreadable YAML counts as none. */
export function parseSkill(dirName: string, markdown: string): Skill {
  const fm = getFrontMatterInfo(markdown);
  let data: Record<string, unknown> = {};
  if (fm.exists) {
    try {
      const parsed: unknown = parseYaml(fm.frontmatter);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      // shown with an empty description; saving rewrites the frontmatter
    }
  }
  const { name, description, ...extra } = data;
  const body = (fm.exists ? markdown.slice(fm.contentStart) : markdown).replace(INSTALLED_MARKER, "").replace(/^\s*\n/, "");
  return {
    name: typeof name === "string" && name ? name : dirName,
    description: typeof description === "string" ? description : "",
    body,
    extra,
  };
}

export function composeSkill(s: Skill): string {
  const body = s.body.trim();
  return `---\n${stringifyYaml({ name: s.name, description: s.description.trim(), ...s.extra }).trimEnd()}\n---\n${body ? `\n${body}\n` : ""}`;
}

/** Agent Skills' rules for a name, which is also the folder name. `taken` refuses names already used. */
export function skillNameProblem(name: string, taken: (name: string) => boolean): string | null {
  if (!name) return "Give the skill a name.";
  if (name.length > 64) return "Use at most 64 characters.";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return "Use lowercase letters, digits and single hyphens between words, like weekly-review.";
  if (taken(name)) return `There is already a skill named ${name}.`;
  return null;
}

export function descriptionProblem(description: string): string | null {
  if (!description.trim()) return "Say when Claude should use it: Claude only sees this until it loads the skill.";
  if (description.length > 1024) return "Keep it under 1024 characters.";
  return null;
}

export interface StoredSkill {
  /** The folder name. */
  name: string;
  markdown: string;
}

/** Reads and writes skills through the vault adapter, which also reaches hidden folders like `.claude`. */
export class SkillStore {
  constructor(private readonly fs: DataAdapter) {}

  async list(): Promise<StoredSkill[]> {
    if (!(await this.fs.exists(SKILLS_DIR))) return [];
    const { folders } = await this.fs.list(SKILLS_DIR);
    const skills: StoredSkill[] = [];
    for (const dir of folders) {
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      const file = skillFile(name);
      if (await this.fs.exists(file)) skills.push({ name, markdown: await this.fs.read(file) });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Writes `<name>/SKILL.md`; when `from` names another folder, moves that folder first so its other files follow. */
  async write(name: string, markdown: string, from?: string): Promise<void> {
    if (from && from !== name) await this.fs.rename(`${SKILLS_DIR}/${from}`, `${SKILLS_DIR}/${name}`);
    for (const dir of [".claude", SKILLS_DIR, `${SKILLS_DIR}/${name}`]) if (!(await this.fs.exists(dir))) await this.fs.mkdir(dir);
    await this.fs.write(skillFile(name), markdown);
  }

  /** Moves the skill's folder to the system trash, or Obsidian's `.trash` folder when there is none. */
  async trash(name: string): Promise<void> {
    const dir = `${SKILLS_DIR}/${name}`;
    if (!(await this.fs.trashSystem(dir))) await this.fs.trashLocal(dir);
  }
}
