/**
 * OpenAPI 3.0 / 3.1 (and best-effort Swagger 2.0) -> {@link ApiModel}.
 *
 * We dereference all `$ref`s up front so emitters only ever see resolved schemas. OpenAPI 3.1
 * schemas are already JSON Schema 2020-12; the only normalization needed for 3.0 is converting
 * `nullable: true` to a `"null"` type union.
 */
import { dereference } from "@readme/openapi-parser";
import type {
  ApiModel,
  JsonSchema,
  Operation,
  Parameter,
  ParameterLocation,
  RequestBody,
  SecuritySchemeType,
} from "../ir/model.js";
import { nameFromMethodPath, sanitizeToolName } from "../curation/naming.js";
import { assignEnvVars } from "./security.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/** Recursively convert OpenAPI 3.0 `nullable` into a JSON Schema 2020-12 type union. */
function normalizeSchema(schema: any, isV30: boolean): JsonSchema {
  if (!schema || typeof schema !== "object") return schema ?? {};
  const out: AnyObj = Array.isArray(schema) ? [...schema] : { ...schema };

  if (isV30 && out.nullable === true) {
    if (typeof out.type === "string") out.type = [out.type, "null"];
    else if (Array.isArray(out.type) && !out.type.includes("null"))
      out.type = [...out.type, "null"];
    delete out.nullable;
  } else if (isV30 && out.nullable === false) {
    delete out.nullable;
  }

  if (out.properties && typeof out.properties === "object") {
    const props: AnyObj = {};
    for (const [k, v] of Object.entries(out.properties)) props[k] = normalizeSchema(v, isV30);
    out.properties = props;
  }
  if (out.items) out.items = normalizeSchema(out.items, isV30);
  if (out.additionalProperties && typeof out.additionalProperties === "object") {
    out.additionalProperties = normalizeSchema(out.additionalProperties, isV30);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(out[key])) out[key] = out[key].map((s: any) => normalizeSchema(s, isV30));
  }
  return out;
}

function serversFrom(doc: AnyObj): string[] {
  if (Array.isArray(doc.servers) && doc.servers.length > 0) {
    return doc.servers.map((s: AnyObj) => String(s.url)).filter(Boolean);
  }
  // Swagger 2.0 fallback.
  if (doc.host) {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length > 0 ? doc.schemes[0] : "https";
    return [`${scheme}://${doc.host}${doc.basePath ?? ""}`];
  }
  return [];
}

function paramFrom(p: AnyObj, isV30: boolean): Parameter {
  // 3.x params carry `schema`; 2.0 non-body params inline the type keywords.
  const schema: JsonSchema = p.schema
    ? normalizeSchema(p.schema, isV30)
    : normalizeSchema(
        {
          type: p.type,
          format: p.format,
          enum: p.enum,
          items: p.items,
          default: p.default,
        },
        isV30,
      );
  return {
    name: String(p.name),
    in: (p.in as ParameterLocation) ?? "query",
    required: Boolean(p.required) || p.in === "path",
    description: p.description,
    schema,
  };
}

function requestBodyFrom(op: AnyObj, params: AnyObj[], isV30: boolean): RequestBody | undefined {
  // OpenAPI 3.x request body.
  if (op.requestBody?.content) {
    const content = op.requestBody.content as AnyObj;
    const contentType =
      Object.keys(content).find((c) => c.includes("json")) ?? Object.keys(content)[0];
    if (contentType) {
      return {
        required: Boolean(op.requestBody.required),
        contentType,
        description: op.requestBody.description,
        schema: normalizeSchema(content[contentType]?.schema ?? {}, isV30),
      };
    }
  }
  // Swagger 2.0 body parameter.
  const body = params.find((p) => p.in === "body");
  if (body?.schema) {
    return {
      required: Boolean(body.required),
      contentType: "application/json",
      description: body.description,
      schema: normalizeSchema(body.schema, isV30),
    };
  }
  return undefined;
}

function securitySchemesFrom(doc: AnyObj) {
  const defs: AnyObj = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  const raw = Object.entries(defs).map(([name, def]) => {
    const d = def as AnyObj;
    // Swagger 2.0 used type "basic"; normalize to http/basic.
    let type = d.type as SecuritySchemeType;
    let scheme = d.scheme as string | undefined;
    if ((d.type as string) === "basic") {
      type = "http";
      scheme = "basic";
    }
    // OAuth2 client-credentials token endpoint (OpenAPI 3.x flows, or Swagger 2.0 tokenUrl).
    const tokenUrl =
      typeof d.flows?.clientCredentials?.tokenUrl === "string"
        ? (d.flows.clientCredentials.tokenUrl as string)
        : d.flow === "application" && typeof d.tokenUrl === "string"
          ? (d.tokenUrl as string)
          : undefined;
    return {
      name,
      type,
      in: d.in,
      paramName: d.name,
      scheme,
      tokenUrl,
    };
  });
  return assignEnvVars(raw);
}

export async function parseOpenApi(raw: unknown): Promise<ApiModel> {
  // Resolve internal `$ref`s only. `external: false` disables the http/file resolvers, so a hostile
  // spec cannot make us fetch a URL or read a local file during parsing (SSRF / info disclosure).
  const doc = (await dereference(
    raw as never,
    { resolve: { external: false } } as never,
  )) as AnyObj;
  const isV30 = typeof doc.openapi === "string" ? doc.openapi.startsWith("3.0") : !!doc.swagger;

  const securitySchemes = securitySchemesFrom(doc);
  const rootSecurity = securityNames(doc.security);

  const operations: Operation[] = [];
  const paths: AnyObj = doc.paths ?? {};
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = pathItemRaw as AnyObj;
    const pathLevelParams: AnyObj[] = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as AnyObj | undefined;
      if (!op) continue;

      const rawParams: AnyObj[] = [
        ...pathLevelParams,
        ...(Array.isArray(op.parameters) ? op.parameters : []),
      ];
      const parameters = rawParams
        .filter((p) => p.in && p.in !== "body" && p.in !== "formData")
        .map((p) => paramFrom(p, isV30));

      const baseName = op.operationId
        ? sanitizeToolName(op.operationId)
        : nameFromMethodPath(method, path);

      operations.push({
        toolName: baseName,
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: typeof op.summary === "string" ? op.summary : undefined,
        description: typeof op.description === "string" ? op.description : undefined,
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        parameters,
        requestBody: requestBodyFrom(op, rawParams, isV30),
        security: op.security ? securityNames(op.security) : rootSecurity,
      });
    }
  }

  return {
    title: doc.info?.title ?? "API",
    version: doc.info?.version ?? "0.0.0",
    description: doc.info?.description,
    servers: serversFrom(doc),
    securitySchemes,
    operations,
    sourceFormat: "openapi",
  };
}

function securityNames(security: unknown): string[] {
  if (!Array.isArray(security)) return [];
  const names = new Set<string>();
  for (const requirement of security) {
    if (requirement && typeof requirement === "object") {
      for (const key of Object.keys(requirement)) names.add(key);
    }
  }
  return [...names];
}
