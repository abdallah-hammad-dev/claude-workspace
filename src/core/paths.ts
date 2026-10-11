import { normalizePath, type App } from "obsidian";

/** Absolute vault folder on desktop, null on mobile. */
export function vaultBasePath(app: App): string | null {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : null;
}

/**
 * Turn whatever Claude passes (vault-relative, absolute, Windows backslashes,
 * leading "./") into a vault path. "" is the vault root; null means outside the vault.
 */
export function toVaultPath(input: string, basePath: string | null): string | null {
  let p = input.trim().replace(/\\/g, "/");
  const base = basePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
  const windowsBase = !!base && /^[a-z]:\//i.test(base);
  const absolute = windowsBase ? /^[a-z]:\//i.test(p) : !!base && p.startsWith("/");

  if (absolute && base) {
    const hay = windowsBase ? p.toLowerCase() : p;
    const needle = windowsBase ? base.toLowerCase() : base;
    if (hay === needle) return "";
    if (!hay.startsWith(needle + "/")) return null;
    p = p.slice(base.length + 1);
  }
  p = p.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
  if (p.split("/").includes("..")) return null;
  return p === "" ? "" : normalizePath(p);
}
