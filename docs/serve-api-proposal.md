# Design: `serve` — runtime proxy (no codegen)

Status: **implemented** — the core path (single + multi-spec stdio proxy) and all roadmap items
below (R1–R5). Motivation comes from [market-analysis.md](market-analysis.md): the market is moving
toward runtime proxies for "expose an existing API to an agent," and static generation-time curation
is being superseded by runtime tool discovery. This adds the runtime model alongside codegen.

## Goal

Mount one or more API specs and expose their operations as **live MCP tools in-process**, with no
generated files to build, run, or maintain. Behavior must match the generated server exactly, so a
user can prototype with `serve` and later `generate` ownable code without surprises.

```bash
mcp-api-translator serve --spec ./api.yaml
mcp-api-translator serve --spec ./petstore.yaml --spec ./billing.yaml --methods GET,POST
```

## Why a separate proxy server (not a meta-server tool)

A natural-looking idea is a `serve_api` tool on the meta-server that adds the upstream API's tools to
the running session. We deliberately did **not** do that:

- The meta-server is a high-level `McpServer`, whose `registerTool` takes a **zod** input shape and
  derives the wire schema from it. Generated/served tool inputs are **raw JSON Schema 2020-12**
  (OpenAPI 3.1 already is JSON Schema). Forcing them through zod would violate the project's
  no-lossy-round-trip invariant and degrade the schemas agents see.
- Mutating a live server's tool list mid-session is awkward and client-dependent.

Instead, `serve` runs a dedicated **low-level `Server`** (the same primitive the generated
`server.ts` uses) that advertises raw JSON-Schema tools directly. This preserves the invariant and
keeps the runtime path behaviorally identical to generated output.

## Architecture

```
spec(s) ──▶ parseSource ──▶ ApiModel ──▶ curate (filters + unique names)
                                              │
                                              ▼
                                   operationToToolEmit  ── reused from the emitter:
                                   { name, description,    same inputSchema + RequestPlan
                                     inputSchema, plan }    the generator would have written
                                              │
                                              ▼
                              ApiProxy.mount() → Map<name, MountedTool>
                                              │
                  low-level Server: tools/list → proxy.listTools()
                                    tools/call → executePlan(plan, args, ctx)
```

- `src/runtime/client.ts` — `executePlan(plan, args, ctx, fetch?)`: the in-process twin of the
  emitted `http/client.ts` + `auth.ts`. Path-param substitution (URL-encoded), query/header params,
  JSON/raw body, and env-backed auth injection (apiKey/bearer/basic) — **identical logic** to the
  generated client. `fetch` is injectable for tests.
- `src/runtime/server.ts` — `ApiProxy` (mount/list/call, dedupes names across mounts, warns past the
  40-tool threshold) and `createProxyServer()` (low-level Server wiring).
- `src/runtime/cli.ts` — `parseServeArgs` + `runServe` (stdio).
- `src/index.ts` — dispatches `serve` vs. the default meta-server.

Reusing `operationToToolEmit` is the key decision: the served tool's schema and request plan are the
**same objects** the generator embeds, so `serve` and `generate` can't drift.

## Credentials & base URL

- Secrets are read from env at **call time**, never stored (same model as generated output).
- Base URL per tool = `<NS>_API_BASE_URL` ?? `API_BASE_URL` ?? that API's first declared server;
  credentials = `<NS>_<VAR>` ?? bare `<VAR>`, where `<NS>` is the source's env namespace. This lets
  aggregated APIs use distinct base URLs/credentials without collision (see R2).

## Verification

Unit tests (`test/runtime.test.ts`) cover executor encoding/auth/errors, proxy mount/list/call,
aggregation/dedup, and arg parsing. Verified live: `serve --spec petstore.yaml` against a mock
upstream — `getPetById {petId: 42}` proxied to `GET /pets/42` with the env `X-API-Key` injected, and
returned the upstream body. No files generated.

---

## Roadmap — market-analysis recommendations (all implemented)

Each of these landed independently; the sections below record what shipped and the remaining
explicit non-goals.

### R1. Complement dynamic tool discovery (instead of competing with static filters) — **implemented**

The durable curation story is to produce a clean, well-described tool set that **plays well with
client-side Tool Search / `defer_loading`**, not to lean on `<40`-tool static pruning. Concretely:
keep descriptions tight and disambiguated (already done in `describe.ts`); optionally emit a
machine-readable tool catalog (name → summary → tags) so a discovery layer can rank tools.
Shipped: `generate_mcp_server` / `extend_mcp_server` accept `toolCatalog: true` and write a
`tool-catalog.json` (name, summary, tags, method, path, source) at the project root — extends
refresh it automatically once present — and `serve --catalog <path>` writes the same catalog for
the runtime proxy at startup (`src/emitters/catalog.ts`).

### R2. Per-API base URL + auth namespacing for aggregation — **implemented (runtime + generated)**

