import { joinSamples, PauseSplitter, SAMPLE_RATE } from "./audio";
import type { VoiceRecording } from "./service";

/** Collects the microphone's samples in ~100 ms blocks; "flush" sends what's left. */
const CAPTURE_WORKLET = `
class CwCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.n = 0;
    this.port.onmessage = () => {
      this.port.postMessage(this.buf.slice(0, this.n));
      this.n = 0;
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(1600);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("cw-capture", CwCapture);
`;

/**
 * Microphone capture for dictation. The audio graph runs at 16 kHz (Chromium resamples the microphone),
 * the rate speech-to-text models use, and an AudioWorklet hands over the raw samples: no codec, and the
 * result is a small WAV (~1.9 MB per minute). With `onPiece`, the audio is cut at pauses as it comes in.
 */
export class MicRecording implements VoiceRecording {
  private chunks: Float32Array[] = [];
  private readonly splitter: PauseSplitter | null;
  private last: Float32Array | null = null;
  private stopped = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly onPiece?: (audio: Float32Array) => void,
  ) {
    this.splitter = onPiece ? new PauseSplitter() : null;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.push(e.data);
  }

  static async start(onPiece?: (audio: Float32Array) => void): Promise<MicRecording> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      throw new Error(micError(e));
    }
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: "text/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, "cw-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      ctx.createMediaStreamSource(stream).connect(node);
      // The worklet outputs silence; connecting it keeps the graph pulling audio through it.
      node.connect(ctx.destination);
      return new MicRecording(stream, ctx, node, onPiece);
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
      throw new Error(`Couldn't start recording: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private push(chunk: Float32Array): void {
    if (!chunk.length) return;
    this.last = chunk;
    if (!this.splitter) {
      this.chunks.push(chunk);
      return;
    }
    const piece = this.splitter.push(chunk);
    if (piece) this.onPiece?.(piece);
  }

  level(): number {
    const c = this.last;
    if (this.stopped || !c) return 0;
    let sum = 0;
    for (const v of c) sum += v * v;
    // Speech RMS is roughly 0.02–0.3; stretch it so the indicator moves visibly.
    return Math.min(1, Math.sqrt(sum / c.length) * 5);
  }

  async stop(): Promise<Float32Array> {
    if (!this.stopped) {
      // Ask the worklet for its partial block, then shut everything down.
      const flushed = new Promise<void>((resolve) => {
        const prev = this.node.port.onmessage;
        this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
          this.push(e.data);
          this.node.port.onmessage = prev;
          resolve();
        };
        window.setTimeout(resolve, 300);
      });
      this.node.port.postMessage("flush");
      await flushed;
      this.release();
    }
    const rest = this.splitter ? this.splitter.rest() : joinSamples(this.chunks);
    this.chunks = [];
    return rest;
  }

  cancel(): void {
    this.release();
    this.chunks = [];
    this.splitter?.rest();
  }

  private release(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.node.port.onmessage = null;
    this.node.disconnect();
    for (const t of this.stream.getTracks()) t.stop();
    void this.ctx.close();
  }
}

function micError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Obsidian isn't allowed to use the microphone. Windows: Settings → Privacy & security → Microphone → let desktop apps use it. macOS: System Settings → Privacy & Security → Microphone → Obsidian.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Plug one in or check your sound settings.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is unavailable. Another app may be using it.";
  return `Couldn't start the microphone: ${e instanceof Error ? e.message : String(e)}`;
}
