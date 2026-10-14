/**
 * Speech-to-text through any OpenAI-compatible `POST <endpoint>/audio/transcriptions` (OpenAI, Groq, a Whisper
 * server you host…). Pure: building the request and reading the answer; the caller sends it (Obsidian's
 * requestUrl). Never put the API key in an error.
 */

/** Prefilled in settings: Groq's free tier works out of the box with a free key. */
export const DEFAULT_ENDPOINT = "https://api.groq.com/openai/v1";
export const DEFAULT_MODEL = "whisper-large-v3-turbo";

/** Shown in settings as examples; nothing in the code depends on them. */
export const EXAMPLES = [
  { name: "Groq (free tier)", endpoint: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", keys: "https://console.groq.com/keys" },
  { name: "OpenAI", endpoint: "https://api.openai.com/v1", model: "whisper-1", keys: "https://platform.openai.com/api-keys" },
];

export interface TranscriptionTarget {
  /** Full endpoint URL. */
  url: string;
  model: string;
  /** Host name, for messages. */
  host: string;
}

/** Endpoint and model from the settings, or `{ error }` saying what to fix. */
export function resolveTarget(p: { url: string; model: string }): TranscriptionTarget | { error: string } {
  const base = p.url.trim().replace(/\/+$/, "");
  const model = p.model.trim();
  if (!base) return { error: "Set the endpoint URL in Settings → Claude Workspace → Voice input." };
  if (!model) return { error: "Set the model in Settings → Claude Workspace → Voice input." };
  let host: string;
  try {
    const u = new URL(base);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    host = u.host;
  } catch {
    return { error: `"${base}" isn't a valid URL. Fix it in Settings → Claude Workspace → Voice input.` };
  }
  const url = base.endsWith("/audio/transcriptions") ? base : `${base}/audio/transcriptions`;
  return { url, model, host };
}

export interface MultipartBody {
  contentType: string;
  body: ArrayBuffer;
}

/** multipart/form-data with the audio file and the text fields, as the endpoint expects. */
export function transcriptionBody(wav: Uint8Array, fields: Record<string, string>, boundary = randomBoundary()): MultipartBody {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(wav);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: out.buffer };
}

function randomBoundary(): string {
  return `----cw${Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join("")}`;
}

/**
 * The request fields: model, plain JSON answer, the language when one is set (else auto-detect), and the
 * text before this piece as `prompt` when dictating in pieces.
 */
export function transcriptionFields(model: string, language: string, prompt = ""): Record<string, string> {
  return { model, response_format: "json", temperature: "0", ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) };
}

/** Whisper reads at most 224 tokens of prompt; keep well under it. */
const PROMPT_TOKENS = 150;

/**
 * The end of what this dictation already said, sent with the next piece so it continues the same sentence,
 * spelling and style (what OpenAI suggests for audio split in pieces). Rough token count: Latin script
 * ~3 characters per token, other scripts up to 1.5 tokens per character.
 */
export function continuationPrompt(said: string): string {
  const t = said.trim();
  let cost = 0;
  let from = t.length;
  while (from > 0) {
    const c = t.charCodeAt(from - 1);
    cost += c < 0x250 ? 0.34 : 1.5;
    if (cost > PROMPT_TOKENS) break;
    from--;
  }
  if (from === 0) return t;
  // Start on a whole word when the script has spaces.
  const tail = t.slice(from);
  const space = tail.search(/\s/);
  return space >= 0 ? tail.slice(space + 1).trimStart() : tail;
}

export interface HttpAnswer {
  status: number;
  /** Raw body text. */
  text: string;
  headers: Record<string, string>;
}

/** The transcript, or an Error a user can act on. `sentKey`: whether the request carried an API key. */
export function readTranscription(a: HttpAnswer, host: string, sentKey: boolean): string {
  let json: unknown = null;
  try {
    json = JSON.parse(a.text);
  } catch {
    // not JSON: handled below
  }
  if (a.status >= 200 && a.status < 300) {
    const text = (json as { text?: unknown } | null)?.text;
    if (typeof text !== "string") throw new Error(`${host} answered without a transcript. Is the endpoint OpenAI-compatible?`);
    return text.trim();
  }
  const detail = apiMessage(json);
  const where = host;
  switch (true) {
    case a.status === 401 || a.status === 403:
      throw new Error(
        sentKey
          ? `${where} rejected the API key. Check it in Settings → Claude Workspace → Voice input.`
          : `${where} needs an API key. Add it in Settings → Claude Workspace → Voice input.`,
      );
    case a.status === 429: {
      const retry = Number(a.headers["retry-after"] ?? a.headers["Retry-After"]);
      throw new Error(`${where}: rate limit reached${Number.isFinite(retry) && retry > 0 ? `, try again in ${Math.ceil(retry)} s` : ""}.${detail ? ` ${detail}` : ""}`);
    }
    case a.status === 413:
      throw new Error(`${where}: the recording is too large for this service.`);
    case a.status === 404:
      throw new Error(`${where}: not found (HTTP 404). Check the endpoint URL and model.${detail ? ` ${detail}` : ""}`);
    case a.status >= 500:
      throw new Error(`${where} had a server error (HTTP ${a.status}). Try again in a moment.`);
    default:
      throw new Error(`${where} refused the request (HTTP ${a.status})${detail ? `: ${detail}` : "."}`);
  }
}

/** `{"error": {"message": "…"}}` (OpenAI and Groq), shortened. */
function apiMessage(json: unknown): string {
  const err = (json as { error?: unknown } | null)?.error;
  const msg = typeof err === "string" ? err : (err as { message?: unknown } | undefined)?.message;
  if (typeof msg !== "string") return "";
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}
