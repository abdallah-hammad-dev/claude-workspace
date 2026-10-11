import type { Logger } from "./module-api";

type Sink = (level: "warn" | "error", line: string) => void;
let sink: Sink | null = null;

/** Desktop installs a sink that appends warnings/errors to the plugin's debug.log. */
export function setLogSink(s: Sink | null): void {
  sink = s;
}

function describe(meta: unknown[]): string {
  return meta
    .map((m) => (m instanceof Error ? `${m.message}\n${m.stack ?? ""}` : typeof m === "string" ? m : safeJson(m)))
    .join(" ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Console logger with a prefix. Never pass tokens, note contents or tool
 * arguments as `meta` — logs end up in bug reports.
 */
export function createLogger(scope: string, isDebug: () => boolean = () => false): Logger {
  const prefix = `[claude-workspace:${scope}]`;
  return {
    debug: (msg, ...meta) => {
      if (isDebug()) console.debug(prefix, msg, ...meta);
    },
    // eslint-disable-next-line no-console
    info: (msg, ...meta) => console.info(prefix, msg, ...meta),
    warn: (msg, ...meta) => {
      console.warn(prefix, msg, ...meta);
      sink?.("warn", `${prefix} ${msg} ${describe(meta)}`);
    },
    error: (msg, ...meta) => {
      console.error(prefix, msg, ...meta);
      sink?.("error", `${prefix} ${msg} ${describe(meta)}`);
    },
  };
}
