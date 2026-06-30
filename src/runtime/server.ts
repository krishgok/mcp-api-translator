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
import { executePlan, type FetchLike, type RuntimeContext } from "./client.js";
import type { RequestPlanData } from "../emitters/templates.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "../version.js";

interface MountedTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  plan: RequestPlanData;
  /** This API's first declared server, used unless API_BASE_URL overrides it. */
  defaultBaseUrl: string;
  securitySchemes: SecurityScheme[];
}

export interface MountResult {
  mounted: number;
  /** Operations dropped by filters. */
  filteredOut: number;
  toolNames: string[];
  warnings: string[];
}

/** Holds the live tool set across one or more mounted APIs. */
export class ApiProxy {
  private readonly tools = new Map<string, MountedTool>();

  /** Curate a model's operations and register them as live tools (deduping names across mounts). */
  mount(model: ApiModel, filters: FilterOptions = {}): MountResult {
    const reserved = new Set(this.tools.keys());
    const { operations, filteredOut } = curate(model, filters, reserved);
    const defaultBaseUrl = model.servers[0] ?? "";
    const added: string[] = [];
    for (const op of operations) {
      const emit = operationToToolEmit(op, model.title);
      this.tools.set(emit.name, {
        name: emit.name,
        description: emit.description,
        inputSchema: emit.inputSchema,
        plan: emit.plan,
        defaultBaseUrl,
        securitySchemes: model.securitySchemes,
      });
      added.push(emit.name);
    }
    const warnings =
      this.tools.size > TOOL_COUNT_WARN_THRESHOLD
        ? [
            `This proxy now exposes ${this.tools.size} tools (> ${TOOL_COUNT_WARN_THRESHOLD}). Large tool counts hurt model tool-selection; narrow with includeTags / methods / pathGlob / excludeOperations, or rely on a client that supports dynamic tool discovery (e.g. Tool Search).`,
          ]
        : [];
    return { mounted: added.length, filteredOut, toolNames: added, warnings };
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

  /** Execute a mounted tool against the live upstream. */
  async call(
    name: string,
    args: Record<string, unknown>,
    env: Record<string, string | undefined>,
    fetchImpl?: FetchLike,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const baseUrl = env.API_BASE_URL ?? tool.defaultBaseUrl;
    const ctx: RuntimeContext = { baseUrl, securitySchemes: tool.securitySchemes, env };
    return executePlan(tool.plan, args, ctx, fetchImpl);
  }
}

/** Build a low-level MCP Server backed by an {@link ApiProxy}. Mount specs before connecting. */
export function createProxyServer(): { server: Server; proxy: ApiProxy } {
  const proxy = new ApiProxy();
  const server = new Server(
    { name: `${GENERATOR_NAME}-proxy`, version: GENERATOR_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: proxy.listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const text = await proxy.call(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
        process.env,
      );
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
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

  return { server, proxy };
}
