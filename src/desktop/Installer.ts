import type { App, DataAdapter } from "obsidian";
import type { SkillDef } from "../core/module-api";
import { isInstalled, mergeClaudeSettings, mergeMcpJson, type InstallTarget } from "./installer-merge";
import { isInstalledSkill, markInstalled, skillFile, SkillStore } from "./skills";

const MCP_JSON = ".mcp.json";
const SETTINGS = ".claude/settings.json";

export interface InstallReport {
  written: string[];
  /** Files that contain the token; shown so the user can gitignore them. */
  secretFiles: string[];
  /** Module skills not written because the user has a skill of that name. */
  keptSkills: string[];
}

export interface SkillsReport {
  written: string[];
  /** Files left alone: the user's own skill has the module skill's name. */
  kept: string[];
}

/**
 * Writes Claude Code config into the vault so `claude` (terminal) and the chat
 * view share the same MCP server, hook and skills. Merges, never clobbers;
 * refuses to touch a file it can't parse.
 */
export class Installer {
  constructor(private readonly app: App) {}

  private get fs(): DataAdapter {
    return this.app.vault.adapter;
  }

  async status(t: InstallTarget): Promise<boolean> {
    try {
      return isInstalled(await this.readJson(MCP_JSON), await this.readJson(SETTINGS), t);
    } catch {
      return false;
    }
  }

  async install(t: InstallTarget, skills: SkillDef[]): Promise<InstallReport> {
    // Parse everything first so an invalid file aborts before anything is written.
    const mcp = mergeMcpJson(await this.readJson(MCP_JSON), t);
    const settings = mergeClaudeSettings(await this.readJson(SETTINGS), t);

    await this.ensureDir(".claude");
    await this.fs.write(MCP_JSON, JSON.stringify(mcp, null, 2) + "\n");
    await this.fs.write(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
    const written = [MCP_JSON, SETTINGS];

    const report = await this.writeSkills(skills);
    return { written: [...written, ...report.written], secretFiles: [MCP_JSON, SETTINGS], keptSkills: report.kept };
  }

  /**
   * Write module skills to `.claude/skills/<name>/SKILL.md`, marked as installed, only when they changed.
   * A SKILL.md without the mark is the user's and is kept, unless it is the module's text from before the mark existed.
   */
  async writeSkills(skills: SkillDef[]): Promise<SkillsReport> {
    const report: SkillsReport = { written: [], kept: [] };
    const store = new SkillStore(this.fs);
    for (const skill of skills) {
      const file = skillFile(skill.name);
      const markdown = markInstalled(skill.markdown);
      if (await this.fs.exists(file)) {
        const current = await this.fs.read(file);
        if (current === markdown) continue;
        if (!isInstalledSkill(current) && current !== skill.markdown) {
          report.kept.push(file);
          continue;
        }
      }
      await store.write(skill.name, markdown);
      report.written.push(file);
    }
    return report;
  }

  private async readJson(path: string): Promise<unknown> {
    if (!(await this.fs.exists(path))) return {};
    const text = await this.fs.read(path);
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`${path} is not valid JSON. Fix or delete it, then install again.`);
    }
  }

  private async ensureDir(path: string): Promise<void> {
    if (!(await this.fs.exists(path))) await this.fs.mkdir(path);
  }
}
