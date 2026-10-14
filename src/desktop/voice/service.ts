/** What the chat view needs from voice input (no Node imports: the UI preview fakes it). */

export interface VoiceRecording {
  /** Input loudness right now, 0–1 (for the level indicator). */
  level(): number;
  /** Stop and return the audio (16 kHz mono) not yet handed out as pieces: the whole take without them. */
  stop(): Promise<Float32Array>;
  /** Stop and throw the audio away. */
  cancel(): void;
}

export interface VoiceService {
  /** The user turned voice input on: show the mic. */
  isEnabled(): boolean;
  /** Text appears at each pause while the user talks (else all at once when they stop). */
  isLive(): boolean;
  /** Called when voice settings change (the mic appears or disappears). Returns an unsubscribe. */
  onChange(fn: () => void): () => void;
  /** Configured and usable; if not, tells the user what to fix and returns false. */
  ready(): boolean;
  /**
   * Start the microphone. With `onPiece`, the recording is cut at pauses and each piece is handed over as
   * soon as the speaker pauses. Throws an Error with a readable message.
   */
  record(onPiece?: (audio: Float32Array) => void): Promise<VoiceRecording>;
  /** Text for a recording; "" when nothing was said. `before`: what this dictation already said. */
  transcribe(audio: Float32Array, before?: string): Promise<string>;
  /** One line for the mic's tooltip: service, model, last timing. */
  describe(): string;
}