Each mounted/aggregated API gets an env namespace derived from its title (`envNamespace`, e.g.
`SWAGGER_PETSTORE`). A tool resolves its base URL as `<NS>_API_BASE_URL` → `API_BASE_URL` → the
spec's server, and each credential as `<NS>_<VAR>` → bare `<VAR>`. So aggregating two APIs that
both use `API_KEY` no longer collides — set `PETSTORE_API_KEY` and `BILLING_API_KEY` — while a
single-API server is unchanged (bare vars still work via fallback). `serve` prints each API's
namespaced vars when aggregating.

The same model now ships in **generated output** (TS + Python): tool files carry their source's
namespace and thread it through `callOperation` → `resolveBaseUrl`/`applyAuth` (Python:
`call_operation(..., ns)`), `.env.example` documents the per-source vars for aggregated projects,
and the extend summary prints them. Legacy tool files calling the old 2-argument form still
compile and keep reading the bare vars. This required manifest schema v2 (sources now record
`namespace`/`baseUrl`/`schemeNames`), so pre-v2 generators refuse to extend new projects instead
of emitting code that doesn't compile. Known limitation: schemes are still merged by name on
append (first definition wins), but credentials no longer collide because each tool reads through
its own namespace.

### R3. Non-TypeScript output (Python first) — **implemented (generate + extend)**

Shipped: `generate_mcp_server` accepts `language: "python"` and emits a package built on the
low-level MCP Python SDK + stdlib `urllib`, with env-based auth and raw JSON-Schema tool inputs
(`src/emitters/python.ts`). `extend_mcp_server` also works for Python projects: it merges new tools
into the package's single `tools.json` (preserving existing entries, idempotent by `METHOD path`)
and regenerates the shared infrastructure from the merged model. The parser→IR→curation layers are
reused unchanged; the manifest carries a `language` field. CI generates a Python project, appends a
second API, and `py_compile`s the result (`npm run e2e:python`).

The **FastMCP-flavored variant** also shipped: `pythonVariant: "fastmcp"` emits a server built on
FastMCP 2.x that registers each tool as a `Tool` subclass with the raw JSON-Schema input passed
verbatim (`parameters=`) — never FastMCP's type-hint schema derivation — so the
no-lossy-round-trip invariant holds for both flavors. The flavor is recorded in the manifest and
preserved across extends; only `server.py`, `__main__.py`, and the dependency list differ. CI
installs FastMCP and drives the generated server through the in-memory client to assert the wire
schemas match `tools.json` byte-for-byte (`scripts/fastmcp-smoke.py`). Per-API auth namespacing
for aggregated APIs shipped with R2.

### R4. Hosted / one-command deploy (optional, non-core) — **implemented (Docker recipe + HTTP serve)**

A managed or one-command (`fly`/`render`/container) deploy of a generated or served project, to
compete with Gram/Zuplo on convenience. This is ops/product, not a library change; it should stay
optional so the OSS tool remains self-hostable and dependency-light.

Shipped: [deploy-serve.md](deploy-serve.md) documents the Dockerized `serve` recipe (stdio client
config, spec volume mounts, env-file credentials, compose), and `serve --transport http --port N`
serves stateless Streamable HTTP at `/mcp` — one mounted proxy backing a fresh Server per request,
with the same DNS-rebinding protection the generated `index.http.ts` emits (`MCP_ALLOWED_HOSTS`
override, `PORT` honored) — which is what fly/Render/Cloud Run need. CI smoke-tests the HTTP path
end-to-end (`npm run smoke:serve:http`). A managed offering remains a non-goal.

### R5. OAuth client-credentials + refresh-token grants — **implemented**

Shipped for runtime **and** generated output (TS + Python). When a spec declares an OAuth2
`clientCredentials` flow, the parser captures its `tokenUrl` and assigns `API_CLIENT_ID` /
`API_CLIENT_SECRET` env vars (instead of `API_TOKEN`). At call time the proxy / generated `auth`
module exchanges the id+secret for a bearer token (`grant_type=client_credentials`) and caches it
until ~30s before expiry. Verified live through `serve` (token fetched, `Bearer` injected) and by
compiling the generated async-auth TS + Python in CI.

The **refresh-token grant** works the same way for `authorizationCode` / `password` flows (whose
token endpoints accept `grant_type=refresh_token`): supply a pre-obtained refresh token via
`API_REFRESH_TOKEN` + `API_CLIENT_ID` (client secret optional for public clients) and the proxy /
generated auth exchanges and caches access tokens; rotated refresh tokens are kept in memory. A
pre-obtained bearer in `API_TOKEN` still works as a fallback, so setups that predate refresh
support keep working. `clientCredentials` wins when a scheme declares several flows.
**Still open:** authorization-code / interactive consent flows (a non-goal).

## Non-goals (still)

- Interactive end-user OAuth consent flows.
- Competing with first-party vendor MCP servers for popular public APIs — the wedge is internal /
  long-tail / private APIs and multi-API aggregation.
