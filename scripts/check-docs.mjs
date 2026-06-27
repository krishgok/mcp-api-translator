/**
 * Doc/code drift guard: keep the documented MCP tool names in sync with the ones the server
 * actually registers. Run in CI so renaming/adding/removing a tool fails fast unless the docs
 * are updated to match.
 *
 * - Every registered tool name MUST appear in docs/usage-workflow.md (a new tool can't ship
 *   undocumented).
 * - Every tool-shaped token in the docs MUST be a real registered tool (a renamed/removed tool
 *   can't linger as a stale reference).
 *
 * "Tool-shaped" = the distinctive suffixes this project uses: `*_spec`, `*_mcp_server`, or the
 * literal `list_supported_features`. That keeps unrelated identifiers (e.g. `API_BASE_URL`,
 * `mcp-api-translator`) from tripping the check.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// Canonical set: names passed to server.registerTool("<name>", ...) in src/tools.ts.
const toolsSrc = read("src/tools.ts");
const registered = [...toolsSrc.matchAll(/registerTool\(\s*"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
const canonical = new Set(registered);

if (canonical.size === 0) {
  console.error("check-docs: found no registerTool(...) calls in src/tools.ts — pattern broke?");
  process.exit(1);
}

const DOCS = ["docs/usage-workflow.md", "README.md"];
const TOOL_TOKEN =
  /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:spec|mcp_server)|list_supported_features)\b/g;

const errors = [];

// 1. Every registered tool is documented in the main usage doc.
const usage = read("docs/usage-workflow.md");
for (const name of canonical) {
  if (!usage.includes(name)) {
    errors.push(
      `Tool "${name}" is registered in src/tools.ts but not documented in docs/usage-workflow.md`,
    );
  }
}

// 2. Every tool-shaped token in the docs is a real registered tool.
for (const rel of DOCS) {
  const text = read(rel);
  const seen = new Set();
  for (const m of text.matchAll(TOOL_TOKEN)) {
    const token = m[1];
    if (seen.has(token)) continue;
    seen.add(token);
    if (!canonical.has(token)) {
      errors.push(
        `${rel} references "${token}", which is not a registered tool (renamed or removed?)`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("check-docs: documentation is out of sync with the registered MCP tools:\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(`\nRegistered tools: ${[...canonical].join(", ")}`);
  process.exit(1);
}

console.log(`check-docs: OK — ${canonical.size} tools in sync (${[...canonical].join(", ")})`);
