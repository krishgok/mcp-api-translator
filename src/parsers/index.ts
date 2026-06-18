/**
 * Source loading, format detection, and parser dispatch.
 *
 * A "source" is either inline text (JSON or YAML) or a path to a local file. We parse it into a
 * plain object, detect whether it's an OpenAPI document or a Postman collection, and hand it to
 * the matching parser. This is the registry seam: adding a new input format is one entry here
 * plus a parser module.
 */
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ApiModel, SourceFormat } from "../ir/model.js";
import { parseOpenApi } from "./openapi.js";
import { parsePostman } from "./postman.js";

export interface SourceInput {
  /** Inline JSON or YAML spec text. */
  spec?: string;
  /** Path to a local spec file (JSON or YAML). */
  specPath?: string;
  /** Force a format instead of auto-detecting. */
  format?: SourceFormat | "auto";
}

/** Parse inline text or read a file, returning the raw spec object. */
export async function loadRawSpec(input: SourceInput): Promise<unknown> {
  let text: string;
  if (input.spec && input.spec.trim().length > 0) {
    text = input.spec;
  } else if (input.specPath) {
    text = await readFile(input.specPath, "utf8");
  } else {
    throw new Error("Provide either `spec` (inline text) or `specPath` (a local file path).");
  }
  // YAML is a superset of JSON, so a single YAML parse handles both formats.
  try {
    return parseYaml(text);
  } catch (err) {
    throw new Error(`Could not parse spec as JSON or YAML: ${(err as Error).message}`);
  }
}

export function detectFormat(raw: unknown): SourceFormat {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if ("openapi" in obj || "swagger" in obj) return "openapi";
    const info = obj.info as Record<string, unknown> | undefined;
    const schema = typeof info?.schema === "string" ? info.schema : "";
    if (
      schema.includes("getpostman.com") ||
      "_postman_id" in (info ?? {}) ||
      Array.isArray(obj.item)
    ) {
      return "postman";
    }
  }
  throw new Error(
    'Could not detect the spec format. Pass `format: "openapi"` or `format: "postman"` explicitly.',
  );
}

/** Load, detect, and parse a source into the shared {@link ApiModel}. */
export async function parseSource(input: SourceInput): Promise<ApiModel> {
  const raw = await loadRawSpec(input);
  const format = !input.format || input.format === "auto" ? detectFormat(raw) : input.format;
  switch (format) {
    case "openapi":
      return parseOpenApi(raw);
    case "postman":
      return parsePostman(raw);
    default:
      throw new Error(`Unsupported format: ${format as string}`);
  }
}

export const SUPPORTED_FORMATS: SourceFormat[] = ["openapi", "postman"];
