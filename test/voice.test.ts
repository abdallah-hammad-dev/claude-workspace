import { describe, expect, it } from "vitest";
import { mergeData } from "../src/core/settings";
import { encodeWav, formatElapsed, hasSpeech, joinDictation, joinSamples, PauseSplitter } from "../src/desktop/voice/audio";
import {
  continuationPrompt,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  readTranscription,
  resolveTarget,
  transcriptionBody,
  transcriptionFields,
} from "../src/desktop/voice/providers";

const tone = (amp: number, seconds = 1) => Float32Array.from({ length: Math.round(16000 * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / 16000));
const quiet = (seconds: number) => new Float32Array(Math.round(16000 * seconds));
/** Deterministic hiss with the given RMS. */
const hiss = (level: number, seconds: number) => {
  let x = 1;
  return Float32Array.from({ length: Math.round(16000 * seconds) }, () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return (x / 1073741824 - 1) * level * Math.sqrt(3);
  });
};
const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));

/** Feeds a signal in 100 ms blocks like the mic does; returns the pieces' lengths (s) and the rest's. */
function split(...parts: Float32Array[]): { pieces: number[]; rest: number } {
  const all = joinSamples(parts);
  const s = new PauseSplitter();
  const pieces: number[] = [];
  for (let at = 0; at < all.length; at += 1600) {
    const p = s.push(all.slice(at, at + 1600));
    if (p) pieces.push(p.length / 16000);
  }
  return { pieces, rest: s.rest().length / 16000 };
}

describe("voice audio helpers", () => {
  it("skips silent recordings (Whisper invents words in silence)", () => {
    expect(hasSpeech(new Float32Array(16000))).toBe(false);
    expect(hasSpeech(tone(0.002))).toBe(false);
    expect(hasSpeech(tone(0.1))).toBe(true);
    const mostlyQuiet = new Float32Array(32000);
    mostlyQuiet.set(tone(0.1).subarray(0, 800), 20000);
    expect(hasSpeech(mostlyQuiet)).toBe(true);
  });

  it("spaces dictation from the surrounding text", () => {
    expect(joinDictation("", " Hello there. ", "")).toBe("Hello there.");
    expect(joinDictation("Look at", "this note", "")).toBe(" this note");
    expect(joinDictation("Look at ", "this note", "please")).toBe("this note ");
    expect(joinDictation("a", "  ", "b")).toBe("");
  });

  it("formats the recording time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7400)).toBe("0:07");
    expect(formatElapsed(83_000)).toBe("1:23");
  });

  it("encodes 16-bit mono PCM WAV", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, 0.5]));
    const v = new DataView(wav.buffer);
    const ascii = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(v.getUint32(4, true)).toBe(36 + 10);
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)]).toEqual([1, 1, 16000, 16]);
    expect(v.getUint32(40, true)).toBe(10);
    // Clipped to [-1, 1].
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767, 16383]);
  });
});

describe("cutting dictation at pauses", () => {
  it("sends a piece once the speaker pauses for a second after a few seconds of speech", () => {
    // 0.5 s lead-in + 4 s of speech + the 1 s pause; the next phrase is too short to be cut on its own.
    expect(split(quiet(0.5), tone(0.1, 4), quiet(1.2), tone(0.1, 2), quiet(0.3))).toEqual({ pieces: [5.5], rest: 2.5 });
  });

  it("doesn't cut short phrases or short pauses", () => {
    expect(split(tone(0.1, 2), quiet(2), tone(0.1, 0.5)).pieces).toEqual([]);
    expect(split(tone(0.1, 4), quiet(0.7), tone(0.1, 4), quiet(0.5)).pieces).toEqual([]);
  });

  it("accepts a shorter pause after a long stretch of speech", () => {
    expect(split(tone(0.1, 21), quiet(0.6)).pieces).toEqual([21.5]);
  });

  it("drops long silences before the first word", () => {
    expect(split(quiet(5), tone(0.1, 3), quiet(1)).pieces).toEqual([4.5]);
    expect(split(quiet(5)).rest).toBe(0.5);
  });

  it("still finds pauses over background noise", () => {
    const noise = 0.03; // well above the fixed speech threshold
    const r = split(quiet(0.3), hiss(noise, 1), mix(tone(0.2, 4), hiss(noise, 4)), hiss(noise, 1.2), mix(tone(0.2, 1), hiss(noise, 1)));
    expect(r.pieces).toHaveLength(1);
    expect(r.rest).toBeCloseTo(1.2, 1);
  });

  it("gives each piece the end of what was already said", () => {
    expect(continuationPrompt("  Bonjour à tous. ")).toBe("Bonjour à tous.");
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const p = continuationPrompt(long);
    expect(long.endsWith(p)).toBe(true);
    expect(p.length).toBeLessThanOrEqual(150 / 0.34);
    expect(p).toMatch(/^word\d+ /);
    // Scripts without spaces cost more per character.
    expect(continuationPrompt("漢".repeat(300))).toHaveLength(100);
  });
});

