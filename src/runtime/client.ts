/**
 * In-process HTTP executor for the runtime proxy (`serve` mode).
 *
 * This is the no-codegen twin of the emitted `src/http/client.ts` + `src/auth.ts`: it runs the
 * exact same RequestPlan the generator would have written, so a mounted operation behaves
 * identically whether you `serve` it live or `generate` and run the code. Credentials are read
 * from the environment at call time and never stored.
 */
import type { SecurityScheme } from "../ir/model.js";
import type { RequestPlanData } from "../emitters/templates.js";
import { getClientCredentialsToken } from "./oauth.js";

export interface RuntimeContext {
  /** Resolved upstream base URL (env override or the spec's first server). */
  baseUrl: string;
  /** Schemes whose env vars carry the credentials this operation may need. */
  securitySchemes: SecurityScheme[];
  /** Environment to read credentials from (injected for testability). */
  env: Record<string, string | undefined>;
  /**
   * Per-source env namespace for aggregated servers, e.g. "SWAGGER_PETSTORE". When set, a
   * credential is read from `<namespace>_<VAR>` first, falling back to the bare `<VAR>`.
   */
  sourceNamespace?: string;
}

/** Minimal fetch surface so tests can inject a stub without a real network. */
export type FetchLike = (
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; statusText: string; text: () => Promise<string> }>;

function joinUrl(base: string, path: string): string {
  if (!base) throw new Error("API base URL is not set. Set API_BASE_URL in the environment.");
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

/** Inject env-backed credentials for every scheme this operation declares. */
async function applyAuth(
  headers: Record<string, string>,
  url: URL,
  security: string[],
  ctx: RuntimeContext,
  fetchImpl: FetchLike,
): Promise<void> {
  // Per-source namespace wins over the bare var, so aggregated APIs don't share one credential.
  const readEnv = (name: string): string | undefined =>
    (ctx.sourceNamespace ? ctx.env[`${ctx.sourceNamespace}_${name}`] : undefined) ?? ctx.env[name];
  for (const scheme of ctx.securitySchemes) {
    if (!security.includes(scheme.name)) continue;
    if (scheme.type === "apiKey") {
      const value = readEnv(scheme.envVars[0]!);
      if (!value) continue;
      const param = scheme.paramName ?? "X-API-Key";
      if (scheme.in === "query") {
        url.searchParams.set(param, value);
      } else if (scheme.in === "cookie") {
        headers["cookie"] =
          (headers["cookie"] ? headers["cookie"] + "; " : "") + param + "=" + value;
      } else {
        headers[param] = value;
      }
    } else if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic") {
      const [u, p] = scheme.envVars;
      const user = readEnv(u!);
      const pass = readEnv(p!);
      if (user && pass) {
        headers["authorization"] = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
      }
    } else if (scheme.tokenUrl) {
      // oauth2 client-credentials: envVars = [CLIENT_ID, CLIENT_SECRET] -> fetch a bearer token.
      const clientId = readEnv(scheme.envVars[0]!);
      const clientSecret = readEnv(scheme.envVars[1]!);
      if (clientId && clientSecret) {
        const token = await getClientCredentialsToken(
          scheme.tokenUrl,
          clientId,
          clientSecret,
          fetchImpl,
        );
        headers["authorization"] = "Bearer " + token;
      }
    } else {
      // http bearer, oauth2, openIdConnect -> pre-obtained token.
      const value = readEnv(scheme.envVars[0]!);
      if (value) headers["authorization"] = "Bearer " + value;
    }
  }
}

/** Execute one operation's request plan against the live upstream and return the response text. */
export async function executePlan(
  plan: RequestPlanData,
  args: Record<string, unknown>,
  ctx: RuntimeContext,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  let path = plan.pathTemplate;
  for (const name of plan.pathParams) {
    const value = args[name];
    path = path.split("{" + name + "}").join(encodeURIComponent(String(value ?? "")));
  }
  const url = new URL(joinUrl(ctx.baseUrl, path));
  for (const name of plan.queryParams) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    // Array query values are repeated (?k=1&k=2), the OpenAPI default (form/explode).
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v !== undefined && v !== null) url.searchParams.append(name, String(v));
      }
    } else {
      url.searchParams.set(name, String(value));
    }
  }
  const headers: Record<string, string> = {};
  for (const name of plan.headerParams) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    headers[name] = Array.isArray(value) ? value.map(String).join(",") : String(value);
  }
  const cookies: string[] = [];
  for (const name of plan.cookieParams) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      cookies.push(name + "=" + encodeURIComponent(String(value)));
    }
  }
  if (cookies.length > 0) {
    headers["cookie"] = (headers["cookie"] ? headers["cookie"] + "; " : "") + cookies.join("; ");
  }
  let body: string | undefined;
  if (plan.bodyParam && args[plan.bodyParam] !== undefined) {
    const raw = args[plan.bodyParam];
    if (plan.contentType && plan.contentType.indexOf("json") >= 0) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(raw);
    } else {
      if (plan.contentType) headers["content-type"] = plan.contentType;
      body = typeof raw === "string" ? raw : JSON.stringify(raw);
    }
  }
  await applyAuth(headers, url, plan.security, ctx, fetchImpl);
  const response = await fetchImpl(url, { method: plan.method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      "HTTP " + response.status + " " + response.statusText + ": " + text.slice(0, 800),
    );
  }
  return text;
}
