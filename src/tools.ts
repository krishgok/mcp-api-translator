/**
 * The four MCP tools exposed by mcp-api-translator itself.
 *
 * Kept intentionally small: analyze (preview without writing), generate (scaffold a project),
 * extend (append to an existing project), and an introspection tool. All spec inputs accept inline
 * text or a local file path, in JSON or YAML.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseSource, SUPPORTED_FORMATS, type SourceInput } from "./parsers/index.js";
import type { AuthOverride } from "./parsers/security.js";
import { curate, TOOL_COUNT_WARN_THRESHOLD } from "./curation/index.js";
import {
  appendToProject,
  generateProject,
  noAuthWarnings,
  type EmitSummary,
} from "./emitters/project.js";
import type { FilterOptions } from "./curation/filter.js";

const sourceShape = {
  spec: z.string().optional().describe("Inline spec text (OpenAPI or Postman; JSON or YAML)."),
  specPath: z.string().optional().describe("Path to a local spec file (JSON or YAML)."),
  format: z
    .enum(["openapi", "postman", "auto"])
    .optional()
    .describe("Force a format; defaults to auto-detect."),
};

/**
 * Auth to apply when the spec models none of its own. Kept to the shapes the emitters already
 * generate handlers for; anything a spec *does* declare wins over this.
 */
const authSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("apiKey"),
      in: z.enum(["header", "query", "cookie"]).optional(),
      name: z.string().optional().describe('Parameter name; defaults to "X-API-Key".'),
    }),
    z.object({ type: z.literal("http"), scheme: z.enum(["bearer", "basic"]) }),
    z.object({
      type: z.literal("oauth2"),
      tokenUrl: z.string(),
      grant: z.enum(["client_credentials", "refresh_token"]).optional(),
    }),
  ])
  .optional()
  .describe(
    "Auth to use when the spec declares no security schemes of its own. Applied only to " +
      "operations whose own security list is empty; credentials are read from env vars as usual.",
  );

const filterShape = {
  includeTags: z.array(z.string()).optional().describe("Keep only operations with these tags."),
  excludeOperations: z
    .array(z.string())
    .optional()
    .describe("Drop operations by operationId, tool name, or tag."),
  methods: z
    .array(z.string())
    .optional()
    .describe("Keep only these HTTP methods, e.g. [GET, POST]."),
  pathGlob: z.string().optional().describe('Keep only matching paths, e.g. "/v1/**".'),
};

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function filtersFrom(args: Record<string, unknown>): FilterOptions {
  return {
    includeTags: args.includeTags as string[] | undefined,
    excludeOperations: args.excludeOperations as string[] | undefined,
    methods: args.methods as string[] | undefined,
    pathGlob: args.pathGlob as string | undefined,
  };
}

function sourceFrom(args: Record<string, unknown>): SourceInput {
  return {
    spec: args.spec as string | undefined,
    specPath: args.specPath as string | undefined,
    format: args.format as SourceInput["format"],
  };
}

