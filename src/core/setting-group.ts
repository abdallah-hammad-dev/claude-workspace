/**
 * Same markup as Obsidian's SettingGroup (1.11+): one rounded card holding several
 * settings. Built by hand so it also works on older Obsidian, where the classes are
 * simply unstyled and the settings render as a plain list.
 */
export function settingGroup(container: HTMLElement, heading?: string | DocumentFragment, cls?: string): HTMLElement {
  const group = container.createDiv({ cls: ["setting-group", ...(cls ? [cls] : [])] });
  if (heading) {
    const head = group.createDiv({ cls: "setting-item setting-item-heading" });
    head.createDiv({ cls: "setting-item-name" }).setText(heading);
    head.createDiv({ cls: "setting-item-control" });
  }
  return group.createDiv({ cls: "setting-items" });
}
