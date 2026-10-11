import events from "node:events";

type SetMaxListeners = typeof events.setMaxListeners;

/**
 * In Obsidian's renderer, `new AbortController()` is the browser's. The Agent SDK
 * calls Node's `events.setMaxListeners(n, signal)`, which rejects non-Node
 * EventTargets ("The eventTargets argument must be an instance of EventEmitter or
 * EventTarget. Received an instance of AbortSignal"). That call only silences a
 * MaxListenersExceeded warning, so skipping it for foreign AbortSignals is safe.
 * Same fix as Claudian (MIT), reimplemented. Returns an undo function.
 */
export function patchSetMaxListenersForElectron(mod: { setMaxListeners: SetMaxListeners } = events): () => void {
  const original = mod.setMaxListeners;
  const patched: SetMaxListeners = (n?: number, ...targets: (EventTarget | NodeJS.EventEmitter)[]) => {
    try {
      original(n, ...targets);
    } catch (e) {
      const foreignSignals = targets.length > 0 && targets.every(isAbortSignalLike);
      if (!foreignSignals) throw e;
    }
  };
  try {
    mod.setMaxListeners = patched;
  } catch {
    return () => undefined; // frozen module namespace (tests); nothing to undo
  }
  return () => {
    if (mod.setMaxListeners === patched) mod.setMaxListeners = original;
  };
}

function isAbortSignalLike(v: unknown): boolean {
  return !!v && typeof v === "object" && "aborted" in v && typeof (v as { addEventListener?: unknown }).addEventListener === "function";
}
