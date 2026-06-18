/**
 * Builds LLM-friendly tool descriptions from whatever the source spec provides.
 *
 * A good description is the single biggest lever on tool-selection accuracy, so we combine the
 * summary, the long description, and per-parameter docs into one bounded block. Specs vary
 * wildly in quality, so this is best-effort: we never invent semantics, we only surface what's
 * there.
 */
import type { Operation } from "../ir/model.js";

const MAX_DESCRIPTION_LENGTH = 1024;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function buildDescription(op: Operation): string {
  const parts: string[] = [];
  const headline = op.summary?.trim() || op.description?.trim();
  if (headline) parts.push(headline);
  else parts.push(`${op.method} ${op.path}`);

  if (op.description && op.description.trim() && op.description.trim() !== headline) {
    parts.push(op.description.trim());
  }

  parts.push(`Calls ${op.method} ${op.path}.`);

  const documentedParams = op.parameters.filter((p) => p.description?.trim());
  if (documentedParams.length > 0) {
    const lines = documentedParams.map(
      (p) => `- ${p.name} (${p.in}${p.required ? ", required" : ""}): ${p.description!.trim()}`,
    );
    parts.push(`Parameters:\n${lines.join("\n")}`);
  }

  return truncate(parts.join("\n\n"), MAX_DESCRIPTION_LENGTH);
}
