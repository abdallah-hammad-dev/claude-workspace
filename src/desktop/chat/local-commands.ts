import type { EffortLevel } from "../../core/settings";

export const EFFORTS: { value: EffortLevel; label: string; desc: string }[] = [
  { value: "low", label: "Low", desc: "Fastest answers" },
  { value: "medium", label: "Medium", desc: "Balanced" },
  { value: "high", label: "High", desc: "Thinks harder" },
  { value: "xhigh", label: "Extra high", desc: "Deeper reasoning, slower" },
  { value: "max", label: "Max", desc: "Deepest reasoning, slowest" },
];

/**
 * Slash commands the chat view handles itself because Claude Code's versions are interactive
 * pickers in a terminal (`/effort` and `/model` with no argument only print usage over the SDK).
 */
export type LocalCommand =
  | { kind: "clear" }
  | { kind: "effort"; level: EffortLevel | "" | null; arg: string }
  | { kind: "model"; arg: string };

/** `level`: "" resets to the model's default, null means the argument isn't a level. */
export function parseLocalCommand(text: string): LocalCommand | null {
  const m = /^\/(clear|effort|model)(?:\s+(.*))?$/s.exec(text.trim());
  if (!m) return null;
  const arg = (m[2] ?? "").trim();
  if (m[1] === "clear") return arg ? null : { kind: "clear" };
  if (m[1] === "model") return { kind: "model", arg };
  const a = arg.toLowerCase();
  const level = !a ? null : a === "auto" || a === "default" ? "" : (EFFORTS.find((e) => e.value === a || e.label.toLowerCase() === a)?.value ?? null);
  return { kind: "effort", level, arg };
}
