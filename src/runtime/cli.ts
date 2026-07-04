/**
 * `serve` mode CLI: launch a runtime proxy MCP server for one or more specs.
 *
 *   mcp-api-translator serve --spec ./api.yaml [--spec ./other.yaml] [filters]
 *   mcp-api-translator serve --spec ./api.yaml --transport http --port 3000
 *
 * Runs over stdio by default; `--transport http` serves stateless Streamable HTTP at /mcp (for
 * containers / hosted deploys — see docs/deploy-serve.md). Filters mirror the curation options:
 * --include-tag, --methods, --path-glob, --exclude (repeat --spec / --include-tag / --exclude to
 * pass several). No files are written unless --catalog <path> is set, which writes a
 * machine-readable tool catalog at startup.
 */
import { writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { parseSource } from "../parsers/index.js";
import type { FilterOptions } from "../curation/filter.js";
import { buildCatalog } from "../emitters/catalog.js";
import { ApiProxy, serverFor } from "./server.js";

interface ServeArgs {
  specs: string[];
  format?: "openapi" | "postman" | "auto";
  filters: FilterOptions;
  /** Write a machine-readable tool catalog to this path at startup. */
  catalogPath?: string;
  transport: "stdio" | "http";
  /** HTTP port; only meaningful with --transport http. Defaults to PORT or 3000. */
  port?: number;
}

/** Parse `serve` argv (everything after the `serve` subcommand). */
export function parseServeArgs(argv: string[]): ServeArgs {
  const specs: string[] = [];
  const includeTags: string[] = [];
  const excludeOperations: string[] = [];
  let methods: string[] | undefined;
  let pathGlob: string | undefined;
  let format: ServeArgs["format"] | undefined;
  let catalogPath: string | undefined;
  let transport: ServeArgs["transport"] = "stdio";
  let port: number | undefined;

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
      case "--catalog":
        catalogPath = next();
        break;
      case "--transport": {
        const t = next();
        if (t !== "stdio" && t !== "http") {
          throw new Error(`--transport must be stdio or http (got "${t}")`);
        }
        transport = t;
        break;
      }
      case "--port": {
        port = Number(next());
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error(`--port must be an integer between 0 and 65535`);
        }
        break;
      }
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
  if (port !== undefined && transport !== "http") {
    throw new Error("--port requires --transport http.");
  }

  return { specs, format, filters, catalogPath, transport, port };
}

/** Mount every requested spec and serve them live (stdio by default, or Streamable HTTP). */
export async function runServe(argv: string[]): Promise<void> {
  const { specs, format, filters, catalogPath, transport, port } = parseServeArgs(argv);
  const proxy = new ApiProxy();

  for (const specPath of specs) {
    const model = await parseSource({ specPath, format });
    const result = proxy.mount(model, filters);
    console.error(
      `mounted ${result.mounted} tool(s) from "${model.title}" (${specPath})` +
        (result.filteredOut ? `, ${result.filteredOut} filtered out` : ""),
    );
    if (specs.length > 1) {
      // When aggregating, each API has its own env namespace so credentials don't collide.
      console.error(`  env for this API (bare names also work): ${result.envVars.join(", ")}`);
    }
    for (const w of result.warnings) console.error(`  ! ${w}`);
  }

  if (catalogPath) {
    await writeFile(catalogPath, buildCatalog(proxy.catalog()), "utf8");
    console.error(`wrote tool catalog (${proxy.size} entries) to ${catalogPath}`);
  }

  if (transport === "http") {
    serveHttp(proxy, port ?? Number(process.env.PORT ?? 3000));
    return;
  }

  const server = serverFor(proxy);
  await server.connect(new StdioServerTransport());
  console.error(`mcp-api-translator proxy serving ${proxy.size} tool(s) on stdio`);
}

/**
 * Stateless Streamable HTTP at /mcp: a fresh Server+transport per request, all backed by the one
 * mounted proxy — the same pattern the generated `index.http.ts` uses, including DNS-rebinding
 * protection (override the Host allowlist for non-local deploys via MCP_ALLOWED_HOSTS).
 */
function serveHttp(proxy: ApiProxy, port: number): void {
  const defaultHosts = `127.0.0.1:${port},localhost:${port}`;
  const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? defaultHosts)
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  createHttpServer(async (req, res) => {
    if (!req.url || !req.url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    const server = serverFor(proxy);
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on("close", () => {
      void httpTransport.close();
      void server.close();
    });
    await server.connect(httpTransport);
    await httpTransport.handleRequest(req, res);
  }).listen(port, () => {
    console.error(
      `mcp-api-translator proxy serving ${proxy.size} tool(s) on http://localhost:${port}/mcp`,
    );
  });
}
