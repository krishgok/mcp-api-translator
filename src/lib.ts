/** Programmatic API (used by scripts/CI; the MCP tools are the primary interface). */
export { parseSource, detectFormat, SUPPORTED_FORMATS } from "./parsers/index.js";
export { generateProject, appendToProject } from "./emitters/project.js";
export { createServer } from "./server.js";
export type { ApiModel } from "./ir/model.js";
