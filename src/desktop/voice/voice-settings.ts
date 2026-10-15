import type { ControlValue } from "../../core/module-api";
import type { SettingsBlock, VoicePrefs } from "../../core/settings";
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, EXAMPLES } from "./providers";

export interface VoiceSettingsDeps {
  prefs(): VoicePrefs;
  setPrefs(p: Partial<VoicePrefs>): Promise<void>;
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
export function voiceSettings(d: VoiceSettingsDeps): SettingsBlock {
  const on = () => d.prefs().enabled;
  const pref = <K extends keyof VoicePrefs>(key: K, parse: (v: unknown) => VoicePrefs[K]): ControlValue => ({
    get: () => d.prefs()[key],
    set: (v) => d.setPrefs({ [key]: parse(v) }),
  });
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const flag = (v: unknown) => v === true;

  const providerName = (name: string) => name.replace(/ \(.*\)$/, "");
  const endpointDesc = createFragment((f) => {
    f.appendText("Base URL of an OpenAI-compatible API; the plugin calls …/audio/transcriptions. Your recordings are sent there. Examples: ");
    EXAMPLES.forEach((x, i) => {
      if (i) f.appendText(", ");
      f.createEl("code", { text: x.endpoint });
      f.appendText(` (${x.name})`);
    });
    f.appendText(", or your own server.");
  });
  const modelDesc = createFragment((f) => {
    f.appendText("As the service names it. ");
    EXAMPLES.forEach((x, i) => {
      if (i) f.appendText(", ");
      f.appendText(`${providerName(x.name)}: `);
      f.createEl("code", { text: x.model });
    });
    f.appendText(".");
  });
  const keyDesc = createFragment((f) => {
    f.appendText("Kept in Obsidian's keychain (Settings → Keychain), not in your vault. Leave empty if your server needs none. Get one: ");
    EXAMPLES.forEach((x, i) => {
      if (i) f.appendText(", ");
      f.createEl("a", { text: providerName(x.name), href: x.keys });
    });
    f.appendText(".");
  });

  return {
    items: [
      {
        type: "group",
        heading: "Voice input",
        items: [
          {
            name: "Show the mic in the chat",
            desc: "Talk, and your words are typed in the message box for you to review. Recordings go to a speech-to-text service you choose (any OpenAI-compatible API). Off: no mic, nothing is recorded or sent.",
            control: { type: "toggle", key: "voice.enabled" },
          },
          { name: "Endpoint URL", desc: endpointDesc, visible: on, control: { type: "text", key: "voice.url", placeholder: DEFAULT_ENDPOINT } },
          { name: "Model", desc: modelDesc, visible: on, control: { type: "text", key: "voice.model", placeholder: DEFAULT_MODEL } },
          { name: "API key", desc: keyDesc, visible: on, control: { type: "secret", key: "voice.secret" } },
          {
            name: "Spoken language",
            desc: "Automatic detection handles switching languages. Pick yours if short sentences come out in the wrong one.",
            visible: on,
            control: { type: "dropdown", key: "voice.language", options: Object.fromEntries(LANGUAGES) },
          },
          {
            name: "Type at each pause",
            desc: "When you pause for a second, what you just said is sent and appears in the message box while you keep talking. Off: everything is sent in one go when you stop (fewer requests).",
            visible: on,
            control: { type: "toggle", key: "voice.live" },
          },
          {
            name: "Check the connection",
            desc: "Sends one second of silence to the service.",
            visible: on,
            render: (s) => {
              s.addButton((b) =>
                b.setButtonText("Check").onClick(async () => {
                  b.setDisabled(true);
                  s.setDesc("Checking…");
                  try {
                    s.setDesc(`Works. ${await d.check()}`);
                  } catch (e) {
                    s.setDesc(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                  } finally {
                    b.setDisabled(false);
                  }
                }),
              );
            },
          },
        ],
      },
    ],
    values: {
      "voice.enabled": pref("enabled", flag),
      "voice.url": pref("url", (v) => str(v).trim()),
      "voice.model": pref("model", (v) => str(v).trim()),
      "voice.secret": pref("secret", str),
      "voice.language": pref("language", str),
      "voice.live": pref("live", flag),
    },
  };
}
