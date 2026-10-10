import type { Logger } from "./module-api";

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
    warn: (msg, ...meta) => console.warn(prefix, msg, ...meta),
    error: (msg, ...meta) => console.error(prefix, msg, ...meta),
  };
}
