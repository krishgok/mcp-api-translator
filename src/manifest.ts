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
 *
 * v2: per-source env namespacing — sources carry `namespace`/`baseUrl`/`schemeNames`, and the
 * regenerated shared infrastructure threads a source namespace through auth/base-URL resolution.
 * A v1 generator extending a v2 project would regenerate that infrastructure without the
 * namespace parameter and break compilation, so v1 generators must refuse (which the version
 * guard in the append path does).
 */
export const MANIFEST_VERSION = 2;

export interface ManifestTool {
  name: string;
  method: string;
  path: string;
  sourceTitle: string;
  /** One-line summary for the tool catalog; absent on legacy manifests. */
  summary?: string;
  /** Spec tags for the tool catalog; absent on legacy manifests. */
  tags?: string[];
}

export interface ManifestSource {
  format: string;
  title: string;
  version: string;
  addedAt: string;
  /** Env namespace for this source (from its title); absent on legacy (v1) manifests. */
  namespace?: string;
  /** This source's first declared server; absent on legacy (v1) manifests. */
  baseUrl?: string;
  /** Names of the security schemes this source declared; absent on legacy (v1) manifests. */
  schemeNames?: string[];
}

/** Output language of a generated project. */
export type Language = "typescript" | "python";

export interface TranslatorManifest {
  /** Schema version of this manifest file; see {@link MANIFEST_VERSION}. */
  manifestVersion: number;
  generator: string;
  generatorVersion: string;
  /** Output language; absent on legacy (pre-Python) manifests, treated as "typescript". */
  language?: Language;
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
