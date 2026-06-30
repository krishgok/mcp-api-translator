# Market Analysis — `mcp-api-translator`

_Researched early/mid 2026. Sources are linked inline; dated claims reflect what was public then._

This is an honest read of where this project sits in the market, including where it **doesn't**
have a defensible edge. It exists to keep the roadmap grounded in reality rather than optimism.

## TL;DR verdict

The **problem** (exposing existing REST APIs to AI agents, and taming tool-count bloat) is real and
growing. The **original wedge** (generate ownable TypeScript) is narrow and partly eroding: it
competes with funded incumbents above and is undercut by platform features below. The project's
best path is to also serve the **runtime-proxy** model the market is moving toward (now shipped — see
[serve-api-proposal.md](serve-api-proposal.md)) and to lean into **multi-API aggregation** for the
**long tail of internal/private APIs** that will never get a first-party MCP server.

## 1. The tailwind is real — MCP is not a fad

- Anthropic's Dec 2025 ecosystem update: **>10,000 active public MCP servers**, **97M+ monthly SDK
  downloads**, adoption across ChatGPT, Cursor, Gemini, Microsoft Copilot, and VS Code.
- Official registry ≈ **9,652 servers** (May 2026); company-operated servers grew **~873%**
  (425 → 4,133) in under a year; Stacklok's 2026 survey shows **41%** of software orgs running MCP
  in production.

Building in OpenAPI→MCP is betting on a growing market. ([adoption stats](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol),
[downloads](https://www.digitalapplied.com/blog/mcp-97-million-downloads-model-context-protocol-mainstream))

## 2. The competitive landscape is crowded and funded

| Player                       | Model                         | Output                         | Notes                                                                                                                                                   |
| ---------------------------- | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FastMCP** (`from_openapi`) | runtime mount + FastMCP Cloud | Python                         | "black box… not much visibility"; fastest if you won't maintain code                                                                                    |
| **Speakeasy**                | codegen                       | ownable **TS** (+ other langs) | MCP server in the SDK's `mcp-server/`, npm/npx-distributable, inspectable — **the closest competitor to this project's wedge**, and commercially backed |
| **Stainless**                | codegen                       | TS SDK subpackage              | MCP server ships beside the SDK as a separate npm package                                                                                               |
| **Gram** (Speakeasy)         | managed runtime proxy         | hosted                         | upload spec → instant server; **auto-syncs on spec change, no code changes**                                                                            |
| **Zuplo**                    | runtime gateway               | hosted                         | OpenAPI → remote MCP; **MCP Gateway** adds OAuth, credential brokering, **tool curation**, observability                                                |
| **Kong**                     | runtime gateway               | self/managed                   | AI Gateway + MCP autogenerate from REST (Gateway 3.12, late 2025)                                                                                       |
| **Postman**                  | generator                     | hosted/beta                    | MCP Generator (public API network) + Agent Mode (internal APIs)                                                                                         |

Leaders split by axis: **Speakeasy/Stainless** own "ownable codegen" (bundled with SDK gen people
already want); **Gram/Zuplo/Kong** own "zero-maintenance runtime gateway."
([generator comparison](https://www.speakeasy.com/blog/comparison-mcp-server-generators),
[Gram vs FastMCP](https://www.speakeasy.com/blog/gram-vs-fastmcp-cloud),
[FastMCP OpenAPI](https://gofastmcp.com/integrations/openapi),
[Zuplo MCP Gateway](https://zuplo.com/blog/introducing-zuplo-mcp-gateway),
[Kong](https://developer.konghq.com/mcp/autogenerate-mcp-tools/),
[Postman](https://www.postman.com/product/mcp-server/))

## 3. Codegen vs runtime proxy: momentum favors runtime for "expose an existing API"

Runtime proxies win on maintenance: Gram "auto-syncs" when the spec changes with no code edits.
Generated code is a static snapshot that **rots** as the API evolves — the burden lands on the user.
Ownable code still matters when you need to **hand-edit behavior**, but for "just expose my API to an
agent," runtime is the lower-friction default. This is why the project added a `serve` mode.

## 4. The curation pain is real — but being solved at a better layer

Tool-count bloat measurably degrades agents: the **RAG-MCP** work cited tool-selection accuracy
collapsing from **43% → ~14%** on bloated tool sets; GitHub's MCP server alone is ~**42,000 tokens**
of definitions. ([context bloat](https://agentmarketcap.ai/blog/2026/04/08/mcp-context-bloat-enterprise-scale-tool-definitions-agent-context-budget))

**But** the ecosystem moved to runtime fixes in early 2026:

- Anthropic's **Tool Search Tool** (GA Feb 2026): `defer_loading`, **~85% token reduction**, Opus 4.5
  tool accuracy **79.5% → 88.1%**. ([advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use))
- **Code execution with MCP**: load tools on demand, filter before the model sees data. ([code execution](https://www.anthropic.com/engineering/code-execution-with-mcp))
- Gateways (Zuplo) do server-side curation.

**Implication for this project:** static, generation-time filters are the _weakest_ form of the fix —
they force you to pick a `<40` subset up front. The durable angle is to produce a **clean, well-described
tool set that complements dynamic discovery**, not to position static filtering as the headline
feature.

## 5. The hardest pushback: first-party servers are eating the popular-API case

Through Q1–Q2 2026, GitHub, Stripe, Cloudflare, Atlassian, Linear, Slack, and Notion shipped
**official** MCP servers, now the default install; OpenAI tells users to prefer `mcp.stripe.com`
over third-party servers. Nobody will generate a Stripe MCP server from its OpenAPI spec when Stripe
ships a better, OAuth-secured one. ([Stripe MCP](https://docs.stripe.com/mcp),
[first-party servers](https://techsy.io/en/blog/best-mcp-servers-2026))

## What works / what doesn't

**Works**

- Targets a real, growing market and a real, measured pain.
- "Ownable code" resonates for teams that want to hand-edit and self-host.
- Multi-API aggregation is genuinely useful.
- Now offers both codegen **and** a runtime proxy (`serve`) — covers both adoption models.

**Doesn't (be honest)**

- The ownable-TS-codegen lane is occupied by funded incumbents (Speakeasy, Stainless) bundled with
  SDK gen.
- Static curation is being obsoleted by runtime Tool Search + gateway curation.
- First-party vendor servers remove the popular-API use case.
- TS-only output and env-only auth (no interactive OAuth) narrow it further vs. gateways.

## Where it can realistically win

1. **Long-tail internal/private APIs** that will never get a first-party MCP server — the clearest fit.
2. **Teams that want owned, hand-editable code** and accept the maintenance trade for control.
3. **Fast, zero-deploy exposure** of an internal API to an agent via `serve` (no codegen, no hosting
   account) — competes with Gram/Zuplo on _local/self-hosted_ rather than managed.
4. **Aggregating several internal APIs** into one coherent server.

It is unlikely to become a broad standard on the strength of static codegen alone. Treated as an
**internal/self-hosted tool that does both codegen and runtime proxy for private APIs**, with
aggregation as the differentiator, it has a defensible (if modest) niche.
