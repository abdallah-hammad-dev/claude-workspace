import type { App } from "obsidian";

/**
 * Obsidian's plugin manager (`app.plugins`) is NOT part of the public API.
 * Everything that touches it lives in this file. A plugin's `manifest` itself is public.
 */
export interface PluginInfo {
  /** Manifest id, as Obsidian uses it (`.obsidian/plugins/<id>/`). */
  id: string;
  name: string;
  version: string;
}

interface InternalPlugins {
  plugins?: Record<string, { manifest?: { name?: unknown; version?: unknown } } | undefined>;
}

/** Plugins that are enabled and loaded right now. Empty if the internal API is missing. */
export function loadedPlugins(app: App): PluginInfo[] {
  const table = (app as unknown as { plugins?: InternalPlugins }).plugins?.plugins;
  if (!table || typeof table !== "object") return [];
  return Object.entries(table).map(([id, p]) => ({
    id,
    name: typeof p?.manifest?.name === "string" ? p.manifest.name : id,
    version: typeof p?.manifest?.version === "string" ? p.manifest.version : "",
  }));
}

export function loadedPlugin(app: App, id: string): PluginInfo | null {
  return loadedPlugins(app).find((p) => p.id === id) ?? null;
}

/**
 * Compares "x.y.z" versions part by part, as numbers; missing parts count as 0.
 * A pre-release ("2.29.0-beta-1") comes before its release.
 */
export function compareVersions(a: string, b: string): number {
  const [na, pa] = splitVersion(a);
  const [nb, pb] = splitVersion(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

function splitVersion(v: string): [number[], string] {
  const [main = "", ...pre] = v.trim().split("-");
  return [main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre.join("-")];
}
