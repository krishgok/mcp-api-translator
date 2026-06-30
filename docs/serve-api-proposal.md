# Design: `serve` — runtime proxy (no codegen)

Status: **implemented** for the core path (single + multi-spec stdio proxy). Roadmap items below
remain open. Motivation comes from [market-analysis.md](market-analysis.md): the market is moving
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
- Base URL per tool = `API_BASE_URL` (override) ?? that API's first declared server. For multi-API
  aggregation, each API keeps its own spec server unless `API_BASE_URL` overrides all of them.
  (Roadmap: per-API base-URL overrides — see below.)

## Verification

Unit tests (`test/runtime.test.ts`) cover executor encoding/auth/errors, proxy mount/list/call,
aggregation/dedup, and arg parsing. Verified live: `serve --spec petstore.yaml` against a mock
upstream — `getPetById {petId: 42}` proxied to `GET /pets/42` with the env `X-API-Key` injected, and
returned the upstream body. No files generated.

---

## Roadmap — remaining market-analysis recommendations

These are designed here but **not yet implemented**; each is scoped so it can land independently.

### R1. Complement dynamic tool discovery (instead of competing with static filters)

The durable curation story is to produce a clean, well-described tool set that **plays well with
client-side Tool Search / `defer_loading`**, not to lean on `<40`-tool static pruning. Concretely:
keep descriptions tight and disambiguated (already done in `describe.ts`); optionally emit a
machine-readable tool catalog (name → summary → tags) so a discovery layer can rank tools. Low effort,
high alignment with where clients are heading.

### R2. Per-API base URL + auth namespacing for aggregation

Multi-API `serve`/`generate` currently shares `API_BASE_URL`. Add per-source overrides
(e.g. `API_BASE_URL__<slug>`) and ensure env-var namespacing prevents credential collisions across
APIs. Needed before multi-API aggregation is production-grade.

### R3. Non-TypeScript output (Python first) — **implemented (generate path)**

Shipped: `generate_mcp_server` accepts `language: "python"` and emits a package built on the
low-level MCP Python SDK + stdlib `urllib`, with env-based auth and raw JSON-Schema tool inputs
(`src/emitters/python.ts`). The parser→IR→curation layers are reused unchanged; the manifest carries
a `language` field. CI generates a Python project and `py_compile`s it (`npm run e2e:python`).
**Still open:** `extend_mcp_server` for Python projects (append currently rejects non-TS projects),
and a FastMCP-flavored variant.

### R4. Hosted / one-command deploy (optional, non-core)

A managed or one-command (`fly`/`render`/container) deploy of a generated or served project, to
compete with Gram/Zuplo on convenience. This is ops/product, not a library change; it should stay
optional so the OSS tool remains self-hostable and dependency-light. Document a Dockerized `serve`
recipe first (cheapest 80%).

### R5. OAuth client-credentials / refresh

Today auth is env-supplied tokens only. Add a client-credentials grant (fetch + cache a token) for
both runtime and generated output, behind an opt-in, to cover APIs that don't accept static tokens.

## Non-goals (still)

- Interactive end-user OAuth consent flows.
- Competing with first-party vendor MCP servers for popular public APIs — the wedge is internal /
  long-tail / private APIs and multi-API aggregation.
