import * as path from "node:path";

export interface LocateEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  isFile(p: string): boolean;
}

/**
 * Find the user's Claude Code executable. The SDK's bundled binary is a
 * ~240 MB per-platform package we can't ship in a plugin, so we always spawn
 * the installed CLI.
 *
 * Windows: only `claude.exe` (native installer) or the npm package's `cli.js`.
 * Never the npm `.cmd`/`.ps1`/extension-less shims: they can't be spawned
 * without a shell (pattern from Claudian, MIT).
 */
export function locateClaude(e: LocateEnv): string | null {
  const win = e.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const pathDirs = (e.env.PATH ?? e.env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  const candidates: string[] = [];

  if (win) {
    candidates.push(p.join(e.home, ".local", "bin", "claude.exe"));
    if (e.env.LOCALAPPDATA) candidates.push(p.join(e.env.LOCALAPPDATA, "Programs", "claude", "claude.exe"));
    for (const dir of pathDirs) candidates.push(p.join(dir, "claude.exe"));
    const npmDirs = [e.env.APPDATA && p.join(e.env.APPDATA, "npm"), e.env.npm_config_prefix].filter(Boolean) as string[];
    for (const dir of npmDirs) candidates.push(p.join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"));
  } else {
    candidates.push(
      p.join(e.home, ".local", "bin", "claude"),
      p.join(e.home, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/usr/bin/claude",
    );
    for (const dir of pathDirs) candidates.push(p.join(dir, "claude"));
  }
  return candidates.find((c) => e.isFile(c)) ?? null;
}

/**
 * GUI-launched Obsidian (macOS Finder, some Linux launchers) gets a minimal
 * PATH; Claude Code needs git, node, rg… from the user's usual locations.
 */
export function enhancedPath(e: Pick<LocateEnv, "platform" | "home" | "env">, claudePath: string | null): string {
  const win = e.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const sep = win ? ";" : ":";
  const extra = win
    ? [p.join(e.home, ".local", "bin")]
    : [p.join(e.home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  if (claudePath) extra.unshift(p.dirname(claudePath));
  const current = (e.env.PATH ?? e.env.Path ?? "").split(sep).filter(Boolean);
  const seen = new Set<string>();
  return [...current, ...extra]
    .filter((d) => {
      const k = win ? d.toLowerCase() : d;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(sep);
}
