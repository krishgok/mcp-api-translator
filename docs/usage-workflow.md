# Usage Workflow — `mcp-api-translator`

This walks through the **end-to-end journey of a typical user**: from "I have an API spec" to "an
AI agent (Claude / Cursor / Codex) is calling that API through an MCP server I own."

`mcp-api-translator` is itself an MCP server. You don't run its commands by hand — you connect it
to your agent once, then ask the agent to drive its four tools. This document shows both what you
say to the agent and what happens underneath.

---

## TL;DR

```bash
# 1. Install & connect the generator (once)
git clone https://github.com/krishgok/mcp-api-translator && cd mcp-api-translator
npm install && npm run build
#    → add dist/index.js to your MCP client as "api-translator" (see Step 0)

# 2. In your agent, drive the generator (no shell needed):
#    "analyze ./api.yaml, then generate an MCP server for the GET endpoints into ./api-mcp"

# 3. Build, configure, and run the generated server
cd api-mcp && npm install && npm run build
cp .env.example .env          # set API_BASE_URL + any credentials
npm start
#    → add api-mcp/dist/index.js to your MCP client; your agent can now call the API
```

The rest of this document explains each step and what happens underneath.

---

## The mental model

```
  Your API spec                  mcp-api-translator                 A new project you own
 (OpenAPI / Postman)   ─────▶   (analyze → generate)    ─────▶    <api>-mcp/  (TypeScript)
                                                                         │
                                                                         ▼
                                                            Run it → your agent calls the API
```

- **Stage 1 — meta-server:** `mcp-api-translator` reads a spec and _generates code_.
- **Stage 2 — generated server:** the output is a normal, standalone TypeScript MCP server that
  talks to the upstream API. You build, configure, and run _that_ — `mcp-api-translator` is no
  longer in the loop at runtime.

Two distinct servers. Don't confuse "the generator" with "the thing you generated."

---

## Prerequisites

- Node.js ≥ 20.
- An MCP client (Claude Desktop, Claude Code, Cursor, or Codex).
- An API definition: OpenAPI 3.0/3.1 (JSON or YAML) or a Postman v2.1 collection. Swagger 2.0 works
  best-effort.

---

## Step 0 — Install and connect the generator (one time)

```bash
git clone https://github.com/krishgok/mcp-api-translator
cd mcp-api-translator
npm install
npm run build      # produces dist/index.js (the stdio entry point)
```

Register it with your client. Claude Desktop / Claude Code (`mcp.json` /
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "api-translator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-api-translator/dist/index.js"]
    }
  }
}
```

Cursor (`.cursor/mcp.json`) and Codex use the same `mcpServers` shape. Restart the client; you
should now see four tools: `analyze_spec`, `generate_mcp_server`, `extend_mcp_server`,
`list_supported_features`.

> First call has a ~3 s cold start (Node + parser libraries load once); subsequent calls are a few
> milliseconds.

---

## Step 1 — Analyze before you generate (curation loop)

**Always start with `analyze_spec`.** It parses the spec and previews the tool list **without
writing any files**, so you can see how big the surface is and trim it before committing.

> You, to the agent: _"Analyze ./petstore.yaml with api-translator and show me the proposed tools."_

The agent calls `analyze_spec` with `{ specPath: "./petstore.yaml" }` and gets back:

```json
{
  "title": "Swagger Petstore",
  "version": "1.0.0",
  "sourceFormat": "openapi",
  "servers": ["https://petstore.example.com/v1"],
  "authSchemes": [{ "name": "apiKey", "type": "apiKey", "envVars": ["API_KEY"] }],
  "operationsTotal": 3,
  "operationsKept": 3,
  "operationsFilteredOut": 0,
  "proposedTools": [
    { "name": "createPet", "method": "POST", "path": "/pets", "summary": "Create a pet" },
    { "name": "getPetById", "method": "GET", "path": "/pets/{petId}", "summary": "Info for a pet" },
    { "name": "listPets", "method": "GET", "path": "/pets", "summary": "List all pets" }
  ]
}
```

### Why this matters: curation

A 200-endpoint API naively becomes 200 tools, which wrecks an agent's tool-selection accuracy. If
`operationsKept` is large (the generator warns above **40**), narrow it. Every tool accepts the
same filters:

| Filter              | Effect                                                   | Example         |
| ------------------- | -------------------------------------------------------- | --------------- |
| `includeTags`       | keep only ops with these tags                            | `["pets"]`      |
| `methods`           | keep only these HTTP methods                             | `["GET"]`       |
| `pathGlob`          | keep only matching paths (`*` = one segment, `**` = any) | `"/v1/**"`      |
| `excludeOperations` | drop by operationId / tool name / tag                    | `["deletePet"]` |

> _"Analyze it again, but only the GET endpoints under `/pets`."_ → agent passes
> `{ methods: ["GET"], pathGlob: "/pets/**" }`. Re-run until the list looks right. Nothing is
> written yet.

---

## Step 2 — Generate the server

Once the previewed list is what you want, switch to `generate_mcp_server` with the **same filters**
plus an `outputDir`.

> _"Generate the MCP server into ./petstore-mcp."_

The agent calls
`generate_mcp_server({ specPath: "./petstore.yaml", outputDir: "./petstore-mcp" })` and gets:

```
Generated MCP server "petstore-mcp" at /abs/path/petstore-mcp
Tools added: 3 | skipped: 0 | total now: 3

