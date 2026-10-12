/** `@path` as the composer inserts it (quoted when the path has spaces). */
export function mentionFor(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * Vault paths from files dragged out of Obsidian (file explorer, search, tabs): Obsidian puts
 * documented `obsidian://open?vault=<name>&file=<path>` URIs in `text/uri-list` (".md" left out).
 * URIs for other vaults are ignored.
 */
export function obsidianUriPaths(uriList: string, vaultName: string): string[] {
  const paths: string[] = [];
  for (const line of uriList.split(/\r?\n/)) {
    if (!line.startsWith("obsidian://open?")) continue;
    const params = new URLSearchParams(line.slice("obsidian://open?".length));
    const file = params.get("file");
    if (file && params.get("vault") === vaultName) paths.push(file);
  }
  return paths;
}

/**
 * Absolute path of a file dropped or pasted from the OS. Electron removed `File.path` (v32) in favour
 * of `webUtils.getPathForFile`; Obsidian's renderer has `require`. Null when neither is there.
 */
export function osPathOf(file: File): string | null {
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    const electron = req?.("electron") as { webUtils?: { getPathForFile?(f: File): string } } | undefined;
    const path = electron?.webUtils?.getPathForFile?.(file);
    if (path) return path;
  } catch {
    // not in Electron
  }
  return (file as File & { path?: string }).path || null;
}
