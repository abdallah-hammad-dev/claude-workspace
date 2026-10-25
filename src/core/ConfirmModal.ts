import { ButtonComponent, Modal, Notice, type App } from "obsidian";

/** "Delete …?" with Cancel and a red confirm button; `run` errors become a Notice. */
export class ConfirmModal extends Modal {
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
