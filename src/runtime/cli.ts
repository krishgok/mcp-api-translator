/**
 * `serve` mode CLI: launch a runtime proxy MCP server over stdio for one or more specs.
 *
 *   mcp-api-translator serve --spec ./api.yaml [--spec ./other.yaml] [filters]
 *
 * Filters mirror the curation options: --include-tag, --methods, --path-glob, --exclude
 * (repeat --spec / --include-tag / --exclude to pass several). No files are written.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseSource } from "../parsers/index.js";
import type { FilterOptions } from "../curation/filter.js";
import { createProxyServer } from "./server.js";

interface ServeArgs {
  specs: string[];
  format?: "openapi" | "postman" | "auto";
  filters: FilterOptions;
}

/** Parse `serve` argv (everything after the `serve` subcommand). */
export function parseServeArgs(argv: string[]): ServeArgs {
  const specs: string[] = [];
  const includeTags: string[] = [];
  const excludeOperations: string[] = [];
  let methods: string[] | undefined;
  let pathGlob: string | undefined;
  let format: ServeArgs["format"] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case "--spec":
        specs.push(next());
        break;
      case "--include-tag":
        includeTags.push(next());
        break;
      case "--exclude":
        excludeOperations.push(next());
        break;
      case "--methods":
        methods = next()
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
        break;
      case "--path-glob":
        pathGlob = next();
        break;
      case "--format": {
        const f = next();
        if (f !== "openapi" && f !== "postman" && f !== "auto") {
          throw new Error(`--format must be openapi, postman, or auto (got "${f}")`);
        }
        format = f;
        break;
      }
      default:
        throw new Error(`Unknown serve option: ${arg}`);
    }
  }

  if (specs.length === 0) {
    throw new Error("serve requires at least one --spec <path>.");
  }

  const filters: FilterOptions = {};
  if (includeTags.length) filters.includeTags = includeTags;
  if (excludeOperations.length) filters.excludeOperations = excludeOperations;
  if (methods) filters.methods = methods;
  if (pathGlob) filters.pathGlob = pathGlob;

  return { specs, format, filters };
}

/** Mount every requested spec and serve them live over stdio. */
export async function runServe(argv: string[]): Promise<void> {
  const { specs, format, filters } = parseServeArgs(argv);
  const { server, proxy } = createProxyServer();

  for (const specPath of specs) {
    const model = await parseSource({ specPath, format });
    const result = proxy.mount(model, filters);
    console.error(
      `mounted ${result.mounted} tool(s) from "${model.title}" (${specPath})` +
        (result.filteredOut ? `, ${result.filteredOut} filtered out` : ""),
    );
    for (const w of result.warnings) console.error(`  ! ${w}`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`mcp-api-translator proxy serving ${proxy.size} tool(s) on stdio`);
}