Files written:
  - package.json
  - tsconfig.json
  - .env.example
  - Dockerfile
  - server.json
  - client-config.md
  - README.md
  - src/types.ts
  - src/config.ts
  - src/auth.ts
  - src/http/client.ts
  - src/server.ts
  - src/index.ts
  - src/tools/index.ts
  - src/tools/createPet.ts        (one file per operation)
  - src/tools/getPetById.ts
  - src/tools/listPets.ts
  - .mcp-translator.json          (manifest — powers `extend` later)

Next steps:
  cd /abs/path/petstore-mcp
  npm install && npm run build
  cp .env.example .env   # fill in API_BASE_URL and any credentials
  npm start
```

Useful options:

- `language` — `"typescript"` (default) or `"python"`. Python emits a package using the low-level
  MCP Python SDK + stdlib `urllib` (run with `pip install -e . && python -m <pkg>`).
- `serverName` — npm/package name (defaults from the API title).
- `transport` — `"stdio"` (default), `"http"`, or `"both"` (TypeScript only). `http`/`both` also
  emits `src/index.http.ts` (Streamable HTTP on `PORT`, default 3000, at `/mcp`).
- `force: true` — overwrite a non-empty / existing directory.

### What the generated project looks like

```
petstore-mcp/
├── src/
│   ├── index.ts          # stdio entry (index.http.ts too if http/both)
│   ├── server.ts         # registers tools (low-level Server + JSON-Schema inputs)
│   ├── tools/<name>.ts   # one file per operation: input schema + request plan
│   ├── http/client.ts    # builds the request, fetch, error handling
│   ├── auth.ts           # env-based credential injection
│   └── config.ts         # base URL (API_BASE_URL or the spec's server)
├── .env.example          # API_BASE_URL + any detected credential vars
├── server.json           # MCP Registry manifest (for publishing)
├── client-config.md      # paste-ready Claude / Cursor / Codex snippet
├── Dockerfile
└── .mcp-translator.json  # manifest that powers `extend_mcp_server`
```

It's **yours** — readable, hand-editable TypeScript with no runtime dependency on
`mcp-api-translator`.

---

## Step 3 — Configure credentials

The generator **never embeds secrets**. It detects the spec's auth scheme and wires the generated
`auth.ts` to read credentials from environment variables at runtime. `analyze_spec` told you which
vars (`API_KEY` above); `.env.example` lists them with empty values.

```bash
cd petstore-mcp
cp .env.example .env
```

```dotenv
# .env
API_BASE_URL=https://petstore.example.com/v1   # overrides the spec's default server
API_KEY=sk_live_xxxxxxxx                         # read at runtime; never committed
```

Env-var naming by scheme:

| Spec auth (env var mapping below)                           | Generated env var(s)                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apiKey` (header/query/cookie)                              | `API_KEY`                                                                        |
| `http` bearer / oauth2 / openIdConnect (pre-obtained token) | `API_TOKEN`                                                                      |
| `http` basic                                                | `API_USERNAME`, `API_PASSWORD`                                                   |
| `oauth2` **client-credentials** (spec has a `tokenUrl`)     | `API_CLIENT_ID`, `API_CLIENT_SECRET`                                             |
| `oauth2` **refresh-token** (authorizationCode/password)     | `API_CLIENT_ID`, `API_CLIENT_SECRET`, `API_REFRESH_TOKEN` (`API_TOKEN` fallback) |

