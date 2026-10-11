import type { EffortLevel } from "../../core/settings";
import { EFFORTS } from "./local-commands";

/** What Claude Code actually runs with, after user settings, model defaults and organization caps. */
export interface AppliedSettings {
  /** Wire model id, e.g. "claude-opus-5-5". */
  model?: string;
  /** null: the model takes no effort level. */
  effort?: EffortLevel | null;
}

/**
 * Reads `applied` from the Agent SDK's `Query.getSettings()`.
 *
 * UNDOCUMENTED: the method exists at runtime (it sends the `get_settings` control request, whose
 * `applied.effort` the public types mention) but is not in the typed `Query` interface. Everything
 * that depends on it goes through here and degrades to null, so the UI just shows "Default".
 */
export async function readAppliedSettings(query: unknown): Promise<AppliedSettings | null> {
  const getSettings = (query as { getSettings?: unknown } | null)?.getSettings;
  if (typeof getSettings !== "function") return null;
  try {
    return parseApplied(await (getSettings as () => Promise<unknown>).call(query));
  } catch {
    return null;
  }
}

export function parseApplied(raw: unknown): AppliedSettings | null {
  const applied = (raw as { applied?: unknown } | null)?.applied;
  if (!applied || typeof applied !== "object") return null;
  const { model, effort } = applied as { model?: unknown; effort?: unknown };
  const out: AppliedSettings = {};
  if (typeof model === "string") out.model = model;
  if (effort === null) out.effort = null;
  else if (EFFORTS.some((e) => e.value === effort)) out.effort = effort as EffortLevel;
  return out;
}
