/**
 * Curation pipeline: filter operations, then assign final unique tool names.
 *
 * Runs after parsing and before emission. `reservedNames` lets an append operation keep the
 * names already used by an existing generated project, so newly added tools never collide with
 * (or silently overwrite) the originals.
 */
import type { ApiModel, Operation } from "../ir/model.js";
import { applyFilters, type FilterOptions } from "./filter.js";
import { uniqueToolName } from "./naming.js";

/** Above this many tools, callers should warn and suggest filters. */
export const TOOL_COUNT_WARN_THRESHOLD = 40;

export interface CurationResult {
  operations: Operation[];
  /** Number of operations dropped by filters. */
  filteredOut: number;
}

export function curate(
  model: ApiModel,
  filters: FilterOptions,
  reservedNames: Set<string> = new Set(),
): CurationResult {
  const before = model.operations.length;
  const kept = applyFilters(model.operations, filters);

  // Deterministic order so generated output is stable across runs.
  kept.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  for (const op of kept) {
    op.toolName = uniqueToolName(op.toolName, reservedNames);
  }

  return { operations: kept, filteredOut: before - kept.length };
}
