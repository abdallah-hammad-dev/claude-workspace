import type { App } from "obsidian";

/** Obsidian's settings window, `app.setting`. It is NOT part of the public API; everything that touches it lives in this file. */
interface SettingWindow {
  open(): void;
  close(): void;
  openTabById(id: string): unknown;
}

function settingWindow(app: App): Partial<SettingWindow> | undefined {
  return (app as unknown as { setting?: Partial<SettingWindow> }).setting;
}

export function openSettings(app: App, tabId: string): void {
  const s = settingWindow(app);
  s?.open?.();
  s?.openTabById?.(tabId);
}

export function closeSettings(app: App): void {
  settingWindow(app)?.close?.();
}
