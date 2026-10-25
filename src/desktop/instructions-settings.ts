import {
  ButtonComponent,
  Component,
  FuzzySuggestModal,
  MarkdownRenderer,
  Modal,
  Notice,
  Setting,
  type App,
  type SettingDefinition,
  type SettingDefinitionPage,
  type TFolder,
} from "obsidian";
import type { SettingsBlock } from "../core/settings";
import {
  composeSkill,
  descriptionProblem,
  isInstalledSkill,
  parseSkill,
  skillFile,
  skillNameProblem,
  SkillStore,
  type Skill,
  type StoredSkill,
} from "./skills";

export const INSTRUCTIONS_FILE = "CLAUDE.md";

/** Claude Code leaves block HTML comments out of what it reads, so the hint costs Claude nothing. */
const VAULT_TEMPLATE = `<!--
What Claude should know about this vault: what it is for, how notes are organised, conventions to follow.
Claude Code reads this file at the start of every conversation, in the chat panel and in a terminal.
Comments like this one are left out of what Claude reads.
-->

`;

function folderTemplate(folder: string): string {
  return `<!--
What Claude should know about the notes in ${folder}.
Claude Code reads this file when it works with files in this folder.
Comments like this one are left out of what Claude reads.
-->

`;
}

export function instructionsPath(folder: string): string {
  return folder && folder !== "/" ? `${folder}/${INSTRUCTIONS_FILE}` : INSTRUCTIONS_FILE;
}

/** Opens `<folder>/CLAUDE.md` in a new tab, creating it from the template first. `""` is the vault root. */
export async function openInstructions(app: App, folder: string): Promise<void> {
  const path = instructionsPath(folder);
  let file = app.vault.getFileByPath(path);
  if (!file) file = await app.vault.create(path, path === INSTRUCTIONS_FILE ? VAULT_TEMPLATE : folderTemplate(folder));
  await app.workspace.getLeaf("tab").openFile(file);
}

export interface ModuleSkill {
  name: string;
  /** The module's name, as shown in settings. */
  module: string;
  markdown: string;
}

export interface InstructionsDeps {
  app: App;
  /** Skills of the loaded modules. */
  moduleSkills(): ModuleSkill[];
  /** Before a note opens: the settings window would cover it. */
  closeSettings(): void;
}

/**
 * "Instructions" part of the settings tab: the vault's and folders' CLAUDE.md, and the skills in `.claude/skills`.
 * Keeps the skills read from disk between redraws, since the tab rebuilds its definitions on each update. No Node imports here.
 */
export class InstructionsSettings {
  private readonly store: SkillStore;
  /** null until read. */
  private skills: StoredSkill[] | null = null;
  private reading = false;
  /** Asked for while reading: read again afterwards, the folder may have changed since the read started. */
  private readAgain = false;
  private refresh: (() => void) | null = null;

  constructor(private readonly d: InstructionsDeps) {
    this.store = new SkillStore(d.app.vault.adapter);
  }

  /** Call when a file is created, deleted or renamed: the tab draws the definitions of its last update, even when reopened. */
  fileChanged(path: string, oldPath = ""): void {
    if ([path, oldPath].some((p) => p === INSTRUCTIONS_FILE || p.endsWith(`/${INSTRUCTIONS_FILE}`))) this.refresh?.();
  }

  block(refresh: () => void): SettingsBlock {
    this.refresh = refresh;
    const { app } = this.d;
    const open = async (folder: string) => {
      this.d.closeSettings();
      await openInstructions(app, folder);
    };
    const folders = app.vault
      .getFiles()
      .filter((f) => f.name === INSTRUCTIONS_FILE && f.path !== INSTRUCTIONS_FILE)
      .map((f) => f.path.slice(0, -INSTRUCTIONS_FILE.length - 1))
      .sort((a, b) => a.localeCompare(b));
    const hasVaultFile = !!app.vault.getFileByPath(INSTRUCTIONS_FILE);

    return {
      items: [
        {
          type: "group",
          heading: "Instructions",
          items: [
            {
              name: "Vault instructions",
              desc: "CLAUDE.md at the root of the vault. Claude reads it at the start of every conversation, in the chat and in a terminal.",
              render: (s) => {
                s.addButton((b) => b.setButtonText(hasVaultFile ? "Open" : "Create").onClick(() => open("")));
              },
            },
            this.skillsPage(refresh),
          ],
        },
        {
          type: "list",
          heading: "Folder instructions",
          cls: "cw-instructions-list",
          emptyState: "None yet. Claude reads a folder's CLAUDE.md when it works with files in that folder.",
          addItem: { name: "Add folder instructions", action: () => new FolderModal(app, (folder) => void open(folder.path)).open() },
          items: folders.map(
            (folder): SettingDefinition => ({
              name: folder,
              desc: `${folder}/${INSTRUCTIONS_FILE}`,
              action: () => void open(folder),
            }),
          ),
        },
      ],
      values: {},
    };
  }

