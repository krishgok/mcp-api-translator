/**
 * Project emitter: writes a complete generated MCP-server project, and appends to an existing one.
 *
 * `generateProject` scaffolds fresh; `appendToProject` reads the `.mcp-translator.json` manifest,
 * adds only operations not already present (idempotent), regenerates shared infrastructure from
 * the merged model, and never rewrites hand-edited tool files unless `force` is set.
 */
import { mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import type { ApiModel, JsonSchema, Operation, SecurityScheme } from "../ir/model.js";
import { buildDescription } from "../curation/describe.js";
import { curate, TOOL_COUNT_WARN_THRESHOLD } from "../curation/index.js";
import { applyFilters, type FilterOptions } from "../curation/filter.js";
import { uniqueToolName } from "../curation/naming.js";
import {
  operationKey,
  readManifest,
  writeManifest,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  type Language,
  type ManifestTool,
  type TranslatorManifest,
} from "../manifest.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "../version.js";
import * as t from "./templates.js";
import * as py from "./python.js";

export interface GenerateOptions {
  outputDir: string;
  serverName?: string;
  serverVersion?: string;
  transport?: t.Transport;
  filters?: FilterOptions;
  force?: boolean;
  /** Output language; defaults to "typescript". */
  language?: Language;
}

export interface AppendOptions {
  projectDir: string;
  filters?: FilterOptions;
  force?: boolean;
}

export interface EmitSummary {
  projectDir: string;
  serverName: string;
  toolsAdded: number;
  toolsSkipped: number;
  totalTools: number;
  files: string[];
  warnings: string[];
}

/** Records every file written so the summary can report a manifest of changes. */
class FileWriter {
  readonly written: string[] = [];
  constructor(private readonly root: string) {}
  async write(relPath: string, content: string): Promise<void> {
    const full = path.join(this.root, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    this.written.push(relPath);
  }
  async writeIfAbsent(relPath: string, content: string, force: boolean): Promise<boolean> {
    if (!force && (await exists(path.join(this.root, relPath)))) return false;
    await this.write(relPath, content);
    return true;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true; // doesn't exist yet
    throw err; // surface EACCES/ENOTDIR rather than silently treating as empty
  }
}

/** Hard ceiling on generated tools; a pathological spec shouldn't scaffold thousands of files. */
export const MAX_GENERATED_TOOLS = 1000;

function assertToolCount(count: number): void {
  if (count > MAX_GENERATED_TOOLS) {
    throw new Error(
      `Refusing to generate ${count} tools (limit ${MAX_GENERATED_TOOLS}). ` +
        `Narrow the spec with includeTags / methods / pathGlob / excludeOperations.`,
    );
  }
}

export function toPackageName(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (base || "api") + "-mcp";
}

/** Build the emit-ready tool descriptor (input schema + request plan) for one operation. */
export function operationToToolEmit(op: Operation, sourceTitle: string): t.ToolEmit {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const p of op.parameters) {
    const schema: JsonSchema = { ...p.schema };
    if (p.description && !("description" in schema)) schema.description = p.description;
    properties[p.name] = schema;
    if (p.required) required.push(p.name);
  }

  // Substitution is driven by the actual {tokens} in the path, not the declared params: a token
  // with no matching parameter still needs an input so it can be filled in rather than sent
  // literally.
  const pathTokens = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  for (const token of pathTokens) {
    if (!(token in properties)) {
      properties[token] = { type: "string" };
      if (!required.includes(token)) required.push(token);
    }
  }

  let bodyParam: string | null = null;
  if (op.requestBody) {
    bodyParam = "body" in properties ? "requestBody" : "body";
    const bodySchema: JsonSchema = { ...op.requestBody.schema };
    if (op.requestBody.description && !("description" in bodySchema)) {
      bodySchema.description = op.requestBody.description;
    }
    properties[bodyParam] = bodySchema;
    if (op.requestBody.required) required.push(bodyParam);
  }

  const inputSchema: JsonSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };

  return {
    name: op.toolName,
    method: op.method,
    path: op.path,
    description: buildDescription(op),
    inputSchema,
    sourceTitle,
    plan: {
      method: op.method,
      pathTemplate: op.path,
      pathParams: pathTokens,
      queryParams: op.parameters.filter((p) => p.in === "query").map((p) => p.name),
      headerParams: op.parameters.filter((p) => p.in === "header").map((p) => p.name),
      bodyParam,
      contentType: op.requestBody?.contentType ?? null,
      security: op.security,
    },
  };
}

