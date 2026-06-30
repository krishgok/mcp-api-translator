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

export interface RuntimeContext {
  /** Resolved upstream base URL (env override or the spec's first server). */
  baseUrl: string;
  /** Schemes whose env vars carry the credentials this operation may need. */
  securitySchemes: SecurityScheme[];
  /** Environment to read credentials from (injected for testability). */
  env: Record<string, string | undefined>;
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
function applyAuth(
  headers: Record<string, string>,
  url: URL,
  security: string[],
  ctx: RuntimeContext,
): void {
  for (const scheme of ctx.securitySchemes) {
    if (!security.includes(scheme.name)) continue;
    if (scheme.type === "apiKey") {
      const value = ctx.env[scheme.envVars[0]!];
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
      const user = ctx.env[u!];
      const pass = ctx.env[p!];
      if (user && pass) {
        headers["authorization"] = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
      }
    } else {
      // http bearer, oauth2, openIdConnect -> pre-obtained token.
      const value = ctx.env[scheme.envVars[0]!];
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
    if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
  }
  const headers: Record<string, string> = {};
  for (const name of plan.headerParams) {
    const value = args[name];
    if (value !== undefined && value !== null) headers[name] = String(value);
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
  applyAuth(headers, url, plan.security, ctx);
  const response = await fetchImpl(url, { method: plan.method, headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      "HTTP " + response.status + " " + response.statusText + ": " + text.slice(0, 800),
    );
  }
  return text;
}
