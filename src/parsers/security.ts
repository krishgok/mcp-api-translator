/**
 * Shared helpers for turning detected auth into env-var-backed {@link SecurityScheme}s.
 *
 * Credentials are always read from the environment by the generated server — never embedded.
 * We prefer friendly names (API_KEY, API_TOKEN, ...) and only namespace by scheme name when two
 * schemes would otherwise collide.
 */
import type { ApiModel, SecurityScheme, SecuritySchemeType } from "../ir/model.js";

function envPrefix(schemeName: string): string {
  return (
    schemeName
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "AUTH"
  );
}

/**
 * Env-var namespace for one source API (from its title), e.g. "Swagger Petstore" -> "SWAGGER_PETSTORE".
 * Used to disambiguate credentials/base URLs when several APIs are aggregated into one server:
 * a mounted tool reads `<NAMESPACE>_API_KEY` in preference to the bare `API_KEY`.
 */
export function envNamespace(source: string): string {
  return (
    source
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "API"
  );
}

interface RawScheme {
  name: string;
  type: SecuritySchemeType;
  in?: "header" | "query" | "cookie";
  paramName?: string;
  scheme?: string;
  /** OAuth2 token endpoint, if a non-interactive flow was detected. */
  tokenUrl?: string;
  /** Grant the token endpoint is used with; absent means client_credentials. */
  grant?: "client_credentials" | "refresh_token";
}

/** Friendly env var slots for a scheme, before collision resolution. */
function friendlyEnvVars(raw: RawScheme): string[] {
  if (raw.type === "http" && raw.scheme?.toLowerCase() === "basic") {
    return ["API_USERNAME", "API_PASSWORD"];
  }
  if (raw.tokenUrl && (raw.type === "oauth2" || raw.type === "openIdConnect")) {
    // refresh_token grant: exchange a pre-obtained refresh token for access tokens. The trailing
    // API_TOKEN slot is a documented fallback so a plain pre-obtained bearer keeps working.
    if (raw.grant === "refresh_token") {
      return ["API_CLIENT_ID", "API_CLIENT_SECRET", "API_REFRESH_TOKEN", "API_TOKEN"];
    }
    // client-credentials: read a client id/secret and fetch a token.
    return ["API_CLIENT_ID", "API_CLIENT_SECRET"];
  }
  if (raw.type === "http") return ["API_TOKEN"]; // bearer and other http schemes
  if (raw.type === "oauth2" || raw.type === "openIdConnect") return ["API_TOKEN"];
  return ["API_KEY"]; // apiKey and anything else
}

/**
 * A caller-supplied auth scheme, for APIs whose spec models no security of its own (see the
 * warning `noAuthWarnings` emits). Mirrors the OpenAPI shapes the emitters already handle.
 */
export type AuthOverride =
  | { type: "apiKey"; in?: "header" | "query" | "cookie"; name?: string }
  | { type: "http"; scheme: "bearer" | "basic" }
  | { type: "oauth2"; tokenUrl: string; grant?: "client_credentials" | "refresh_token" };

/** Scheme name for an override, avoiding collision with anything the spec already declares. */
function overrideName(taken: Iterable<string>): string {
  const used = new Set(taken);
  let name = "authOverride";
  for (let i = 2; used.has(name); i++) name = `authOverride${i}`;
  return name;
}

/**
 * Attach a caller-supplied scheme to a model, for specs that declare no usable security.
 *
 * Applied only to operations whose own security list is empty: a spec that does model auth for an
 * operation is describing something the override cannot know better, so those are left alone. Env
 * vars are re-derived across the whole set so the override cannot silently claim a slot (API_KEY,
 * API_TOKEN, ...) that a declared scheme already uses.
 */
export function applyAuthOverride(
  model: ApiModel,
  override: AuthOverride,
  /** Extra names already claimed elsewhere — e.g. schemes an existing project's manifest holds. */
  reserved: string[] = [],
): ApiModel {
  const name = overrideName([...model.securitySchemes.map((s) => s.name), ...reserved]);
  const raw: RawScheme =
    override.type === "apiKey"
      ? {
          name,
          type: "apiKey",
          in: override.in ?? "header",
          paramName: override.name ?? "X-API-Key",
        }
      : override.type === "http"
        ? { name, type: "http", scheme: override.scheme }
        : {
            name,
            type: "oauth2",
            tokenUrl: override.tokenUrl,
            grant: override.grant ?? "client_credentials",
          };

  return {
    ...model,
    securitySchemes: assignEnvVars([...model.securitySchemes, raw]),
    operations: model.operations.map((op) =>
      op.security.length === 0 ? { ...op, security: [name] } : op,
    ),
  };
}

/**
 * Assign env vars across all schemes, namespacing by scheme name where the friendly name is
 * already claimed by a different scheme.
 */
export function assignEnvVars(rawSchemes: RawScheme[]): SecurityScheme[] {
  const used = new Set<string>();
  return rawSchemes.map((raw) => {
    const friendly = friendlyEnvVars(raw);
    const collides = friendly.some((v) => used.has(v));
    const envVars = collides
      ? friendly.map((v) => `${envPrefix(raw.name)}_${v.replace(/^API_/, "")}`)
      : friendly;
    for (const v of envVars) used.add(v);
    return {
      name: raw.name,
      type: raw.type,
      in: raw.in,
      paramName: raw.paramName,
      scheme: raw.scheme,
      tokenUrl: raw.tokenUrl,
      grant: raw.grant,
      envVars,
    };
  });
}
