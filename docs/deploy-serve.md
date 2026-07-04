# Deploy `serve` in Docker (and beyond)

`serve` mounts one or more API specs as live MCP tools with no codegen, which makes it the
easiest thing to containerize: the published image already contains everything, and the only
inputs are your spec file(s) and env vars. This page is the recipe.

The image is built from the repo's [Dockerfile](../Dockerfile) and published as
`ghcr.io/krishgok/mcp-api-translator` (distroless Node; the container entrypoint is `node`, so
the command below passes the script and its args).

## Quickstart: stdio in Docker

Mount your spec directory read-only and pass credentials as env vars:

```bash
docker run --rm -i \
  -v "$PWD/specs:/specs:ro" \
  --env-file ./serve.env \
  ghcr.io/krishgok/mcp-api-translator:latest \
  dist/index.js serve --spec /specs/petstore.yaml
```

`serve.env` (never commit real values):

```dotenv
API_BASE_URL=https://petstore.example.com/v1
API_KEY=sk_live_xxxxxxxx
```

`-i` matters: MCP stdio talks over stdin/stdout. All `serve` flags work as usual — repeat
`--spec` to aggregate several APIs, add filters (`--methods GET,POST`, `--include-tag`,
`--path-glob`, `--exclude`), or `--catalog /specs/tool-catalog.json` to write the machine-readable
tool catalog into the mounted volume at startup.

### As an MCP client entry

Point Claude Desktop / Cursor / Codex at the container directly:

```json
{
  "mcpServers": {
    "petstore-proxy": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-v",
        "/abs/path/specs:/specs:ro",
        "--env-file",
        "/abs/path/serve.env",
        "ghcr.io/krishgok/mcp-api-translator:latest",
        "dist/index.js",
        "serve",
        "--spec",
        "/specs/petstore.yaml"
      ]
    }
  }
}
```

### Aggregating several APIs

Each mounted API reads namespaced env vars first (`<NAMESPACE>_API_BASE_URL`, `<NAMESPACE>_<VAR>`,
namespace derived from the API title) with the bare names as a shared fallback, so credentials
don't collide. `serve` prints each API's exact var names on startup:

```dotenv
SWAGGER_PETSTORE_API_BASE_URL=https://petstore.example.com/v1
SWAGGER_PETSTORE_API_KEY=sk_live_xxxxxxxx
BILLING_API_API_BASE_URL=https://billing.internal.example.com
BILLING_API_API_TOKEN=eyJhbGciOi...
```

### Reaching an upstream on the host

Inside a container, `localhost` is the container. To proxy an API running on the Docker host,
set `API_BASE_URL=http://host.docker.internal:8080` (on Linux, add
`--add-host=host.docker.internal:host-gateway`).

## HTTP transport: `serve --transport http`

Stdio is ideal for local clients, but a hosted deploy needs a port. `serve` also speaks
stateless **Streamable HTTP** at `/mcp` — the same transport the generated `index.http.ts` uses:

```bash
docker run --rm \
  -p 3000:3000 \
  -v "$PWD/specs:/specs:ro" \
  --env-file ./serve.env \
  -e MCP_ALLOWED_HOSTS=mcp.example.com \
  ghcr.io/krishgok/mcp-api-translator:latest \
  dist/index.js serve --spec /specs/petstore.yaml --transport http --port 3000
```

DNS-rebinding protection is on: only requests whose `Host` header matches the allowlist are
accepted. The default allows `localhost:<port>` / `127.0.0.1:<port>`; for any non-local
deployment set `MCP_ALLOWED_HOSTS` (comma-separated `host[:port]` values) to your public
hostname. `PORT` is honored when `--port` is omitted, which is what most PaaS runtimes inject.

### docker compose

```yaml
services:
  mcp-proxy:
    image: ghcr.io/krishgok/mcp-api-translator:latest
    command: ["dist/index.js", "serve", "--spec", "/specs/petstore.yaml", "--transport", "http"]
    ports:
      - "3000:3000"
    volumes:
      - ./specs:/specs:ro
    env_file: serve.env
    environment:
      PORT: "3000"
      MCP_ALLOWED_HOSTS: mcp.example.com
```

### Hosted platforms (fly.io, Render, Cloud Run, …)

Anything that runs a container and injects `PORT` works with the compose recipe above: bake or
mount your spec, set the credential env vars in the platform's secret store, and set
`MCP_ALLOWED_HOSTS` to the hostname the platform assigns. There is deliberately no managed
offering — the tool stays self-hostable and dependency-light.

> **Security notes.** The proxy calls whatever base URL the spec declares (or `API_BASE_URL`)
> and injects your env-supplied credentials into those requests — review specs you didn't write
> before pointing real secrets at them. The HTTP endpoint itself carries **no authentication**;
> anyone who can reach it can call your upstream APIs with your credentials. Keep it on a
> private network or put an authenticating reverse proxy in front of it.
