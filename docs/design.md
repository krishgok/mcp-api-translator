# Design notes

Background on how `mcp-api-translator` is built and what it emits. For the end-to-end journey see
[usage-workflow.md](usage-workflow.md); for the runtime proxy see
[serve-api-proposal.md](serve-api-proposal.md).

## Tech stack & rationale

- **TypeScript on the official `@modelcontextprotocol/sdk`** — MCP's Tier-1 SDK; the most portable
  output target (runs on any Node host, `npx`-friendly for Claude/Cursor/Codex).
- **`@readme/openapi-parser`** for `$ref`-resolved OpenAPI 3.0/3.1 (+ best-effort Swagger 2.0);
  Postman v2.1 is parsed directly.
- **Raw JSON Schema for generated tool inputs.** OpenAPI 3.1 schemas _are_ JSON Schema 2020-12,
  which is exactly what an MCP tool's `inputSchema` expects — so there's no lossy zod round-trip.
- **String-builder templates, no template engine** — minimal deps, every emitter is
  snapshot-testable.

## Generated project layout

```
src/index.ts            # stdio entry (index.http.ts too if transport http/both)
src/server.ts           # registers tools (low-level Server + JSON-Schema inputs)
src/tools/<name>.ts     # one file per operation: schema + request plan
src/http/client.ts      # builds the request, fetch, error handling
src/auth.ts             # env-based credential injection
src/logger.ts           # structured stderr logger (JSON lines in containers; LOG_LEVEL/LOG_FORMAT)
.env.example            # API_BASE_URL + any detected credentials
server.json             # MCP Registry manifest
client-config.md        # paste-ready Claude / Cursor / Codex config
.mcp-translator.json    # manifest that powers extend_mcp_server
tool-catalog.json       # optional (toolCatalog: true): name/summary/tags per tool
```

## Assumptions & limitations

- **Inputs:** OpenAPI 3.0/3.1 and Postman v2.1 (Swagger 2.0 best-effort). No GraphQL/gRPC yet.
- **Output languages:** TypeScript (default) and Python. Both support generation and appending
  (aggregating multiple APIs into one server). Python can be flavored with
  `pythonVariant: "fastmcp"` (FastMCP 2.x instead of the low-level SDK); both flavors serve the
  same raw JSON-Schema tool inputs.
- **Output quality tracks spec quality** — missing `operationId`s/descriptions yield weaker tool
  names and docs. Curation helps; it can't invent semantics.
- **Auth:** API key / bearer / basic / pre-obtained OAuth token, plus the **OAuth2
  client-credentials grant** and the **refresh-token grant** (exchange a pre-obtained refresh
  token; tokens fetched + cached), all read from env. **No interactive (authorization-code)
  consent flows** in v1. A spec that declares no security at all warns, and an `auth` argument
  supplies one — see [usage-workflow.md](usage-workflow.md#when-the-spec-declares-no-auth).
- **Responses** are returned as JSON/text; no upstream streaming or automatic pagination.
- **Postman** parameter types are inferred from examples (Postman carries no formal schema).
- **Not a hosted service.** It runs locally/self-hosted: generate ownable code, or serve a live
  in-process proxy. No managed cloud offering — see
  [serve-api-proposal.md](serve-api-proposal.md) for the roadmap.

## Security & trust model

A spec is treated as **untrusted input**: spec-derived strings are escaped before they're embedded
in generated source, generated tool names are restricted to `[A-Za-z0-9_]`, `$ref` resolution is
internal-only (a hostile spec cannot make the parser fetch a URL or read a local file), and all
file writes stay under `outputDir`.

Two things are inherent to what a generated server _does_, so review the output before pointing it
at credentials:

- **The generated server calls whatever base URL the spec declares** (or `API_BASE_URL`) and injects
  your env-supplied credentials into those requests. Generating from a spec you don't trust, then
  running it with real secrets, can send those secrets to a host the spec chose. Set `API_BASE_URL`
  explicitly when in doubt.
- **Secrets are never embedded** in the generated project — `auth.ts` reads them from the
  environment at runtime and `.env.example` ships with empty values.

To report a vulnerability, see [../SECURITY.md](../SECURITY.md).