describe("OpenAI-compatible transcription", () => {
  it("resolves the endpoint and model from the settings", () => {
    expect(resolveTarget({ url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" })).toEqual({
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      model: "whisper-large-v3-turbo",
      host: "api.groq.com",
    });
    expect(resolveTarget({ url: " http://vps.example:8000/v1/ ", model: " Systran/faster-whisper-small " })).toEqual({
      url: "http://vps.example:8000/v1/audio/transcriptions",
      model: "Systran/faster-whisper-small",
      host: "vps.example:8000",
    });
    // The full endpoint pasted as is works too.
    expect(resolveTarget({ url: "https://api.openai.com/v1/audio/transcriptions", model: "whisper-1" })).toMatchObject({
      url: "https://api.openai.com/v1/audio/transcriptions",
    });
  });

  it("says what to fix when the settings are incomplete", () => {
    expect(resolveTarget({ url: "", model: "m" })).toEqual({ error: expect.stringMatching(/endpoint URL/) });
    expect(resolveTarget({ url: "https://x.example/v1", model: " " })).toEqual({ error: expect.stringMatching(/Set the model/) });
    expect(resolveTarget({ url: "ftp://x.example", model: "m" })).toEqual({ error: expect.stringMatching(/isn't a valid URL/) });
    expect(resolveTarget({ url: "not a url", model: "m" })).toEqual({ error: expect.stringMatching(/isn't a valid URL/) });
  });

  it("sends the language only when one is chosen", () => {
    expect(transcriptionFields("whisper-1", "")).toEqual({ model: "whisper-1", response_format: "json", temperature: "0" });
    expect(transcriptionFields("whisper-1", "fr")).toMatchObject({ language: "fr" });
    expect(transcriptionFields("whisper-1", "", "Hello there.")).toMatchObject({ prompt: "Hello there." });
    expect(transcriptionFields("whisper-1", "", "")).not.toHaveProperty("prompt");
  });

  it("builds a multipart body with the fields and the WAV file", () => {
    const wav = Uint8Array.from([82, 73, 70, 70, 0, 255]);
    const { contentType, body } = transcriptionBody(wav, { model: "whisper-large-v3-turbo", language: "fr" }, "BOUNDARY");
    expect(contentType).toBe("multipart/form-data; boundary=BOUNDARY");
    const bytes = new Uint8Array(body);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain('--BOUNDARY\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n');
    expect(text).toContain('--BOUNDARY\r\nContent-Disposition: form-data; name="language"\r\n\r\nfr\r\n');
    const head = '--BOUNDARY\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n';
    const at = text.indexOf(head) + head.length;
    expect([...bytes.subarray(at, at + wav.length)]).toEqual([...wav]);
    expect(text.endsWith("\r\n--BOUNDARY--\r\n")).toBe(true);
  });

  it("reads the transcript", () => {
    expect(readTranscription({ status: 200, text: '{"text":" Bonjour à tous. "}', headers: {} }, "api.groq.com", true)).toBe("Bonjour à tous.");
    expect(() => readTranscription({ status: 200, text: "<html>", headers: {} }, "x.example", true)).toThrow(/x\.example answered without a transcript/);
  });

  it("turns HTTP errors into messages the user can act on", () => {
    const err = (status: number, body: unknown, headers: Record<string, string> = {}, sentKey = true) => {
      try {
        readTranscription({ status, text: typeof body === "string" ? body : JSON.stringify(body), headers }, "api.groq.com", sentKey);
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    };
    expect(err(401, { error: { message: "Invalid API Key" } })).toMatch(/^api\.groq\.com rejected the API key\. Check it in Settings/);
    expect(err(401, { error: { message: "Missing API Key" } }, {}, false)).toMatch(/^api\.groq\.com needs an API key\. Add it in Settings/);
    expect(err(429, { error: { message: "Rate limit reached for model" } }, { "retry-after": "12.4" })).toBe(
      "api.groq.com: rate limit reached, try again in 13 s. Rate limit reached for model",
    );
    expect(err(413, "")).toMatch(/too large/);
    expect(err(404, { error: { message: "The model `small` does not exist" } })).toMatch(/not found \(HTTP 404\)\. Check the endpoint URL and model\. The model `small` does not exist/);
    expect(err(503, "upstream down")).toMatch(/server error \(HTTP 503\)/);
    expect(err(400, { error: { message: "x".repeat(300) } })).toMatch(/refused the request \(HTTP 400\): x{200}…$/);
  });
});

describe("voice settings", () => {
  it("are off by default (no mic) and prefilled with Groq's endpoint", () => {
    expect(mergeData({}).voice).toEqual({ enabled: false, url: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, secret: "", language: "", live: true });
    expect(mergeData({ voice: { enabled: true, secret: "groq" } }).voice).toMatchObject({ enabled: true, url: DEFAULT_ENDPOINT, secret: "groq" });
  });
});