/** Write the shared infrastructure files common to fresh + append. */
async function emitShared(
  fw: FileWriter,
  serverName: string,
  serverVersion: string,
  description: string,
  servers: string[],
  schemes: SecurityScheme[],
  transport: t.Transport,
  allToolNames: string[],
  toolCount: number,
): Promise<void> {
  const baseUrl = servers[0] ?? "";
  await fw.write("package.json", t.packageJson(serverName, serverVersion, transport));
  await fw.write("tsconfig.json", t.tsconfigJson());
  await fw.write(".gitignore", t.gitignore());
  await fw.write(".env.example", t.envExample(baseUrl, schemes));
  await fw.write("Dockerfile", t.dockerfile());
  await fw.write("server.json", t.serverJson(serverName, serverVersion, description));
  await fw.write("client-config.md", t.clientConfigMd(serverName));
  await fw.write(
    "README.md",
    t.readmeMd({ serverName, apiTitle: description, toolCount, schemes, transport }),
  );
  await fw.write("src/types.ts", t.typesTs());
  await fw.write("src/config.ts", t.configTs(baseUrl));
  await fw.write("src/auth.ts", t.authTs(schemes));
  await fw.write("src/http/client.ts", t.httpClientTs());
  await fw.write("src/server.ts", t.serverTs(serverName, serverVersion));
  await fw.write("src/index.ts", t.indexStdioTs(serverName));
  if (transport === "http" || transport === "both") {
    await fw.write("src/index.http.ts", t.indexHttpTs(serverName));
  }
  await fw.write("src/tools/index.ts", t.toolsIndexTs(allToolNames));
}

/** A serialized tool record stored in a Python project's tools.json. */
type PyToolRecord = { name: string; description: string; inputSchema: unknown; plan: unknown };

function toPyToolRecord(tool: t.ToolEmit): PyToolRecord {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    plan: tool.plan,
  };
}

/** Path to a Python project's tool-data file, relative to the project root. */
function pythonToolsJsonPath(serverName: string): string {
  return `${py.toPackageModule(serverName)}/tools.json`;
}

/**
 * Write the shared Python infrastructure (everything except tools.json) from the merged model.
 * Parallel to {@link emitShared} for TypeScript; reused by fresh generation and append.
 */
async function emitPythonShared(
  fw: FileWriter,
  serverName: string,
  serverVersion: string,
  description: string,
  servers: string[],
  schemes: SecurityScheme[],
  toolCount: number,
): Promise<void> {
  const baseUrl = servers[0] ?? "";
  const pkg = py.toPackageModule(serverName);
  await fw.write("pyproject.toml", py.pyprojectToml(serverName, serverVersion, pkg));
  await fw.write(".gitignore", py.gitignorePy());
  await fw.write(".env.example", t.envExample(baseUrl, schemes));
  await fw.write("Dockerfile", py.dockerfilePy(pkg));
  await fw.write("server.json", t.serverJson(serverName, serverVersion, description));
  await fw.write(
    "README.md",
    py.readmePy({ serverName, pkg, apiTitle: description, toolCount, schemes }),
  );
  await fw.write(`${pkg}/__init__.py`, py.initPy());
  await fw.write(`${pkg}/config.py`, py.configPy(baseUrl));
  await fw.write(`${pkg}/auth.py`, py.authPy(schemes));
  await fw.write(`${pkg}/http_client.py`, py.httpClientPy());
  await fw.write(`${pkg}/server.py`, py.serverPy(serverName));
  await fw.write(`${pkg}/__main__.py`, py.mainPy());
  await fw.write(`${pkg}/tools.py`, py.toolsPy());
}

