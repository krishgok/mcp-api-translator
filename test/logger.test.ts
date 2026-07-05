import { describe, it, expect } from "vitest";
import { createLogger, redactFields, type LoggerOptions } from "../src/runtime/logger.js";

/** Collects written lines and parses them back for assertions. */
function capture(options: Omit<LoggerOptions, "stream" | "now"> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    ...options,
    stream: { write: (chunk: string) => void lines.push(chunk) },
    now: () => new Date("2026-07-05T12:34:56.000Z"),
  });
  return { logger, lines, json: (i = 0) => JSON.parse(lines[i]!) as Record<string, unknown> };
}

describe("logger JSON output", () => {
  it("emits severity/message/time plus flat context fields, one line per entry", () => {
    const { logger, lines, json } = capture({ format: "json", level: "info" });
    logger.info("tool call ok", { tool: "getPet", durationMs: 42 });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(lines[0]!.slice(0, -1)).not.toContain("\n");
    expect(json()).toEqual({
      severity: "INFO",
      message: "tool call ok",
      time: "2026-07-05T12:34:56.000Z",
      tool: "getPet",
      durationMs: 42,
    });
  });

  it("maps warn to the GCP severity WARNING", () => {
    const { logger, json } = capture({ format: "json" });
    logger.warn("careful");
    expect(json().severity).toBe("WARNING");
  });

  it("escapes embedded newlines so an entry stays a single line", () => {
    const { logger, lines, json } = capture({ format: "json" });
    logger.error("boom", { detail: "line1\nline2" });
    expect(lines[0]!.slice(0, -1)).not.toContain("\n");
    expect(json().detail).toBe("line1\nline2");
  });

  it("serializes Error values as { message } without a stack at info level", () => {
    const { logger, json } = capture({ format: "json", level: "info" });
    logger.error("fatal", { error: new Error("bad thing") });
    expect(json().error).toEqual({ message: "bad thing" });
  });

  it("includes the stack for Error values when debug logging is enabled", () => {
    const { logger, json } = capture({ format: "json", level: "debug" });
    logger.error("fatal", { error: new Error("bad thing") });
    const error = json().error as { message: string; stack?: string };
    expect(error.message).toBe("bad thing");
    expect(error.stack).toContain("bad thing");
  });

  it("survives circular context objects", () => {
    const { logger, json } = capture({ format: "json" });
    const loop: Record<string, unknown> = { name: "a" };
    loop.self = loop;
    logger.info("circular", { loop });
    expect((json().loop as Record<string, unknown>).self).toBe("[Circular]");
  });
});

describe("logger level filtering", () => {
  it("drops entries below the configured level", () => {
    const { logger, lines } = capture({ format: "json", level: "warn" });
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    logger.error("yes");
    expect(lines).toHaveLength(2);
  });

  it("defaults to info", () => {
    const { logger, lines } = capture({ format: "json" });
    logger.debug("nope");
    logger.info("yes");
    expect(lines).toHaveLength(1);
  });
});

describe("logger child bindings", () => {
  it("merges bound fields into every entry, with call-site fields winning", () => {
    const { logger, json } = capture({ format: "json" });
    const child = logger.child({ requestId: "r1", phase: "bound" });
    child.info("hello", { phase: "call" });
    expect(json().requestId).toBe("r1");
    expect(json().phase).toBe("call");
  });

  it("nested children accumulate bindings", () => {
    const { logger, json } = capture({ format: "json" });
    logger.child({ a: 1 }).child({ b: 2 }).info("hi");
    expect(json()).toMatchObject({ a: 1, b: 2 });
  });
});

describe("redaction", () => {
  it("scrubs sensitive keys case-insensitively, ignoring - and _", () => {
    const redacted = redactFields({
      Authorization: "Bearer abc",
      "x-api-key": "k",
      client_secret: "s",
      refreshToken: "r",
      safe: "keep",
    });
    expect(redacted).toEqual({
      Authorization: "[REDACTED]",
      "x-api-key": "[REDACTED]",
      client_secret: "[REDACTED]",
      refreshToken: "[REDACTED]",
      safe: "keep",
    });
  });

  it("scrubs nested objects", () => {
    const { logger, json } = capture({ format: "json" });
    logger.info("req", { upstream: { password: "pw", status: 200 } });
    expect(json().upstream).toEqual({ password: "[REDACTED]", status: 200 });
  });
});

describe("text format", () => {
  it("renders HH:MM:SS LEVEL message key=value", () => {
    const { logger, lines } = capture({ format: "text", level: "info" });
    logger.warn("tool call failed", { tool: "getPet", durationMs: 42 });
    expect(lines[0]).toBe("12:34:56 WARNING tool call failed tool=getPet durationMs=42\n");
  });

  it("quotes string values containing whitespace", () => {
    const { logger, lines } = capture({ format: "text" });
    logger.info("msg", { note: "two words" });
    expect(lines[0]).toContain('note="two words"');
  });
});

describe("defaults", () => {
  it("writes to process.stderr, never stdout", () => {
    const logger = createLogger({ format: "json", level: "info" });
    const errWrites: string[] = [];
    const outWrites: string[] = [];
    const errSpy = process.stderr.write.bind(process.stderr);
    const outSpy = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string) => {
      errWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      outWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      logger.info("hello stderr");
    } finally {
      process.stderr.write = errSpy;
      process.stdout.write = outSpy;
    }
    expect(errWrites.join("")).toContain("hello stderr");
    expect(outWrites).toEqual([]);
  });
});