  private skillsPage(refresh: () => void): SettingDefinitionPage {
    const { app } = this.d;
    const stored = this.skills ?? [];
    const modules = new Map(this.d.moduleSkills().map((s) => [s.name, s]));
    const mine = stored.filter((s) => !isInstalledSkill(s.markdown));
    const left = stored.filter((s) => isInstalledSkill(s.markdown) && !modules.has(s.name));
    const taken = (name: string) => stored.some((s) => s.name === name) || modules.has(name);
    const changed = async (message: string) => {
      new Notice(message);
      await this.reload(refresh);
    };

    const editor = (current?: Skill) =>
      new SkillModal(app, current, (n) => n !== current?.name && taken(n), async (skill) => {
        await this.store.write(skill.name, composeSkill(skill), current?.name);
        await changed(current ? `Saved the ${skill.name} skill.` : `Added the ${skill.name} skill.`);
      }).open();
    const trash = (name: string) =>
      new ConfirmModal(app, `Delete the ${name} skill?`, `Moves .claude/skills/${name} and everything in it to the trash.`, "Delete", async () => {
        await this.store.trash(name);
        await changed(`Deleted the ${name} skill.`);
      }).open();

    const installed = (s: ModuleSkill): string => {
      const onDisk = stored.find((x) => x.name === s.name);
      if (!onDisk) return "Installed when the vault is connected.";
      if (!isInstalledSkill(onDisk.markdown)) return "Not installed: one of your skills has this name. Rename yours to get this one.";
      return parseSkill(s.name, s.markdown).description;
    };

    return {
      type: "page",
      name: "Skills",
      desc: "Instructions Claude loads when a request matches what they're for. Kept in .claude/skills, for the chat and for claude in a terminal.",
      displayValue: () => {
        void this.reload(refresh);
        if (!this.skills) return "";
        const fromModules = modules.size + left.length;
        return [mine.length ? `${mine.length} yours` : "", fromModules ? `${fromModules} from modules` : ""].filter(Boolean).join(" · ") || "None";
      },
      items: [
        {
          type: "list",
          heading: "Your skills",
          cls: "cw-skills-list",
          emptyState: "No skills yet. A skill is written once and used whenever a request needs it: a review checklist, how you file meeting notes…",
          addItem: { name: "New skill", action: () => editor() },
          onDelete: (i) => {
            const s = mine[i];
            if (s) trash(s.name);
          },
          items: mine.map((s): SettingDefinition => {
            const skill = parseSkill(s.name, s.markdown);
            const clash = modules.get(s.name);
            return {
              name: s.name,
              desc: clash ? `Kept instead of the ${clash.module} module's skill of the same name. ${skill.description}` : skill.description,
              action: () => editor({ ...skill, name: s.name }),
            };
          }),
        },
        {
          // A list too, so its rows line up with the one above.
          type: "list",
          heading: "From modules",
          cls: "cw-skills-list",
          visible: modules.size + left.length > 0,
          items: [
            ...[...modules.values()].map(
              (s): SettingDefinition => ({
                name: s.name,
                desc: `${s.module} module · ${installed(s)}`,
                action: () => new SkillViewModal(app, parseSkill(s.name, s.markdown), `Installed by the ${s.module} module. Installing the vault config again overwrites changes made to ${skillFile(s.name)}.`).open(),
              }),
            ),
            ...left.map(
              (s): SettingDefinition => ({
                name: s.name,
                desc: "Its module is off or gone, but Claude still loads it. Open it to delete it.",
                action: () =>
                  new SkillViewModal(app, parseSkill(s.name, s.markdown), "Installed by a module that is off or no longer exists.", () => trash(s.name)).open(),
              }),
            ),
          ],
        },
      ],
    };
  }

