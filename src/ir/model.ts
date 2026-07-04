/**
 * Intermediate representation (IR) shared by every parser and emitter.
 *
 * Parsers (OpenAPI, Postman, ...) translate their source format into an {@link ApiModel};
 * emitters consume an {@link ApiModel} to produce a generated MCP-server project. Keeping
 * this layer between input and output is what lets a new input format reuse the whole
 * generator, and a new output target reuse every parser.
 */

/** A JSON Schema fragment (Draft 2020-12 / OpenAPI 3.1 compatible). */
export type JsonSchema = Record<string, unknown>;

export type SourceFormat = "openapi" | "postman";

export type SecuritySchemeType = "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";

/**
 * A credential requirement detected on the source API. The emitter turns each scheme into
 * env-driven auth injection in the generated server. We never embed secret values.
 */
export interface SecurityScheme {
  /** The scheme key as named in the source document. */
  name: string;
  type: SecuritySchemeType;
  /** Where an apiKey is sent. */
  in?: "header" | "query" | "cookie";
  /** Header/query/cookie name for an apiKey. */
  paramName?: string;
  /** For `http` schemes: "bearer" | "basic" | ... */
  scheme?: string;
  /**
   * OAuth2 token endpoint, when a non-interactive flow is detected. Its presence switches the
   * scheme from "pre-obtained token" to fetch-a-token-at-runtime (env vars become client id/secret,
   * plus a refresh token for the refresh_token grant).
   */
  tokenUrl?: string;
  /**
   * Which grant the token endpoint is used with. Absent on legacy manifests: `tokenUrl` without a
   * `grant` always means client_credentials.
   */
  grant?: "client_credentials" | "refresh_token";
  /** Env var(s) the generated server reads the credential from. */
  envVars: string[];
}

export type ParameterLocation = "path" | "query" | "header" | "cookie";

export interface Parameter {
  name: string;
  in: ParameterLocation;
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

export interface RequestBody {
  required: boolean;
  /** e.g. "application/json". */
  contentType: string;
  description?: string;
  schema: JsonSchema;
}

/** A single callable operation that becomes one MCP tool. */
export interface Operation {
  /** Unique, MCP-safe tool name (assigned during curation). */
  toolName: string;
  operationId?: string;
  /** Upper-case HTTP method. */
  method: string;
  /** Path template, e.g. "/pets/{petId}". */
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: Parameter[];
  requestBody?: RequestBody;
  /** Names of {@link SecurityScheme}s required for this operation. */
  security: string[];
}

export interface ApiModel {
  title: string;
  version: string;
  description?: string;
  /** Base URLs declared by the source (first is used as the default). */
  servers: string[];
  securitySchemes: SecurityScheme[];
  operations: Operation[];
  sourceFormat: SourceFormat;
}
