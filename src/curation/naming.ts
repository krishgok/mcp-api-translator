/**
 * Turns operation identifiers into MCP-safe, unique tool names.
 *
 * MCP tool names must be reasonably short and restricted in character set; many real specs
 * either omit `operationId` or use characters that aren't valid. We derive a stable name and
 * de-duplicate collisions deterministically so re-running produces the same output.
 */

const MAX_NAME_LENGTH = 64;

/** Strip to `[a-zA-Z0-9_]`, collapse separators, trim, and bound the length. */
export function sanitizeToolName(raw: string): string {
  let name = raw
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (name.length === 0) name = "operation";
  // Tool names must not start with a digit (keeps them valid JS identifiers downstream too).
  if (/^[0-9]/.test(name)) name = `op_${name}`;
  if (name.length > MAX_NAME_LENGTH) name = name.slice(0, MAX_NAME_LENGTH).replace(/_+$/, "");
  return name;
}

/** Fallback name derived from method + path, e.g. GET /pets/{id} -> "get_pets_by_id". */
export function nameFromMethodPath(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      const m = seg.match(/^\{(.+)\}$/);
      return m ? `by_${m[1]}` : seg;
    });
  return sanitizeToolName(`${method.toLowerCase()}_${segments.join("_")}`);
}

/**
 * Assign a unique tool name. `taken` is mutated to record the assigned name so the caller can
 * thread it across many operations (and across an append against an existing project).
 */
export function uniqueToolName(base: string, taken: Set<string>): string {
  const sanitized = sanitizeToolName(base);
  if (!taken.has(sanitized)) {
    taken.add(sanitized);
    return sanitized;
  }
  let i = 2;
  while (taken.has(`${sanitized}_${i}`)) i++;
  const result = `${sanitized}_${i}`;
  taken.add(result);
  return result;
}