function summaryText(verb: string, s: EmitSummary): string {
  const lines = [
    `${verb} MCP server "${s.serverName}" at ${s.projectDir}`,
    `Tools added: ${s.toolsAdded} | skipped: ${s.toolsSkipped} | total now: ${s.totalTools}`,
    "",
    "Files written:",
    ...s.files.map((f) => `  - ${f}`),
  ];
  if (s.sourceEnv.length > 0) {
    lines.push(
      "",
      "Per-API env vars (aggregated server; namespaced vars win over bare ones):",
      ...s.sourceEnv.map((e) => `  - ${e}`),
    );
  }
  if (s.warnings.length > 0) lines.push("", "Warnings:", ...s.warnings.map((w) => `  ! ${w}`));
  lines.push(
    "",
    "Next steps:",
    `  cd ${s.projectDir}`,
    "  npm install && npm run build",
    "  cp .env.example .env   # fill in API_BASE_URL and any credentials",
    "  npm start",
    "  # See client-config.md to add it to Claude / Cursor / Codex.",
  );
  return lines.join("\n");
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "analyze_spec",
    {
      title: "Analyze API spec (preview)",
      description:
        "Parse an OpenAPI or Postman spec and preview the MCP tools that would be generated, " +
        "without writing any files. Use this to curate (filter/inspect) before generating.",
      inputSchema: { ...sourceShape, ...filterShape },
    },
    async (args): Promise<CallToolResult> => {
      const model = await parseSource(sourceFrom(args));
      const { operations, filteredOut } = curate(model, filtersFrom(args));
      const report = {
        title: model.title,
        version: model.version,
        sourceFormat: model.sourceFormat,
        servers: model.servers,
        authSchemes: model.securitySchemes.map((s) => ({
          name: s.name,
          type: s.type,
          envVars: s.envVars,
        })),
        operationsTotal: model.operations.length,
        operationsKept: operations.length,
        operationsFilteredOut: filteredOut,
        proposedTools: operations.map((op) => ({
          name: op.toolName,
          method: op.method,
          path: op.path,
          summary: op.summary ?? "",
        })),
      };
      const warnings = [
        ...(operations.length > TOOL_COUNT_WARN_THRESHOLD
          ? [
              `${operations.length} tools exceed the ${TOOL_COUNT_WARN_THRESHOLD}-tool guideline; consider includeTags / methods / pathGlob.`,
            ]
          : []),
        ...noAuthWarnings(model.securitySchemes),
      ];
      const warn = warnings.map((w) => `\n\n! ${w}`).join("");
      return text(JSON.stringify(report, null, 2) + warn);
    },
  );

  server.registerTool(
    "generate_mcp_server",
    {
      title: "Generate MCP server",
      description:
        "Generate a complete, runnable TypeScript MCP server project from an OpenAPI or Postman " +
        "spec. Writes the project to outputDir. Use force to overwrite a non-empty directory.",
      inputSchema: {
        ...sourceShape,
        outputDir: z.string().describe("Directory to write the generated project into."),
        serverName: z
          .string()
          .optional()
          .describe("npm/package name; defaults from the API title."),
        serverVersion: z.string().optional(),
        language: z
          .enum(["typescript", "python"])
          .optional()
          .describe("Output language. Defaults to typescript."),
        pythonVariant: z
          .enum(["lowlevel", "fastmcp"])
          .optional()
          .describe(
            "Python server flavor (requires language: python): the low-level MCP SDK (default) " +
              "or FastMCP. Both serve the same raw JSON-Schema tool inputs.",
          ),
        transport: z
          .enum(["stdio", "http", "both"])
          .optional()
          .describe("Transport(s) to generate (TypeScript only). Defaults to stdio."),
        toolCatalog: z
          .boolean()
          .optional()
          .describe(
            "Also write tool-catalog.json (name/summary/tags per tool) for discovery layers.",
          ),
        force: z.boolean().optional().describe("Overwrite a non-empty / existing project."),
        auth: authSchema,
        ...filterShape,
      },
    },
    async (args): Promise<CallToolResult> => {
      const model = await parseSource(sourceFrom(args));
      const summary = await generateProject(model, {
        outputDir: args.outputDir as string,
        serverName: args.serverName as string | undefined,
        serverVersion: args.serverVersion as string | undefined,
        language: args.language as "typescript" | "python" | undefined,
        pythonVariant: args.pythonVariant as "lowlevel" | "fastmcp" | undefined,
        transport: args.transport as "stdio" | "http" | "both" | undefined,
        toolCatalog: args.toolCatalog as boolean | undefined,
        force: args.force as boolean | undefined,
        auth: args.auth as AuthOverride | undefined,
        filters: filtersFrom(args),
      });
      return text(summaryText("Generated", summary));
    },
  );

  server.registerTool(
    "extend_mcp_server",
    {
      title: "Extend an existing generated MCP server",
      description:
        "Append the operations from another spec to an already-generated project (identified by " +
        "its .mcp-translator.json manifest). Idempotent: operations already present are skipped, " +
        "and hand-edited tool files are preserved unless force is set. Enables aggregating multiple " +
        "APIs into one MCP server.",
      inputSchema: {
        projectDir: z.string().describe("Path to an existing generated project."),
        ...sourceShape,
        toolCatalog: z
          .boolean()
          .optional()
          .describe(
            "Also write tool-catalog.json; defaults to refreshing it if the project has one.",
          ),
        force: z.boolean().optional().describe("Overwrite existing tool files of the same name."),
        auth: authSchema,
        ...filterShape,
      },
    },
    async (args): Promise<CallToolResult> => {
      const model = await parseSource(sourceFrom(args));
      const summary = await appendToProject(model, {
        projectDir: args.projectDir as string,
        toolCatalog: args.toolCatalog as boolean | undefined,
        force: args.force as boolean | undefined,
        auth: args.auth as AuthOverride | undefined,
        filters: filtersFrom(args),
      });
      return text(summaryText("Extended", summary));
    },
  );

  server.registerTool(
    "list_supported_features",
    {
      title: "List supported features",
      description:
        "Report the input formats, auth schemes, transports, and limits this tool supports.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const features = {
        inputFormats: SUPPORTED_FORMATS,
        outputLanguages: [
          "typescript",
          "python (lowlevel MCP SDK by default, or pythonVariant: fastmcp)",
        ],
        modes: {
          generate: "Scaffold an ownable TypeScript MCP-server project (generate_mcp_server).",
          serve:
            "Run a live runtime proxy, no codegen: `mcp-api-translator serve --spec <path>` mounts the spec's operations as MCP tools in-process (repeat --spec to aggregate multiple APIs; --auth supplies a scheme when the spec declares none).",
        },
        transports: ["stdio", "http", "both"],
        authSchemes: [
          "apiKey (header/query/cookie)",
          "http bearer",
          "http basic",
          "oauth2 (client-credentials grant, refresh-token grant, or pre-obtained token)",
        ],
        curation: ["includeTags", "excludeOperations", "methods", "pathGlob"],
        authOverride:
          "generate/extend accept an `auth` argument for specs that declare no security of " +
          "their own ({type:apiKey,in,name} | {type:http,scheme} | {type:oauth2,tokenUrl,grant}); " +
          "it applies only to operations whose own security list is empty. `serve` takes the same " +
          "override as --auth bearer|basic|apikey[:<in>:<name>]|oauth2:<tokenUrl>.",
        toolCatalog:
          "Optional machine-readable tool-catalog.json (toolCatalog flag on generate/extend, or `serve --catalog <path>`) so discovery layers can rank tools.",
        append: true,
        toolCountWarnThreshold: TOOL_COUNT_WARN_THRESHOLD,
        limitations: [
          "OAuth2 client-credentials and refresh-token grants are supported (tokens fetched + cached); no interactive authorization-code consent flows.",
          "Generated handlers return JSON/text; no upstream streaming or auto-pagination.",
          "Postman parameter types are inferred from examples.",
          "Output quality tracks spec quality (operationIds, descriptions).",
        ],
      };
      return text(JSON.stringify(features, null, 2));
    },
  );
}
