/**
 * Postman Collection v2.1 -> {@link ApiModel}.
 *
 * Postman collections carry no formal parameter schemas, so this parser is best-effort: it
 * infers JSON Schema from example bodies and treats query/header values as optional strings.
 * Folders become tags; `:var` path segments become path parameters. Base URLs that use Postman
 * `{{variables}}` can't be resolved, so the generated server falls back to API_BASE_URL.
 */
import type {
  ApiModel,
  JsonSchema,
  Operation,
  Parameter,
  SecuritySchemeType,
} from "../ir/model.js";
import { nameFromMethodPath, sanitizeToolName } from "../curation/naming.js";
import { assignEnvVars } from "./security.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyObj = Record<string, any>;

const SKIP_HEADERS = new Set(["content-type", "accept", "authorization"]);

/** Infer a JSON Schema from a concrete example value. */
function inferSchema(value: unknown): JsonSchema {
  if (value === null) return {};
  if (Array.isArray(value)) return { type: "array", items: inferSchema(value[0] ?? {}) };
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const properties: AnyObj = {};
      for (const [k, v] of Object.entries(value as AnyObj)) properties[k] = inferSchema(v);
      return { type: "object", properties };
    }
    default:
      return {};
  }
}

function rawUrl(url: any): { path: string; pathVars: AnyObj[]; query: AnyObj[] } {
  if (typeof url === "string") {
    return { path: normalizePath(url), pathVars: [], query: [] };
  }
  const segments: string[] = Array.isArray(url?.path) ? url.path.map(String) : [];
  const path = normalizePath("/" + segments.join("/"));
  return {
    path,
    pathVars: Array.isArray(url?.variable) ? url.variable : [],
    query: Array.isArray(url?.query) ? url.query : [],
  };
}

/** Convert Postman `:var` segments to `{var}` and ensure a leading slash. */
function normalizePath(p: string): string {
  let path = p.replace(/^https?:\/\/[^/]+/i, ""); // drop scheme+host if a raw URL slipped through
  path = path.replace(/\?.*$/, ""); // drop query string
  path = path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
  if (!path.startsWith("/")) path = "/" + path;
  return path || "/";
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function mapAuth(auth: AnyObj | undefined): {
  name: string;
  type: SecuritySchemeType;
  in?: "header" | "query";
  paramName?: string;
  scheme?: string;
} | null {
  if (!auth?.type) return null;
  switch (auth.type) {
    case "bearer":
      return { name: "bearerAuth", type: "http", scheme: "bearer" };
    case "basic":
      return { name: "basicAuth", type: "http", scheme: "basic" };
    case "apikey": {
      const entries: AnyObj[] = Array.isArray(auth.apikey) ? auth.apikey : [];
      const keyEntry = entries.find((e) => e.key === "key");
      const inEntry = entries.find((e) => e.key === "in");
      return {
        name: "apiKeyAuth",
        type: "apiKey",
        in: (inEntry?.value as "header" | "query") ?? "header",
        paramName: (keyEntry?.value as string) ?? "X-API-Key",
      };
    }
    case "oauth2":
      return { name: "oauth2", type: "oauth2" };
    default:
      return null;
  }
}

export function parsePostman(raw: unknown): ApiModel {
  const doc = raw as AnyObj;
  const operations: Operation[] = [];
  const rawSchemes = new Map<string, ReturnType<typeof mapAuth>>();

  const collectionAuth = mapAuth(doc.auth);
  if (collectionAuth) rawSchemes.set(collectionAuth.name, collectionAuth);

  const walk = (items: AnyObj[], tags: string[]): void => {
    for (const item of items ?? []) {
      if (Array.isArray(item.item)) {
        walk(item.item, [...tags, String(item.name)]);
        continue;
      }
      const req = item.request as AnyObj | undefined;
      if (!req) continue;

      const method = String(req.method ?? "GET").toUpperCase();
      const { path, pathVars, query } = rawUrl(req.url);

      const effectiveAuth = mapAuth(req.auth) ?? collectionAuth;
      if (req.auth) {
        const s = mapAuth(req.auth);
        if (s) rawSchemes.set(s.name, s);
      }

      const parameters: Parameter[] = [];
      for (const name of pathParamNames(path)) {
        const v = pathVars.find((pv) => pv.key === name);
        parameters.push({
          name,
          in: "path",
          required: true,
          description: v?.description,
          schema: { type: "string" },
        });
      }
      for (const q of query) {
        if (q.disabled) continue;
        parameters.push({
          name: String(q.key),
          in: "query",
          required: false,
          description: q.description,
          schema: { type: "string" },
        });
      }
      for (const h of Array.isArray(req.header) ? req.header : []) {
        if (h.disabled || SKIP_HEADERS.has(String(h.key).toLowerCase())) continue;
        parameters.push({
          name: String(h.key),
          in: "header",
          required: false,
          description: h.description,
          schema: { type: "string" },
        });
      }

      const requestBody = bodyFrom(req.body);
      const name = item.name
        ? sanitizeToolName(String(item.name))
        : nameFromMethodPath(method, path);

      operations.push({
        toolName: name,
        operationId: item.name ? String(item.name) : undefined,
        method,
        path,
        summary: typeof item.name === "string" ? item.name : undefined,
        description: typeof req.description === "string" ? req.description : item.description,
        tags,
        parameters,
        requestBody,
        security: effectiveAuth ? [effectiveAuth.name] : [],
      });
    }
  };

  walk(Array.isArray(doc.item) ? doc.item : [], []);

  const securitySchemes = assignEnvVars(
    [...rawSchemes.values()].filter((s): s is NonNullable<typeof s> => s !== null),
  );

  return {
    title: doc.info?.name ?? "API",
    version: "1.0.0",
    description: typeof doc.info?.description === "string" ? doc.info.description : undefined,
    servers: [], // Postman base URLs typically use {{variables}}; resolved via API_BASE_URL.
    securitySchemes,
    operations,
    sourceFormat: "postman",
  };
}

function bodyFrom(body: AnyObj | undefined): RequestBodyOrUndefined {
  if (!body || !body.mode) return undefined;
  if (body.mode === "raw" && typeof body.raw === "string" && body.raw.trim()) {
    try {
      return {
        required: false,
        contentType: "application/json",
        schema: inferSchema(JSON.parse(body.raw)),
      };
    } catch {
      // Body contains template variables or non-JSON text; accept it as a raw string.
      return { required: false, contentType: "text/plain", schema: { type: "string" } };
    }
  }
  if (body.mode === "urlencoded" || body.mode === "formdata") {
    const entries: AnyObj[] = Array.isArray(body[body.mode]) ? body[body.mode] : [];
    const properties: AnyObj = {};
    for (const e of entries) if (e.key) properties[String(e.key)] = { type: "string" };
    return {
      required: false,
      contentType:
        body.mode === "urlencoded" ? "application/x-www-form-urlencoded" : "multipart/form-data",
      schema: { type: "object", properties },
    };
  }
  return undefined;
}

type RequestBodyOrUndefined = ApiModel["operations"][number]["requestBody"];
