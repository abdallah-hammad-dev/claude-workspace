import { describe, expect, it } from "vitest";
import { patchSetMaxListenersForElectron } from "../src/desktop/electron-compat";

describe("patchSetMaxListenersForElectron", () => {
  const strict = (_n?: number, ...targets: unknown[]) => {
    if (targets.some((t) => !(t instanceof EventTarget))) throw new TypeError("eventTargets must be an EventTarget");
  };

  it("ignores foreign AbortSignal-like targets but keeps other errors", () => {
    const mod = { setMaxListeners: strict as never };
    const undo = patchSetMaxListenersForElectron(mod);
    const foreignSignal = { aborted: false, addEventListener() {} };
    expect(() => (mod.setMaxListeners as (n: number, ...t: unknown[]) => void)(50, foreignSignal)).not.toThrow();
    expect(() => (mod.setMaxListeners as (n: number, ...t: unknown[]) => void)(50, { notASignal: true })).toThrow();
    undo();
    expect(mod.setMaxListeners).toBe(strict);
  });
});
