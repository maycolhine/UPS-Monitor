/**
 * Minimal log, one line per event (stdout), in the same spirit as the collector:
 * no external dependency, with a level configurable via VIEWER_LOG_LEVEL.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel = "info", scope = "viewer"): Logger {
  const threshold = ORDER[level] ?? ORDER.info;

  const emit = (lvl: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const parts = [
      new Date().toISOString(),
      lvl.toUpperCase(),
      `${scope}:`,
      message,
    ];
    if (context && Object.keys(context).length > 0) {
      parts.push(JSON.stringify(context));
    }
    process.stdout.write(`${parts.join(" ")}\n`);
  };

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
  };
}
