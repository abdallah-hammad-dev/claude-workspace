/**
 * Pure merge logic for the files the installer writes into the vault.
 * Always merge, never clobber: unknown keys and other servers/hooks are kept.
 */

export interface InstallTarget {
  serverName: string;
  port: number;
  token: string;
}

type Json = Record<string, unknown>;

export function mcpUrl(t: InstallTarget): string {
  return `http://127.0.0.1:${t.port}/mcp`;
}

export function contextUrl(t: InstallTarget): string {
  return `http://127.0.0.1:${t.port}/context`;
}

export function mcpServerEntry(t: InstallTarget): Json {
  return { type: "http", url: mcpUrl(t), headers: { Authorization: `Bearer ${t.token}` } };
}

/** `<vault>/.mcp.json` */
export function mergeMcpJson(existing: unknown, t: InstallTarget): Json {
  const base = asObject(existing);
  return { ...base, mcpServers: { ...asObject(base.mcpServers), [t.serverName]: mcpServerEntry(t) } };
}

/** A hook we installed before (any port, any version: curl command or http hook). */
export function isOurHook(h: unknown): boolean {
  const o = asObject(h);
  const target = typeof o.url === "string" ? o.url : typeof o.command === "string" ? o.command : "";
  return /127\.0\.0\.1:\d+\/context\b/.test(target);
}

/** `<vault>/.claude/settings.json`: approve our .mcp.json server + the UserPromptSubmit HTTP hook. */
export function mergeClaudeSettings(existing: unknown, t: InstallTarget): Json {
  const base = asObject(existing);
  const enabled = Array.isArray(base.enabledMcpjsonServers) ? (base.enabledMcpjsonServers as unknown[]) : [];
  const hooks = asObject(base.hooks);
  const groups = Array.isArray(hooks.UserPromptSubmit) ? (hooks.UserPromptSubmit as unknown[]) : [];

  const kept = groups
    .map((g) => {
      const group = asObject(g);
      const list = Array.isArray(group.hooks) ? (group.hooks as unknown[]) : [];
      return { ...group, hooks: list.filter((h) => !isOurHook(h)) };
    })
    .filter((g) => g.hooks.length > 0);

  kept.push({
    hooks: [
      {
        type: "http",
        url: contextUrl(t),
        headers: { Authorization: `Bearer ${t.token}` },
        timeout: 3,
      },
    ],
  });

  return {
    ...base,
    enabledMcpjsonServers: [...new Set([...enabled, t.serverName])],
    hooks: { ...hooks, UserPromptSubmit: kept },
  };
}

/** What `claude mcp add` needs to register the server for every project (user scope). */
export function mcpAddCommand(t: InstallTarget): string {
  return `claude mcp add --scope user --transport http ${t.serverName} ${mcpUrl(t)} --header "Authorization: Bearer ${t.token}"`;
}

/** Is the vault config pointing at this exact server + token? */
export function isInstalled(mcpJson: unknown, settings: unknown, t: InstallTarget): boolean {
  const entry = asObject(asObject(asObject(mcpJson).mcpServers)[t.serverName]);
  const headers = asObject(entry.headers);
  if (entry.url !== mcpUrl(t) || headers.Authorization !== `Bearer ${t.token}`) return false;
  const groups = asObject(asObject(settings).hooks).UserPromptSubmit;
  if (!Array.isArray(groups)) return false;
  return groups.some((g) => {
    const list = asObject(g).hooks;
    return (
      Array.isArray(list) &&
      list.some((h) => {
        const o = asObject(h);
        return o.url === contextUrl(t) && asObject(o.headers).Authorization === `Bearer ${t.token}`;
      })
    );
  });
}

function asObject(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}
