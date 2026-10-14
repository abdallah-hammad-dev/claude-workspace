/** Pure audio helpers for voice input (no DOM, no Node). */

/** Whisper's input rate. */
export const SAMPLE_RATE = 16000;

/** Loudness (RMS) from which a stretch of audio counts as speech. */
const SPEECH_RMS = 0.008;

/**
 * True when the recording has at least one stretch loud enough to be speech. Whisper "hears" words in
 * silence ("Thank you.", "Sous-titres réalisés par…"), so silent recordings are not sent to it.
 */
export function hasSpeech(samples: Float32Array, sampleRate = SAMPLE_RATE, threshold = SPEECH_RMS): boolean {
  const frame = Math.max(1, Math.round(sampleRate * 0.03));
  for (let start = 0; start + frame <= samples.length; start += frame) {
    if (rms(samples.subarray(start, start + frame)) >= threshold) return true;
  }
  return false;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** One recording from its blocks. */
export function joinSamples(blocks: Float32Array[]): Float32Array {
  const out = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** When to cut a piece (seconds): after this much speech… */
const MIN_SPEECH_S = 3;
/** …once the speaker has been quiet this long. */
const PAUSE_S = 1;
/** After a long stretch of speech, a shorter pause is enough, so someone who barely stops still sees text. */
const LONG_SPEECH_S = 20;
const SHORT_PAUSE_S = 0.5;
/** Silence kept before the first word of a piece. */
const LEAD_IN_S = 0.5;
/**
 * Background noise = the quietest block of the last ~10 s; speech must be well above it. Capped: before the
 * first pause the "noise" may be the voice itself, and speech (~0.05–0.3 with Chromium's gain control) stays
 * above the cap.
 */
const NOISE_BLOCKS = 100;
const NOISE_MARGIN = 2.5;
const MAX_SPEECH_RMS = 0.04;

/**
 * Cuts a recording at pauses, so each piece can be transcribed while the user keeps talking. A piece ends
 * after at least 3 s of speech followed by 1 s of quiet (0.5 s after 20 s of speech); the cuts land between
 * sentences, where Whisper loses nothing, and stay under ~15 requests a minute (Groq's free tier allows 20).
 */
export class PauseSplitter {
  private blocks: Float32Array[] = [];
  private length = 0;
  /** Where speech starts and last stopped in the current piece (samples); -1 before the first word. */
  private speechStart = -1;
  private speechEnd = -1;
  private levels: number[] = [];

  constructor(private readonly sampleRate = SAMPLE_RATE) {}

  /** Adds the next block of samples (~100 ms); returns the finished piece when the speaker paused. */
  push(block: Float32Array): Float32Array | null {
    if (!block.length) return null;
    const level = rms(block);
    const noise = this.levels.length ? Math.min(...this.levels) : 0;
    const voiced = level >= Math.min(MAX_SPEECH_RMS, Math.max(SPEECH_RMS, noise * NOISE_MARGIN));
    // Digital silence (the mic starting up) says nothing about the room's noise.
    if (level > 1e-4) this.levels.push(level);
    if (this.levels.length > NOISE_BLOCKS) this.levels.shift();

    this.blocks.push(block);
    this.length += block.length;
    const sr = this.sampleRate;
    if (!voiced && this.speechStart < 0) {
      // Nothing said yet: keep only a short lead-in of silence.
      while (this.blocks.length > 1 && this.length - this.blocks[0]!.length >= LEAD_IN_S * sr) this.length -= this.blocks.shift()!.length;
      return null;
    }
    if (voiced) {
      if (this.speechStart < 0) this.speechStart = this.length - block.length;
      this.speechEnd = this.length;
    }
    const speech = this.speechEnd - this.speechStart;
    const quiet = this.length - this.speechEnd;
    const pause = speech >= LONG_SPEECH_S * sr ? SHORT_PAUSE_S : PAUSE_S;
    return speech >= MIN_SPEECH_S * sr && quiet >= pause * sr ? this.rest() : null;
  }

  /** Everything since the last piece. */
  rest(): Float32Array {
    const out = joinSamples(this.blocks);
    this.blocks = [];
    this.length = 0;
    this.speechStart = this.speechEnd = -1;
    return out;
  }
}

/** Text to insert at the cursor so dictation joins what's already typed with single spaces. */
export function joinDictation(before: string, text: string, after: string): string {
  const t = text.trim();
  if (!t) return "";
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return `${lead}${t}${trail}`;
}

/** "0:07", "1:23". */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 16-bit PCM WAV (mono): what transcription APIs accept everywhere. ~1.9 MB per minute at 16 kHz. */
export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
