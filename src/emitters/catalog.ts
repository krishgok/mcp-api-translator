/**
 * Machine-readable tool catalog (roadmap R1): a compact name → summary → tags listing that a
 * discovery layer (client-side Tool Search, `defer_loading` rankers) can consume to rank tools
 * without loading every tool's full schema. Deliberately cheap: no input schemas, no request
 * plans — those stay in the tool files / tools.json.
 */
import { GENERATOR_NAME, GENERATOR_VERSION } from "../version.js";

/** Filename of the catalog written at a generated project's root (or by `serve --catalog`). */
export const CATALOG_FILENAME = "tool-catalog.json";

export interface CatalogEntry {
  name: string;
  /** One-line summary (the spec's summary, or "METHOD /path" when the spec has none). */
  summary: string;
  tags: string[];
  method: string;
  path: string;
  sourceTitle: string;
}

/** Serialize catalog entries with a small envelope identifying the producer. */
export function buildCatalog(entries: CatalogEntry[]): string {
  const catalog = {
    generator: GENERATOR_NAME,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: new Date().toISOString(),
    tools: entries,
  };
  return JSON.stringify(catalog, null, 2) + "\n";
}
