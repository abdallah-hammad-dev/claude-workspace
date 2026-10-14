import { Notice, setIcon, setTooltip } from "obsidian";
import { formatElapsed, joinSamples } from "../voice/audio";
import type { VoiceRecording, VoiceService } from "../voice/service";

type State = "idle" | "starting" | "recording" | "transcribing";

/** Stop on our own after this: services cap uploads (~25 MB) and long takes are rarely intended. */
const MAX_RECORDING_MS = 5 * 60_000;

/** One dictation. With "type at each pause", its pieces are transcribed in order while the user talks. */
interface Take {
  live: boolean;
  /** Transcribed so far; sent with the next piece so it continues the same sentence. */
  said: string;
  /** Pieces are sent one after the other (in order, and each with the text before it). */
  queue: Promise<void>;
  /** After a piece fails, the next ones wait here and go with the rest in one request at the end. */
  held: Float32Array[];
}

/**
 * The composer's mic: click to talk, click again to turn the speech into text at the cursor. With "type at
 * each pause" on, each phrase is typed when you pause. Hidden while voice input is off in settings. Esc
 * stops and drops what isn't typed yet (handled by the chat view). Nothing is sent to Claude until you
 * press Enter.
 */
export class MicButton {
  readonly el: HTMLButtonElement;
  private state: State = "idle";
  private rec: VoiceRecording | null = null;
  private take: Take | null = null;
  private startedAt = 0;
  private ticker: number | null = null;
  private timeEl: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    private readonly voice: VoiceService,
    private readonly insert: (text: string) => void,
  ) {
    this.el = parent.createEl("button", { cls: "cw-footer-btn cw-mic-btn" });
    this.el.onclick = () => void this.toggle();
    this.refresh();
  }

  get isRecording(): boolean {
    return this.state === "recording";
  }

  /** Follow the settings: show or hide the mic. */
  refresh(): void {
    const on = this.voice.isEnabled();
    if (!on) this.cancel();
    this.el.toggle(on);
    this.render();
  }

  async toggle(): Promise<void> {
    if (this.state === "idle") await this.start();
    else if (this.state === "recording") await this.finish();
  }

  /** Stop listening and drop what isn't typed yet (text from earlier pieces stays). */
  cancel(): void {
    if (this.state !== "recording") return;
    this.rec?.cancel();
    this.rec = null;
    this.take = null;
    this.set("idle");
  }

  dispose(): void {
    this.cancel();
    this.stopTicker();
  }

  private async start(): Promise<void> {
    if (!this.voice.isEnabled() || !this.voice.ready()) return;
    this.set("starting");
    const take: Take = { live: this.voice.isLive(), said: "", queue: Promise.resolve(), held: [] };
    this.take = take;
    try {
      this.rec = await this.voice.record(take.live ? (piece) => this.piece(take, piece) : undefined);
    } catch (e) {
      this.take = null;
      this.set("idle");
      new Notice(e instanceof Error ? e.message : String(e), 12000);
      return;
    }
    this.startedAt = Date.now();
    this.set("recording");
    this.ticker = window.setInterval(() => this.tick(), 100);
  }

  private async finish(): Promise<void> {
    const rec = this.rec;
    const take = this.take;
    if (!rec || !take) return;
    this.rec = null;
    this.set("transcribing");
    try {
      const rest = await rec.stop();
      await take.queue;
      this.add(take, await this.voice.transcribe(joinSamples([...take.held, rest]), take.said));
      if (!take.said) new Notice("Didn't hear anything. Check your microphone, or speak a bit louder.");
    } catch (e) {
      new Notice(`Voice input failed: ${e instanceof Error ? e.message : String(e)}`, 15000);
    } finally {
      this.take = null;
      this.set("idle");
    }
  }

  /** The user paused: transcribe this piece after the earlier ones and type it. */
  private piece(take: Take, audio: Float32Array): void {
    take.queue = take.queue.then(async () => {
      if (this.take !== take) return;
      if (take.held.length) {
        take.held.push(audio);
        return;
      }
      try {
        this.add(take, await this.voice.transcribe(audio, take.said));
      } catch {
        // Kept for the end: it's sent again with the rest, and a lasting problem is reported then.
        take.held.push(audio);
      }
    });
  }

  private add(take: Take, text: string): void {
    if (this.take !== take || !text) return;
    this.insert(text);
    take.said = `${take.said} ${text}`.trim();
  }

  private tick(): void {
    const rec = this.rec;
    if (this.state !== "recording" || !rec) return;
    const elapsed = Date.now() - this.startedAt;
    this.timeEl?.setText(formatElapsed(elapsed));
    this.el.style.setProperty("--cw-mic-level", rec.level().toFixed(2));
    if (elapsed >= MAX_RECORDING_MS) void this.finish();
  }

  private stopTicker(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
  }

  private set(state: State): void {
    this.state = state;
    if (state !== "recording") this.stopTicker();
    this.render();
  }

  private render(): void {
    const b = this.el;
    b.empty();
    b.toggleClass("is-recording", this.state === "recording");
    b.toggleClass("is-working", this.state === "starting" || this.state === "transcribing");
    this.timeEl = null;
    switch (this.state) {
      case "recording":
        b.createSpan({ cls: "cw-mic-dot" });
        this.timeEl = b.createSpan({ cls: "cw-footer-label cw-mic-time", text: formatElapsed(Date.now() - this.startedAt) });
        b.setAttr("aria-label", "Stop and transcribe");
        setTooltip(
          b,
          this.take?.live
            ? "Listening. Your words appear when you pause. Click or press Enter to finish (Esc stops and drops the rest)."
            : "Listening. Click or press Enter to stop (Esc cancels).",
          { placement: "top" },
        );
        break;
      case "transcribing":
        setIcon(b.createSpan({ cls: "cw-footer-icon cw-spin" }), "loader");
        b.setAttr("aria-label", "Transcribing");
        setTooltip(b, "Turning your speech into text…", { placement: "top" });
        break;
      default:
        setIcon(b.createSpan({ cls: "cw-footer-icon" }), "mic");
        b.setAttr("aria-label", "Voice input");
        setTooltip(b, `Talk instead of typing\n${this.voice.describe()}`, { placement: "top" });
    }
  }
}
