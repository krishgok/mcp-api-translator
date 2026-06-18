/**
 * The `.mcp-translator.json` manifest carried by every generated project.
 *
 * It records enough to (a) regenerate the shared infrastructure files on append and (b) detect
 * which operations already exist, so appending the same spec twice is a no-op. It is the single
 * source of truth the append path reads — the original spec is not needed again.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecurityScheme } from "./ir/model.js";

export const MANIFEST_FILENAME = ".mcp-translator.json";

/**
 * Schema version of the `.mcp-translator.json` format. Bump on a breaking change to the manifest
 * shape; the append path refuses manifests written by a newer (higher) version so it never
 * misreads a format it doesn't understand.
 */
export const MANIFEST_VERSION = 1;

export interface ManifestTool {
  name: string;
  method: string;
  path: string;
  sourceTitle: string;
}

export interface ManifestSource {
  format: string;
  title: string;
  version: string;
  addedAt: string;
}

export interface TranslatorManifest {
  /** Schema version of this manifest file; see {@link MANIFEST_VERSION}. */
  manifestVersion: number;
  generator: string;
  generatorVersion: string;
  serverName: string;
  serverVersion: string;
  description?: string;
  transport: "stdio" | "http" | "both";
  servers: string[];
  securitySchemes: SecurityScheme[];
  sources: ManifestSource[];
  tools: ManifestTool[];
}

export function manifestPath(projectDir: string): string {
  return path.join(projectDir, MANIFEST_FILENAME);
}

export async function readManifest(projectDir: string): Promise<TranslatorManifest | null> {
  try {
    const text = await readFile(manifestPath(projectDir), "utf8");
    return JSON.parse(text) as TranslatorManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeManifest(
  projectDir: string,
  manifest: TranslatorManifest,
): Promise<void> {
  await writeFile(manifestPath(projectDir), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** Stable key identifying an operation regardless of its assigned tool name. */
export function operationKey(method: string, opPath: string): string {
  return `${method.toUpperCase()} ${opPath}`;
}
