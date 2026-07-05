/**
 * Runtime proxy: expose a spec's operations as live MCP tools in-process — no code generation.
 *
 * `serve` mode mounts one or more {@link ApiModel}s into an {@link ApiProxy} and serves them over a
 * low-level MCP Server. Each tool advertises the same raw JSON-Schema input the generator would have
 * emitted (no lossy zod round-trip) and executes via the shared runtime client, so behavior matches
 * the generated server exactly. Mounting several specs aggregates multiple APIs into one server.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ApiModel, JsonSchema, SecurityScheme } from "../ir/model.js";
import { curate, TOOL_COUNT_WARN_THRESHOLD } from "../curation/index.js";
import type { FilterOptions } from "../curation/filter.js";
import { operationToToolEmit } from "../emitters/project.js";
import type { CatalogEntry } from "../emitters/catalog.js";
import { envNamespace } from "../parsers/security.js";
import { executePlan, type FetchLike, type RuntimeContext } from "./client.js";
import { log, type Logger } from "./logger.js";
import type { RequestPlanData } from "../emitters/templates.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "../version.js";

interface MountedTool {
  name: string;
  description: string;
  /** One-line summary + tags for the tool catalog. */
  summary: string;
  tags: string[];
  inputSchema: JsonSchema;
  plan: RequestPlanData;
  /** Title of the API this tool came from. */
  sourceTitle: string;
  /** This API's first declared server, used unless API_BASE_URL overrides it. */
  defaultBaseUrl: string;
  securitySchemes: SecurityScheme[];
  /** Per-source env namespace (from the API title) for base URL + credential resolution. */
  sourceNamespace: string;
}

export interface MountResult {
  mounted: number;
  /** Operations dropped by filters. */
  filteredOut: number;
  toolNames: string[];
  warnings: string[];
  /** Env namespace for this source (from its title). */
  sourceNamespace: string;
  /** Per-source env vars this API reads (base URL + credentials), each with a bare-name fallback. */
  envVars: string[];
}

/** Holds the live tool set across one or more mounted APIs. */
export class ApiProxy {
  private readonly tools = new Map<string, MountedTool>();

  /** Curate a model's operations and register them as live tools (deduping names across mounts). */
  mount(model: ApiModel, filters: FilterOptions = {}): MountResult {
    const reserved = new Set(this.tools.keys());
    const { operations, filteredOut } = curate(model, filters, reserved);
    const defaultBaseUrl = model.servers[0] ?? "";
    const sourceNamespace = envNamespace(model.title);
    const added: string[] = [];
    for (const op of operations) {
      const emit = operationToToolEmit(op, model.title);
      this.tools.set(emit.name, {
        name: emit.name,
        description: emit.description,
        summary: emit.summary,
        tags: emit.tags,
        inputSchema: emit.inputSchema,
        plan: emit.plan,
        sourceTitle: emit.sourceTitle,
        defaultBaseUrl,
        securitySchemes: model.securitySchemes,
        sourceNamespace,
      });
      added.push(emit.name);
    }
    const warnings =
      this.tools.size > TOOL_COUNT_WARN_THRESHOLD
        ? [
            `This proxy now exposes ${this.tools.size} tools (> ${TOOL_COUNT_WARN_THRESHOLD}). Large tool counts hurt model tool-selection; narrow with includeTags / methods / pathGlob / excludeOperations, or rely on a client that supports dynamic tool discovery (e.g. Tool Search).`,
          ]
        : [];
    const envVars = [
      `${sourceNamespace}_API_BASE_URL`,
      ...model.securitySchemes.flatMap((s) => s.envVars).map((v) => `${sourceNamespace}_${v}`),
    ];
    return {
      mounted: added.length,
      filteredOut,
      toolNames: added,
      warnings,
      sourceNamespace,
      envVars,
    };
  }

  /** Tool descriptors for an MCP `tools/list` response. */
  listTools(): Array<{ name: string; description: string; inputSchema: JsonSchema }> {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  get size(): number {
    return this.tools.size;
  }

  /** Catalog entries for every mounted tool (name → summary → tags), for `serve --catalog`. */
  catalog(): CatalogEntry[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      summary: t.summary,
      tags: t.tags,
      method: t.plan.method,
      path: t.plan.pathTemplate,
      sourceTitle: t.sourceTitle,
    }));
  }

  /** Execute a mounted tool against the live upstream. */
  async call(
    name: string,
    args: Record<string, unknown>,
    env: Record<string, string | undefined>,
    fetchImpl?: FetchLike,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    // Base URL: per-source override wins, then the global override, then the spec's own server.
    const baseUrl =
      env[`${tool.sourceNamespace}_API_BASE_URL`] ?? env.API_BASE_URL ?? tool.defaultBaseUrl;
    const ctx: RuntimeContext = {
      baseUrl,
      securitySchemes: tool.securitySchemes,
      env,
      sourceNamespace: tool.sourceNamespace,
    };
    return executePlan(tool.plan, args, ctx, fetchImpl);
  }
}

/** Build a low-level MCP Server backed by an {@link ApiProxy}. Mount specs before connecting. */
export function createProxyServer(): { server: Server; proxy: ApiProxy } {
  const proxy = new ApiProxy();
  return { server: serverFor(proxy), proxy };
}

/**
 * Wire a low-level MCP Server to an existing proxy. The stateless HTTP transport creates one
 * Server per request, all backed by the same mounted proxy, so specs are parsed only once.
 */
export function serverFor(proxy: ApiProxy, logger: Logger = log): Server {
  const server = new Server(
    { name: `${GENERATOR_NAME}-proxy`, version: GENERATOR_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: proxy.listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name;
    const start = Date.now();
    try {
      const text = await proxy.call(
        tool,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        process.env,
      );
      logger.debug("tool call ok", { tool, durationMs: Date.now() - start });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      logger.warn("tool call failed", {
        tool,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: "Error: " + (err instanceof Error ? err.message : String(err)),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}