  /** Re-reads `.claude/skills`; redraws the tab when something changed. */
  private async reload(refresh: () => void): Promise<void> {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      const skills = await this.store.list();
      const changed = JSON.stringify(skills) !== JSON.stringify(this.skills);
      this.skills = skills;
      if (changed) refresh();
    } catch (e) {
      new Notice(`Claude Workspace: couldn't read .claude/skills — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.reading = false;
    }
    if (this.readAgain) {
      this.readAgain = false;
      await this.reload(refresh);
    }
  }
}

/** Create or edit a skill: name, when to use it, instructions. */
class SkillModal extends Modal {
  constructor(
    app: App,
    private readonly current: Skill | undefined,
    private readonly taken: (name: string) => boolean,
    private readonly save: (skill: Skill) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    const draft: Skill = this.current ? { ...this.current } : { name: "", description: "", body: "", extra: {} };
    this.setTitle(this.current ? `Edit ${this.current.name}` : "New skill");
    this.modalEl.addClass("cw-skill-modal");
    const { contentEl } = this;

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Lowercase letters, digits and hyphens. It is also the folder's name in .claude/skills.")
      .addText((t) => t.setPlaceholder("weekly-review").setValue(draft.name).onChange((v) => (draft.name = v.trim())));
    new Setting(contentEl)
      .setName("When to use it")
      .setDesc("Claude only sees this until it loads the skill: say what it is for and when to use it.")
      .setClass("cw-skill-field")
      .addTextArea((t) => {
        t.setPlaceholder("Review the week's notes and plan the next one. Use when the user asks for a weekly review.").setValue(draft.description).onChange((v) => (draft.description = v));
        t.inputEl.rows = 3;
      });
    new Setting(contentEl)
      .setName("Instructions")
      .setDesc("What Claude should do, in Markdown. It reads this when it uses the skill.")
      .setClass("cw-skill-field")
      .addTextArea((t) => {
        t.setPlaceholder("1. List the notes changed this week…").setValue(draft.body).onChange((v) => (draft.body = v));
        t.inputEl.rows = 8;
      });

    const error = contentEl.createDiv({ cls: "cw-skill-error" });
    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText(this.current ? "Save" : "Add skill")
      .setCta()
      .onClick(async () => {
        const problem = skillNameProblem(draft.name, this.taken) ?? descriptionProblem(draft.description);
        error.setText(problem ?? "");
        if (problem) return;
        try {
          await this.save(draft);
          this.close();
        } catch (e) {
          error.setText(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** A module's skill, read-only: the module writes it again on each install. */
class SkillViewModal extends Modal {
  private readonly component = new Component();

  constructor(
    app: App,
    private readonly skill: Skill,
    private readonly origin: string,
    private readonly onDelete?: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.skill.name);
    this.modalEl.addClass("cw-skill-modal");
    const { contentEl } = this;
    contentEl.createDiv({ cls: "cw-skill-origin", text: this.origin });
    new Setting(contentEl).setName("When to use it").setDesc(this.skill.description).setClass("cw-skill-field");
    const body = contentEl.createDiv({ cls: "cw-skill-body markdown-rendered" });
    this.component.load();
    void MarkdownRenderer.render(this.app, this.skill.body, body, "", this.component);

    const buttons = contentEl.createDiv({ cls: "modal-button-container" });
    if (this.onDelete) {
      new ButtonComponent(buttons)
        .setButtonText("Delete")
        .setWarning()
        .onClick(() => {
          this.close();
          this.onDelete?.();
        });
    }
    new ButtonComponent(buttons).setButtonText("Close").onClick(() => this.close());
  }

  override onClose(): void {
    this.component.unload();
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly text: string,
    private readonly confirm: string,
    private readonly run: () => Promise<void>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.text });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => this.close());
    new ButtonComponent(buttons)
      .setButtonText(this.confirm)
      .setWarning()
      .onClick(async () => {
        this.close();
        try {
          await this.run();
        } catch (e) {
          new Notice(`Claude Workspace: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Pick the folder to add instructions to. */
class FolderModal extends FuzzySuggestModal<TFolder> {
  constructor(
    app: App,
    private readonly choose: (folder: TFolder) => void,
  ) {
    super(app);
    this.setPlaceholder("Folder to add a CLAUDE.md to");
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllFolders(false).filter((f) => !this.app.vault.getFileByPath(instructionsPath(f.path)));
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.choose(folder);
  }
}