export async function generateProject(
  model: ApiModel,
  options: GenerateOptions,
): Promise<EmitSummary> {
  const dir = path.resolve(options.outputDir);
  const existingManifest = await readManifest(dir);
  if (existingManifest && !options.force) {
    throw new Error(
      `${dir} is already a generated project. Use extend_mcp_server to add tools, or pass force: true to overwrite.`,
    );
  }
  if (!existingManifest && !options.force && !(await isEmptyDir(dir))) {
    throw new Error(`${dir} is not empty. Pass force: true to overwrite.`);
  }

  const serverName = options.serverName ?? toPackageName(model.title);
  const serverVersion = options.serverVersion ?? model.version ?? "0.1.0";
  const transport = options.transport ?? "stdio";
  const language: Language = options.language ?? "typescript";
  const description = model.title + (model.version ? ` (v${model.version})` : "");

  const { operations, filteredOut } = curate(model, options.filters ?? {});
  assertToolCount(operations.length);
  const tools = operations.map((op) => operationToToolEmit(op, model.title));

  const fw = new FileWriter(dir);
  if (language === "python") {
    await emitPythonShared(
      fw,
      serverName,
      serverVersion,
      description,
      model.servers,
      model.securitySchemes,
      tools.length,
    );
    await fw.write(
      pythonToolsJsonPath(serverName),
      JSON.stringify(tools.map(toPyToolRecord), null, 2) + "\n",
    );
  } else {
    await emitShared(
      fw,
      serverName,
      serverVersion,
      description,
      model.servers,
      model.securitySchemes,
      transport,
      tools.map((tool) => tool.name),
      tools.length,
    );
    for (const tool of tools) {
      await fw.write(`src/tools/${tool.name}.ts`, t.toolFileTs(tool));
    }
  }

  const manifest: TranslatorManifest = {
    manifestVersion: MANIFEST_VERSION,
    generator: GENERATOR_NAME,
    generatorVersion: GENERATOR_VERSION,
    serverName,
    serverVersion,
    description,
    language,
    transport,
    servers: model.servers,
    securitySchemes: model.securitySchemes,
    sources: [
      {
        format: model.sourceFormat,
        title: model.title,
        version: model.version,
        addedAt: new Date().toISOString(),
      },
    ],
    tools: tools.map(
      (tool): ManifestTool => ({
        name: tool.name,
        method: tool.method,
        path: tool.path,
        sourceTitle: tool.sourceTitle,
      }),
    ),
  };
  await fw.write(MANIFEST_FILENAME, JSON.stringify(manifest, null, 2) + "\n");

  return {
    projectDir: dir,
    serverName,
    toolsAdded: tools.length,
    toolsSkipped: filteredOut,
    totalTools: tools.length,
    files: fw.written,
    warnings: toolCountWarnings(tools.length),
  };
}

