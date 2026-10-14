import { Notice, requestUrl, type App } from "obsidian";
import type { Logger } from "../../core/module-api";
import type { VoicePrefs } from "../../core/settings";
import { encodeWav, hasSpeech, SAMPLE_RATE } from "./audio";
import { MicRecording } from "./MicRecording";
import { continuationPrompt, readTranscription, resolveTarget, transcriptionBody, transcriptionFields } from "./providers";
import type { VoiceService } from "./service";
import { renderVoiceSettings } from "./voice-settings";

export interface VoiceDeps {
  app: App;
  prefs(): VoicePrefs;
  savePrefs(p: Partial<VoicePrefs>): Promise<void>;
  openSettings(): void;
  log: Logger;
}

export interface Voice {
  service: VoiceService;
  renderSettings(el: HTMLElement, refresh: () => void): void;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Obsidian's keychain (1.11.4+, documented); undefined on older versions. */
function keychain(app: App): { getSecret(id: string): string | null } | undefined {
  const s = (app as Partial<Pick<App, "secretStorage">>).secretStorage;
  return typeof s?.getSecret === "function" ? s : undefined;
}

/**
 * Voice input: the chat's mic records 16 kHz audio, which is sent as a WAV to the OpenAI-compatible
 * transcription endpoint set by the user (Groq prefilled): piece by piece at pauses, or in one go when
 * the user stops. Off until the user turns it on in settings.
 */
export function createVoice(d: VoiceDeps): Voice {
  const listeners = new Set<() => void>();
  let lastMs: number | null = null;
  const apiKey = (): string | null => {
    const name = d.prefs().secret;
    return name ? (keychain(d.app)?.getSecret(name) ?? null) : null;
  };

  /** What's missing before anything can be transcribed, or null. */
  const problem = (): string | null => {
    if (!keychain(d.app)) return "Voice input needs Obsidian 1.11.4 or later, to keep the API key in Obsidian's keychain.";
    const target = resolveTarget(d.prefs());
    // A missing key isn't checked here: self-hosted servers may not need one; a 401 says so.
    return "error" in target ? target.error : null;
  };

  /** POST the WAV; returns the text. Logs timings, never audio, text or the key. */
  const send = async (wav: Uint8Array, before = ""): Promise<string> => {
    const target = resolveTarget(d.prefs());
    if ("error" in target) throw new Error(target.error);
    const { contentType, body } = transcriptionBody(wav, transcriptionFields(target.model, d.prefs().language, continuationPrompt(before)));
    const key = apiKey();
    const started = performance.now();
    let res: { status: number; text: string; headers: Record<string, string> };
    try {
      res = await withTimeout(
        requestUrl({ url: target.url, method: "POST", contentType, body, headers: key ? { Authorization: `Bearer ${key}` } : {}, throw: false }),
        REQUEST_TIMEOUT_MS,
      );
    } catch (e) {
      throw new Error(`Couldn't reach ${target.host}: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const text = readTranscription(res, target.host, !!key);
      lastMs = performance.now() - started;
      d.log.info(`transcribed ${((wav.length - 44) / 2 / SAMPLE_RATE).toFixed(1)} s by ${target.host} (${target.model}) in ${(lastMs / 1000).toFixed(2)} s`);
      return text;
    } catch (e) {
      d.log.warn(`transcription failed: HTTP ${res.status} from ${target.host}`);
      throw e;
    }
  };

  const service: VoiceService = {
    isEnabled: () => d.prefs().enabled,
    isLive: () => d.prefs().live,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    ready: () => {
      const p = problem();
      if (!p) return true;
      const notice = new Notice(`${p} (Click to open settings.)`, 12000);
      notice.noticeEl.onclick = () => d.openSettings();
      return false;
    },
    record: (onPiece) => MicRecording.start(onPiece),
    transcribe: async (audio, before) => (hasSpeech(audio) ? send(encodeWav(audio), before) : ""),
    describe: () => {
      const target = resolveTarget(d.prefs());
      if ("error" in target) return "Not set up yet";
      return `${target.host} · ${target.model}${lastMs !== null ? `, last ${(lastMs / 1000).toFixed(1)} s` : ""}`;
    },
  };

  return {
    service,
    renderSettings: (el, refresh) =>
      renderVoiceSettings(
        el,
        {
          app: d.app,
          prefs: d.prefs(),
          setPrefs: async (p) => {
            await d.savePrefs(p);
            listeners.forEach((fn) => fn());
          },
          hasKeychain: !!keychain(d.app),
          check: async () => {
            const p = problem();
            if (p) throw new Error(p);
            // One second of silence: only the HTTP answer matters.
            await send(encodeWav(new Float32Array(SAMPLE_RATE)));
            const target = resolveTarget(d.prefs());
            return `${"error" in target ? "The service" : target.host} answered in ${((lastMs ?? 0) / 1000).toFixed(1)} s.`;
          },
        },
        refresh,
      ),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