For a client-credentials scheme, the server exchanges the id+secret for a bearer token at the spec's
`tokenUrl` and caches it. For a refresh-token scheme, supply a pre-obtained refresh token in
`API_REFRESH_TOKEN` (client secret optional for public clients); a plain bearer in `API_TOKEN` still
works as a fallback. (Multiple schemes that would collide get namespaced by scheme name.)

> **Trust note:** a generated server calls whatever base URL the spec declares and sends your
> credentials there. If the spec came from an untrusted source, review `config.ts` / `auth.ts` and
> set `API_BASE_URL` explicitly before using real secrets. See the README's _Security & trust
> model_.

---

## Step 4 — Build, run, and connect the generated server

```bash
npm install
npm run build
npm start          # runs over stdio
```

Register _this_ server with your client (snippet is pre-written in `client-config.md`):

```json
{
  "mcpServers": {
    "petstore": {
      "command": "node",
      "args": ["/abs/path/petstore-mcp/dist/index.js"],
      "env": {
        "API_BASE_URL": "https://petstore.example.com/v1",
        "API_KEY": "sk_live_xxxxxxxx"
      }
    }
  }
}
```

Now your agent has `createPet`, `getPetById`, `listPets` as first-class tools:

> _"List the first 5 pets, then fetch details for the one named Fido."_ → the agent calls
> `listPets`, then `getPetById` with the right `petId`. The generated `http/client.ts` substitutes
> path params (URL-encoded), adds query params, injects the `API_KEY` header, and returns the
> response body.

---

## Step 5 — Aggregate more APIs (optional)

`extend_mcp_server` appends another spec's operations to an **existing** generated project, so one
server can span multiple APIs (e.g. Petstore + GitHub + your internal API).

> _"Extend ./petstore-mcp with ./github.openapi.yaml, just the `issues` tag."_

`extend_mcp_server({ projectDir: "./petstore-mcp", specPath: "./github.openapi.yaml", includeTags: ["issues"] })`:

```
Extended MCP server "petstore-mcp" at /abs/path/petstore-mcp
Tools added: 4 | skipped: 0 | total now: 7
```

Key behaviors:

- **Idempotent** — operations already present (matched by `METHOD path`) are skipped, so re-running
  the same spec adds nothing.
- **Preserves your edits** — hand-edited `src/tools/*.ts` files are never overwritten unless you
  pass `force: true`. Shared infra (`auth.ts`, `config.ts`, `server.json`, …) is regenerated from
  the merged manifest, so credentials from both APIs are wired up.
- **Per-API env namespacing** — each aggregated API reads its own
  `<NAMESPACE>_API_BASE_URL` / `<NAMESPACE>_<VAR>` (namespace derived from the API title, e.g.
  `SWAGGER_PETSTORE_API_KEY`) before falling back to the bare var, so two APIs that both use
  `API_KEY` don't share one credential. The exact names are listed in the extend summary and in
  the regenerated `.env.example`.

After extending, `npm run build` and restart the client.

---

## Step 6 — Publish for discovery (optional)

The generated `server.json` is a starter MCP Registry manifest. Edit the owner/namespace, then
publish so AI clients can discover your server:

```jsonc
// server.json
{
  "name": "io.github.YOUR_HANDLE/petstore-mcp",
  "description": "Swagger Petstore (v1.0.0)",
  "version": "1.0.0",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "petstore-mcp",
      "version": "1.0.0",
      "transport": { "type": "stdio" },
    },
  ],
}
```

---

## Alternative path — serve a live proxy (no codegen)

If you don't need an ownable codebase and just want an API exposed to your agent **right now**, skip
generation entirely and run a runtime proxy:

```bash
# Mount one API as live MCP tools (no files written)
mcp-api-translator serve --spec ./petstore.yaml

# Aggregate several APIs into one proxy, with the same curation filters
mcp-api-translator serve --spec ./petstore.yaml --spec ./billing.yaml \
  --methods GET,POST --include-tag pets --path-glob "/v1/**"

# Streamable HTTP instead of stdio (containers / hosted deploys; see docs/deploy-serve.md)
mcp-api-translator serve --spec ./petstore.yaml --transport http --port 3000

# Write a machine-readable tool catalog (name/summary/tags) for discovery layers
mcp-api-translator serve --spec ./petstore.yaml --catalog ./tool-catalog.json
```

Point your MCP client at the proxy instead of a generated project:

```json
{
  "mcpServers": {
    "apis": {
      "command": "mcp-api-translator",
      "args": ["serve", "--spec", "/abs/path/petstore.yaml"],
      "env": { "API_BASE_URL": "https://petstore.example.com/v1", "API_KEY": "sk_live_xxx" }
    }
  }
}
```

The proxy runs the **same request plan and env-based auth** the generator would have emitted, so a
mounted tool behaves identically to the generated one — it just skips writing code.

**Aggregating multiple APIs?** Each API gets its own env namespace (from its title) so credentials
and base URLs don't collide. Set `<SOURCE>_API_BASE_URL` / `<SOURCE>_API_KEY` (e.g.
`SWAGGER_PETSTORE_API_KEY`, `ECHO_API_API_TOKEN`); the bare `API_BASE_URL` / `API_KEY` still work as
a shared fallback. `serve` prints each API's exact env-var names on startup.

**Generate vs. serve:**

|                                   | `generate_mcp_server`                    | `serve`                                   |
| --------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Output                            | an ownable TypeScript project            | nothing on disk; live in-process tools    |
| Edit behavior by hand?            | yes                                      | no (regenerate/serve to change)           |
| Stays in sync as the spec changes | re-generate / `extend`                   | re-launch with the new spec               |
| Best for                          | owned, customizable, self-hosted servers | fast exposure, prototyping, internal APIs |

Curation filters, env-based auth, and multi-API aggregation work the same in both modes. See
[serve-api-proposal.md](serve-api-proposal.md) for the design and roadmap.

## End-to-end at a glance

```
1. analyze_spec        → preview tools, decide filters        (writes nothing)
2. generate_mcp_server → scaffold <api>-mcp/ with chosen tools
3. cp .env.example .env, fill API_BASE_URL + credentials
4. npm install && npm run build && npm start
5. add <api>-mcp to your MCP client (client-config.md)
6. (optional) extend_mcp_server to add more APIs
7. (optional) edit server.json and publish to the MCP Registry
```

`list_supported_features` returns the current formats, auth schemes, transports, and limits at any
time if you're unsure what's supported.

---

## Troubleshooting

| Symptom                                                                               | Cause / Fix                                                                                                                         |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Could not detect the spec format…`                                                   | Auto-detect failed. Pass `format: "openapi"` or `"postman"` explicitly.                                                             |
| `Parsed API model failed validation: - operations[0].path "pets" must start with "/"` | The **validation gate** rejected a malformed spec before generating. The message names the exact field — fix it in the source spec. |
| `<dir> is not empty. Pass force: true to overwrite.`                                  | `generate_mcp_server` won't clobber existing files. Use a fresh `outputDir` or `force: true`.                                       |
| `<dir> is already a generated project. Use extend_mcp_server…`                        | You pointed `generate` at an existing project. Use `extend_mcp_server` to add tools, or `force: true` to regenerate.                |
| `<dir> has no .mcp-translator.json…`                                                  | `extend` target isn't a generated project. Generate first.                                                                          |
| `.mcp-translator.json is schema version N, newer than this generator supports`        | The project was made by a newer `mcp-api-translator`. Upgrade the generator.                                                        |
| `Refusing to generate N tools (limit 1000)`                                           | The spec is huge. Narrow with `includeTags` / `methods` / `pathGlob` / `excludeOperations`.                                         |
| `Spec is N bytes, exceeding the … limit`                                              | Spec exceeds 16 MB. Split it.                                                                                                       |
| Too many tools warning (> 40)                                                         | Generation still succeeds, but agent tool-selection degrades. Re-run with filters.                                                  |
| Generated server: `API base URL is not set`                                           | Set `API_BASE_URL` in the environment / client `env` block.                                                                         |
| Generated server returns `HTTP 401/403`                                               | Credential env vars are missing or wrong. Check `.env` against `.env.example`.                                                      |

---

## Notes & limits

- **Inputs:** OpenAPI 3.0/3.1 and Postman v2.1 (Swagger 2.0 best-effort). No GraphQL/gRPC yet.
- **Auth:** API key / bearer / basic / pre-obtained OAuth token, all from env. No interactive OAuth
  flows or token refresh.
- **Responses:** returned as JSON/text; no upstream streaming or automatic pagination.
- **Output quality tracks spec quality** — good `operationId`s and descriptions yield better tool
  names and docs. Curation helps; it can't invent semantics.
- **Postman** parameter types are inferred from example values.