export async function appendToProject(
  model: ApiModel,
  options: AppendOptions,
): Promise<EmitSummary> {
  const dir = path.resolve(options.projectDir);
  const manifest = await readManifest(dir);
  if (!manifest) {
    throw new Error(
      `${dir} has no ${MANIFEST_FILENAME}; it is not a generated project. Use generate_mcp_server instead.`,
    );
  }
  // Refuse a manifest from a newer format than we understand (a missing field == legacy v1).
  if ((manifest.manifestVersion ?? 1) > MANIFEST_VERSION) {
    throw new Error(
      `${MANIFEST_FILENAME} is schema version ${manifest.manifestVersion}, newer than this generator supports (${MANIFEST_VERSION}). Upgrade mcp-api-translator.`,
    );
  }
  const language: Language = manifest.language ?? "typescript";

  // Merge servers and security schemes.
  const servers = [...new Set([...manifest.servers, ...model.servers])];
  const schemeMap = new Map<string, SecurityScheme>();
  for (const s of manifest.securitySchemes) schemeMap.set(s.name, s);
  for (const s of model.securitySchemes) if (!schemeMap.has(s.name)) schemeMap.set(s.name, s);
  const schemes = [...schemeMap.values()];

  // Add only operations not already present (idempotency by method+path).
  const existingKeys = new Set(manifest.tools.map((tool) => operationKey(tool.method, tool.path)));
  const reserved = new Set(manifest.tools.map((tool) => tool.name));
  const filtered = applyFilters(model.operations, options.filters ?? {});
  const newOps = filtered.filter((op) => !existingKeys.has(operationKey(op.method, op.path)));
  newOps.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  for (const op of newOps) op.toolName = uniqueToolName(op.toolName, reserved);

  const newTools = newOps.map((op) => operationToToolEmit(op, model.title));
  const allToolNames = [
    ...manifest.tools.map((tool) => tool.name),
    ...newTools.map((tl) => tl.name),
  ];
  assertToolCount(allToolNames.length);

  const fw = new FileWriter(dir);
  const description = manifest.description ?? manifest.serverName;
  let skippedFiles = 0;
  if (language === "python") {
    // Python keeps all tool data in one tools.json; merge new records into the existing ones
    // (preserving any hand-edits to existing entries) and regenerate the shared infrastructure.
    const toolsJson = pythonToolsJsonPath(manifest.serverName);
    let existingRecords: PyToolRecord[];
    try {
      existingRecords = JSON.parse(
        await readFile(path.join(dir, toolsJson), "utf8"),
      ) as PyToolRecord[];
    } catch {
      throw new Error(
        `${path.join(dir, toolsJson)} is missing or unreadable; cannot extend this Python project.`,
      );
    }
    const allRecords = [...existingRecords, ...newTools.map(toPyToolRecord)];
    await emitPythonShared(
      fw,
      manifest.serverName,
      manifest.serverVersion,
      description,
      servers,
      schemes,
      allRecords.length,
    );
    await fw.write(toolsJson, JSON.stringify(allRecords, null, 2) + "\n");
  } else {
    await emitShared(
      fw,
      manifest.serverName,
      manifest.serverVersion,
      description,
      servers,
      schemes,
      manifest.transport,
      allToolNames,
      allToolNames.length,
    );
    for (const tool of newTools) {
      const wrote = await fw.writeIfAbsent(
        `src/tools/${tool.name}.ts`,
        t.toolFileTs(tool),
        options.force ?? false,
      );
      if (!wrote) skippedFiles++;
    }
  }

  const merged: TranslatorManifest = {
    ...manifest,
    manifestVersion: MANIFEST_VERSION,
    generatorVersion: GENERATOR_VERSION,
    servers,
    securitySchemes: schemes,
    sources: [
      ...manifest.sources,
      {
        format: model.sourceFormat,
        title: model.title,
        version: model.version,
        addedAt: new Date().toISOString(),
      },
    ],
    tools: [
      ...manifest.tools,
      ...newTools.map(
        (tool): ManifestTool => ({
          name: tool.name,
          method: tool.method,
          path: tool.path,
          sourceTitle: tool.sourceTitle,
        }),
      ),
    ],
  };
  await fw.write(MANIFEST_FILENAME, JSON.stringify(merged, null, 2) + "\n");

  return {
    projectDir: dir,
    serverName: manifest.serverName,
    toolsAdded: newTools.length,
    toolsSkipped: filtered.length - newOps.length + skippedFiles,
    totalTools: allToolNames.length,
    files: fw.written,
    warnings: toolCountWarnings(allToolNames.length),
  };
}

function toolCountWarnings(count: number): string[] {
  if (count > TOOL_COUNT_WARN_THRESHOLD) {
    return [
      `This server exposes ${count} tools (> ${TOOL_COUNT_WARN_THRESHOLD}). Large tool counts hurt model tool-selection. Consider narrowing with includeTags / methods / pathGlob / excludeOperations.`,
    ];
  }
  return [];
}
