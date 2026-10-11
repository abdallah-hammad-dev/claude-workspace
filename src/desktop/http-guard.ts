/**
 * Request checks for the local server. Pure so it can be unit-tested.
 *
 * - Host must be 127.0.0.1/localhost on our port (blocks DNS rebinding).
 * - Any Origin header is rejected: browsers always send one, Claude Code never does.
 * - Bearer token must match (constant-time compare).
 */
export interface GuardInput {
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

export function checkRequest(req: GuardInput, port: number, token: string): GuardResult {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!req.host || !allowedHosts.includes(req.host.toLowerCase())) {
    return { ok: false, status: 403, reason: "unexpected Host header" };
  }
  if (req.origin !== undefined) return { ok: false, status: 403, reason: "browser requests are not allowed" };
  const expected = `Bearer ${token}`;
  if (!token || !req.authorization || !timingSafeEqual(req.authorization, expected)) {
    return { ok: false, status: 401, reason: "missing or invalid token" };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable per-vault default port in 27200–27999 so several vaults can run side by side. */
export function defaultPortFor(vaultId: string): number {
  let h = 0;
  for (const c of vaultId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 27200 + (h % 800);
}
