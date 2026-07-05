/**
 * Zero-dependency structured logger.
 *
 * Writes one line per entry to stderr — NEVER stdout, which carries MCP JSON-RPC on the stdio
 * transport. In containers (stderr not a TTY) entries are JSON objects whose fields GCP Cloud
 * Logging and AWS CloudWatch parse natively (`severity`, `message`, `time`, plus flat context);
 * on a TTY they render as human-readable text. Override with LOG_FORMAT=json|text, and set the
 * threshold with LOG_LEVEL=debug|info|warn|error (default info).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** New logger whose entries always include `bindings` (e.g. { api } or { requestId }). */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: "json" | "text";
  /** Sink for finished lines (defaults to process.stderr). Injectable for tests. */
  stream?: { write(chunk: string): boolean | void };
  /** Clock, injectable for deterministic test timestamps. */
  now?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** GCP Cloud Logging severity names (note warn → WARNING); CloudWatch filters them as-is. */
const SEVERITY: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

/** Context keys whose values are scrubbed, compared case-insensitively ignoring `-`/`_`. */
const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "token",
  "refreshtoken",
  "accesstoken",
  "idtoken",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "apikey",
  "xapikey",
  "credential",
  "credentials",
]);

const MAX_REDACT_DEPTH = 4;

function isRedactedKey(key: string): boolean {
  return REDACTED_KEYS.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/**
 * Copies `fields`, replacing sensitive values with "[REDACTED]", turning Errors into plain
 * objects (stack only when debug logging is enabled), and breaking reference cycles.
 */
function scrub(
  fields: LogFields,
  includeStack: boolean,
  depth: number,
  seen: WeakSet<object>,
): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isRedactedKey(key)) {
      out[key] = "[REDACTED]";
    } else if (value instanceof Error) {
      out[key] =
        includeStack && value.stack
          ? { message: value.message, stack: value.stack }
          : { message: value.message };
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      depth < MAX_REDACT_DEPTH
    ) {
      if (seen.has(value)) {
        out[key] = "[Circular]";
      } else {
        seen.add(value);
        out[key] = scrub(value as LogFields, includeStack, depth + 1, seen);
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Returns a copy of `fields` with sensitive values replaced by "[REDACTED]". */
export function redactFields(fields: LogFields): LogFields {
  return scrub(fields, false, 0, new WeakSet());
}

function safeStringify(entry: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(entry, (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch {
    return JSON.stringify({
      severity: entry.severity,
      message: String(entry.message),
      time: entry.time,
    });
  }
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return /[\s"=]/.test(value) || value === "" ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return safeStringify({ v: value }).slice(5, -1);
}

interface LoggerState {
  level: LogLevel;
  format: "json" | "text";
  stream: { write(chunk: string): boolean | void };
  now: () => Date;
}

function envLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  return raw in LEVEL_RANK ? (raw as LogLevel) : "info";
}

function envFormat(): "json" | "text" {
  const raw = (process.env.LOG_FORMAT ?? "").toLowerCase();
  if (raw === "json" || raw === "text") return raw;
  return process.stderr.isTTY ? "text" : "json";
}

function makeLogger(state: LoggerState, bindings: LogFields): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[state.level]) return;
    const ctx = scrub({ ...bindings, ...fields }, state.level === "debug", 0, new WeakSet());
    const time = state.now();
    if (state.format === "json") {
      state.stream.write(
        safeStringify({ severity: SEVERITY[level], message, time: time.toISOString(), ...ctx }) +
          "\n",
      );
    } else {
      const pairs = Object.entries(ctx)
        .map(([k, v]) => ` ${k}=${textValue(v)}`)
        .join("");
      state.stream.write(
        `${time.toISOString().slice(11, 19)} ${SEVERITY[level]} ${message}${pairs}\n`,
      );
    }
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (extra) => makeLogger(state, { ...bindings, ...extra }),
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return makeLogger(
    {
      level: options.level ?? envLevel(),
      format: options.format ?? envFormat(),
      stream: options.stream ?? process.stderr,
      now: options.now ?? (() => new Date()),
    },
    {},
  );
}

const rootState: LoggerState = {
  level: envLevel(),
  format: envFormat(),
  stream: process.stderr,
  now: () => new Date(),
};

/** Root logger, configured from the environment at import time (see setLevel for overrides). */
export const log: Logger = makeLogger(rootState, {});

/** Raise/lower the root logger's threshold after startup (used by the --log-level flag). */
export function setLevel(level: LogLevel): void {
  rootState.level = level;
}
