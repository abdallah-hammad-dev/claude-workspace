import { SecretComponent, Setting, type App } from "obsidian";
import { settingGroup } from "../../core/setting-group";
import type { VoicePrefs } from "../../core/settings";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, EXAMPLES } from "./providers";

export interface VoiceSettingsDeps {
  app: App;
  prefs: VoicePrefs;
  setPrefs(p: Partial<VoicePrefs>): Promise<void>;
  /** Obsidian 1.11.4+ keychain is there. */
  hasKeychain: boolean;
  /** Sends a second of silence; resolves with a short success line or throws what went wrong. */
  check(): Promise<string>;
}

/** Spoken languages offered; "" lets the service detect it. */
const LANGUAGES: [string, string][] = [
  ["", "Detect automatically"],
  ["en", "English"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["ar", "Arabic"],
  ["tr", "Turkish"],
  ["ru", "Russian"],
  ["zh", "Chinese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["hi", "Hindi"],
];

/** "Voice input" section of the settings tab. No Node imports (the UI preview renders it). */
export function renderVoiceSettings(el: HTMLElement, d: VoiceSettingsDeps, refresh: () => void): void {
  const intro = el.createDiv({ cls: "cw-settings-section" });
  intro.createDiv({ cls: "cw-settings-title", text: "Voice input" });
  intro.createDiv({
    cls: "cw-settings-desc",
    text: "A mic in the chat: talk, and your words are typed in the message box for you to review. The recording is sent to the speech-to-text service below (any OpenAI-compatible API).",
  });
  const list = settingGroup(el);
  const p = d.prefs;

  new Setting(list)
    .setName("Show the mic in the chat")
    .setDesc(d.hasKeychain ? "Off: no mic, nothing is recorded or sent." : "Needs Obsidian 1.11.4 or later, which keeps the API key in its keychain.")
    .addToggle((t) =>
      t
        .setValue(p.enabled && d.hasKeychain)
        .setDisabled(!d.hasKeychain)
        .onChange(async (v) => {
          await d.setPrefs({ enabled: v });
          refresh();
        }),
    );
  if (!p.enabled || !d.hasKeychain) return;

  const examples = createFragment((f) => {
    f.appendText("Base URL of an OpenAI-compatible API; the plugin calls …/audio/transcriptions. Your recordings are sent there. Examples: ");
    EXAMPLES.forEach((x, i) => {
      if (i) f.appendText(", ");
      f.createEl("code", { text: x.endpoint });
      f.appendText(` (${x.name})`);
    });
    f.appendText(", or your own server.");
  });
  new Setting(list)
    .setName("Endpoint URL")
    .setDesc(examples)
    .addText((t) =>
      t
        .setPlaceholder(DEFAULT_ENDPOINT)
        .setValue(p.url)
        .onChange(async (v) => d.setPrefs({ url: v.trim() })),
    );

  new Setting(list)
    .setName("Model")
    .setDesc(createFragment((f) => {
      f.appendText("As the service names it. ");
      EXAMPLES.forEach((x, i) => {
        if (i) f.appendText(", ");
        f.appendText(`${x.name.replace(/ \(.*\)$/, "")}: `);
        f.createEl("code", { text: x.model });
      });
      f.appendText(".");
    }))
    .addText((t) =>
      t
        .setPlaceholder(DEFAULT_MODEL)
        .setValue(p.model)
        .onChange(async (v) => d.setPrefs({ model: v.trim() })),
    );

  const key = new Setting(list).setName("API key");
  key.descEl.appendText("Kept in Obsidian's keychain (Settings → Keychain), not in your vault. Leave empty if your server needs none. Get one: ");
  EXAMPLES.forEach((x, i) => {
    if (i) key.descEl.appendText(", ");
    key.descEl.createEl("a", { text: x.name.replace(/ \(.*\)$/, ""), href: x.keys });
  });
  key.descEl.appendText(".");
  key.addComponent((c) =>
    new SecretComponent(d.app, c).setValue(p.secret).onChange(async (v) => {
      await d.setPrefs({ secret: v ?? "" });
    }),
  );

  new Setting(list)
    .setName("Spoken language")
    .setDesc("Automatic detection handles switching languages. Pick yours if short sentences come out in the wrong one.")
    .addDropdown((dd) => {
      for (const [code, label] of LANGUAGES) dd.addOption(code, label);
      dd.setValue(p.language).onChange(async (v) => d.setPrefs({ language: v }));
    });

  new Setting(list)
    .setName("Type at each pause")
    .setDesc("When you pause for a second, what you just said is sent and appears in the message box while you keep talking. Off: everything is sent in one go when you stop (fewer requests).")
    .addToggle((t) => t.setValue(p.live).onChange(async (v) => d.setPrefs({ live: v })));

  const check = new Setting(list).setName("Check the connection").setDesc("Sends one second of silence to the service.");
  check.addButton((b) =>
    b.setButtonText("Check").onClick(async () => {
      b.setDisabled(true);
      check.setDesc("Checking…");
      try {
        check.setDesc(`Works. ${await d.check()}`);
      } catch (e) {
        check.setDesc(`Failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        b.setDisabled(false);
      }
    }),
  );
}
