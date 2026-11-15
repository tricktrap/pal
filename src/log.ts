/**
 * Minimal JSON-lines logger for PAL (ACP reliability plan, item 7).
 *
 * - Zero dependencies.
 * - ALWAYS writes to stderr. In ACP mode stdout is the protocol channel and
 *   any stray byte corrupts the ndjson stream for the rest of the session.
 * - Level comes from the LOG_LEVEL env var (default "info"); the `--verbose`
 *   flag lowers it to "debug" (see main.ts).
 */

export type Level = "debug" | "info" | "warn" | "error";

const WEIGHT: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = WEIGHT[(process.env.LOG_LEVEL as Level)] ?? WEIGHT.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (WEIGHT[level] < threshold) return;
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
  if (fields) Object.assign(line, fields);
  try {
    process.stderr.write(JSON.stringify(line) + "\n");
  } catch {
    // A non-serializable field must never take the agent down.
    process.stderr.write(`[log] ${level} ${msg}\n`);
  }
}

/** JSON-safe, single-line description of an unknown thrown value. */
export function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return `${err.name}: ${err.message}`;
  return String(err);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  setLevel: (level: Level) => {
    threshold = WEIGHT[level];
  },
};
