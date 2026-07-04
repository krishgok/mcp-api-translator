# mcp-api-translator

[![npm](https://img.shields.io/npm/v/mcp-api-translator.svg)](https://www.npmjs.com/package/mcp-api-translator)
[![CI](https://github.com/krishgok/mcp-api-translator/actions/workflows/ci.yml/badge.svg)](https://github.com/krishgok/mcp-api-translator/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Commercial license available](https://img.shields.io/badge/License-Commercial-green.svg)](LICENSING.md)
[![MCP](https://img.shields.io/badge/MCP-server-blue.svg)](https://modelcontextprotocol.io)

An **MCP server that generates MCP servers**. Give it an API definition (OpenAPI 3.0/3.1 or a
Postman collection) and it scaffolds a complete, runnable, _ownable_ TypeScript MCP server for that
API — so a service with no "MCP strategy" becomes usable and discoverable by AI models (Claude,
Cursor, Codex, …).

It is itself an MCP server: an agent connects to it and calls its tools to analyze a spec, generate
a server, or extend an existing one.

## Add to your AI stack

No install step. `npx` fetches and runs the latest published version — cross-platform, Node 20+.

### Claude Desktop / Claude Code

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows:
`%APPDATA%\Claude\`) or your `mcp.json`:

```json
{
  "mcpServers": {
    "api-translator": {
      "command": "npx",
      "args": ["-y", "mcp-api-translator"]
    }
  }
}
```

<details>
<summary><strong>Cursor</strong></summary>

Add to `~/.cursor/mcp.json` (or the project-scoped `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "api-translator": {
      "command": "npx",
      "args": ["-y", "mcp-api-translator"]
    }
  }
}
```

</details>

<details>
<summary><strong>Cline (VS Code)</strong></summary>

Open the Cline sidebar → MCP Servers → Configure → add:

```json
{
  "mcpServers": {
    "api-translator": {
      "command": "npx",
      "args": ["-y", "mcp-api-translator"],
      "disabled": false
    }
  }
}
```

</details>

<details>
<summary><strong>Continue.dev</strong></summary>

Add to `~/.continue/config.json` under `experimental.modelContextProtocolServers`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "mcp-api-translator"]
        }
      }
    ]
  }
}
```

</details>

<details>
<summary><strong>Docker (no Node required)</strong></summary>

```json
{
  "mcpServers": {
    "api-translator": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "ghcr.io/krishgok/mcp-api-translator:latest"]
    }
  }
}
```

To let the generator read specs from disk or write generated projects to a host path, mount the
directory: `-v ${PWD}:/workspace` and pass `/workspace/...` as `specPath` / `outputDir`.

</details>

MCP config is read at startup, so quit and reopen your client (Claude Desktop, Cursor, …) to pick
up the new server — its four tools should then appear. Then see [Usage](#usage).

## Why this exists (and an honest take on the space)

Turning an OpenAPI spec into MCP "tool stubs" is **not novel** — [FastMCP's `from_openapi`](https://gofastmcp.com/integrations/openapi),
[Speakeasy/Gram](https://www.speakeasy.com/blog/generate-mcp-from-openapi), and several
`openapi-mcp-generator` projects already do the mechanical part. A naive 1:1 endpoint→tool generator
has no real advantage.

So this project focuses on the parts those tools get wrong or skip, which is where the actual value
of "make my API usable by AI models" lives:

1. **Curation, not just generation.** A 200-endpoint API naively becomes 200 tools, which wrecks a
   model's tool-selection accuracy and blows out context. `analyze_spec` previews the tool list
   first, and every command supports `includeTags` / `methods` / `pathGlob` / `excludeOperations`
   filtering, with a warning when a server gets too large.
2. **Aggregation via append.** `extend_mcp_server` adds another API's tools to an existing generated
   project, so you can build **one** MCP server spanning GitHub + Stripe + your internal API.
3. **An artifact you own.** Output is a normal TypeScript project (not a hosted black box): readable
   per-tool files, env-based auth, a Dockerfile, and a `server.json` + client snippets for
   publishing to the [official MCP Registry](https://registry.modelcontextprotocol.io).

If you only need throwaway, in-memory exposure of one API and don't care about owning the code,
FastMCP's runtime mode may suit you better — that's a deliberate non-goal here (see Limitations).

## Tech stack & rationale

- **TypeScript on the official `@modelcontextprotocol/sdk`** — MCP's Tier-1 SDK; the most portable
  output target (runs on any Node host, `npx`-friendly for Claude/Cursor/Codex).
- **`@readme/openapi-parser`** for `$ref`-resolved OpenAPI 3.0/3.1 (+ best-effort Swagger 2.0);
  Postman v2.1 is parsed directly.
- **Raw JSON Schema for generated tool inputs.** OpenAPI 3.1 schemas _are_ JSON Schema 2020-12,
  which is exactly what an MCP tool's `inputSchema` expects — so there's no lossy zod round-trip.
- **String-builder templates, no template engine** — minimal deps, every emitter is snapshot-testable.

## The tools

| Tool                      | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `analyze_spec`            | Parse a spec and **preview** the tools that would be generated — no files written. |
| `generate_mcp_server`     | Generate a complete TS MCP-server project into `outputDir`.                        |
| `extend_mcp_server`       | Append another spec's tools to an existing generated project (idempotent).         |
| `list_supported_features` | Report supported formats, auth schemes, transports, and limits.                    |

All spec inputs accept inline text (`spec`) or a local path (`specPath`), JSON or YAML.

## Usage

You don't call the tools by hand — you ask your agent, and it drives them. A typical session:

**1. Preview** — see what a spec would become, without writing files:

> _"Analyze ./petstore.yaml and show me the proposed tools."_

```js
analyze_spec({ specPath: "./petstore.yaml" });
// → proposed tool list, auth scheme, and the env vars the server will need
```

**2. Curate** — big API? Narrow it. Every tool accepts the same filters:

> _"Only the GET endpoints under /pets."_

```js
analyze_spec({ specPath: "./petstore.yaml", methods: ["GET"], pathGlob: "/pets/**" });
// also: includeTags: ["pets"], excludeOperations: ["deletePet"]
```

**3. Generate** — same filters, plus an output directory:

> _"Generate the server into ./petstore-mcp."_

```js
generate_mcp_server({ specPath: "./petstore.yaml", outputDir: "./petstore-mcp" });
// options: language: "python", transport: "http", force: true
```

**4. Run it** — the output is a normal project:

```bash
cd petstore-mcp && npm install && npm run build
cp .env.example .env   # set API_BASE_URL + credentials (never embedded in code)
```

Register it with your client (paste-ready snippet in the generated `client-config.md`) and your
agent can call the API: `listPets`, `getPetById`, …

**5. Aggregate** (optional) — add more APIs to the same server:

> _"Extend ./petstore-mcp with ./github.yaml, just the issues tag."_

```js
extend_mcp_server({
  projectDir: "./petstore-mcp",
  specPath: "./github.yaml",
  includeTags: ["issues"],
});
// idempotent; hand-edited tool files are preserved
```

Aggregated APIs don't share credentials: each API also reads namespaced env vars
(`<NAMESPACE>_API_BASE_URL`, `<NAMESPACE>_API_KEY`, … — namespace derived from the API title)
before falling back to the bare ones. The extend summary and `.env.example` list the exact names.

Full walkthrough with sample outputs and troubleshooting:
[docs/usage-workflow.md](docs/usage-workflow.md).

## Two ways to use a spec: generate, or serve

- **Generate** ownable code (`generate_mcp_server`) when you want a project you can hand-edit,
  self-host, and own — in **TypeScript** (default) or **Python** (`language: "python"`).
- **Serve** a live runtime proxy when you just want an API exposed to an agent **now**, with no
  generated files to build or maintain:

  ```bash
  mcp-api-translator serve --spec ./api.yaml          # mount one API as live MCP tools
  mcp-api-translator serve --spec ./a.yaml --spec ./b.yaml --methods GET,POST   # aggregate several
  ```

  `serve` runs the same request plan and env-based auth the generator would emit, so behavior matches
  generated output exactly — it just skips the codegen step. See
  [docs/serve-api-proposal.md](docs/serve-api-proposal.md) for the design and
  [docs/market-analysis.md](docs/market-analysis.md) for why both models exist.

## Generated project layout

```
src/index.ts            # stdio entry (index.http.ts too if transport http/both)
src/server.ts           # registers tools (low-level Server + JSON-Schema inputs)
src/tools/<name>.ts     # one file per operation: schema + request plan
src/http/client.ts      # builds the request, fetch, error handling
src/auth.ts             # env-based credential injection
.env.example            # API_BASE_URL + any detected credentials
server.json             # MCP Registry manifest
client-config.md        # paste-ready Claude / Cursor / Codex config
.mcp-translator.json    # manifest that powers `extend_mcp_server`
tool-catalog.json       # optional (toolCatalog: true): name/summary/tags per tool for discovery layers
```

## Assumptions & limitations

- **Inputs:** OpenAPI 3.0/3.1 and Postman v2.1 (Swagger 2.0 best-effort). No GraphQL/gRPC yet.
- **Output languages:** TypeScript (default) and Python. Both support `generate` and
  `extend_mcp_server` (aggregating multiple APIs into one server). Python can be flavored
  with `pythonVariant: "fastmcp"` (FastMCP 2.x instead of the low-level SDK); both flavors
  serve the same raw JSON-Schema tool inputs.
- **Output quality tracks spec quality** — missing `operationId`s/descriptions yield weaker tool
  names and docs. Curation helps; it can't invent semantics.
- **Auth:** API key / bearer / basic / pre-obtained OAuth token, plus the **OAuth2
  client-credentials grant** and the **refresh-token grant** (exchange a pre-obtained refresh
  token; tokens fetched + cached), all read from env. **No interactive (authorization-code)
  consent flows** in v1.
- **Responses** are returned as JSON/text; no upstream streaming or automatic pagination.
- **Postman** parameter types are inferred from examples (Postman carries no formal schema).
- **Not a hosted service.** It runs locally/self-hosted: `generate` ownable code, or `serve` a live
  in-process proxy. (No managed cloud offering — see [docs/serve-api-proposal.md](docs/serve-api-proposal.md) roadmap.)

## Security & trust model

A spec is treated as **untrusted input**: spec-derived strings are escaped before they're embedded
in generated source, generated tool names are restricted to `[A-Za-z0-9_]`, and all file writes stay
under `outputDir`. Two things are still inherent to what a generated server _does_, so review the
output before pointing it at credentials:

- **The generated server calls whatever base URL the spec declares** (or `API_BASE_URL`) and injects
  your env-supplied credentials into those requests. Generating from a spec you don't trust, then
  running it with real secrets, can send those secrets to a host the spec chose. Set `API_BASE_URL`
  explicitly when in doubt.
- **Secrets are never embedded** in the generated project — `auth.ts` reads them from the environment
  at runtime and `.env.example` ships with empty values.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm test          # unit + integration (parsers, curation, emit, append)
npm run typecheck
npm run build
npm run e2e       # generate a sample project from the fixtures into build/e2e-out
```

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). All commits must be signed off
under the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`).

## License & Attribution

`mcp-api-translator` is **dual-licensed** — © 2026 krishgok. See [LICENSING.md](LICENSING.md) for
the full details.

- **Open source:** [GNU AGPL-3.0-or-later](LICENSE). If you run a modified version to provide a
  network service, the AGPL requires you to offer that version's complete source to its users.
- **Commercial:** a separate commercial license is available for embedding `mcp-api-translator` in
  proprietary or closed-source products/services without AGPL obligations —
  see [LICENSING.md](LICENSING.md).
- **Your generated output is yours.** Projects produced by running this tool are covered by a
  [generated-output exception](LICENSING.md#3-generated-output-exception) and are **not** subject to
  the AGPL — license them however you like.

Redistributions must retain [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). The licenses do **not**
grant the right to use the "mcp-api-translator" name to endorse or promote forked or derivative
works without prior written permission.
