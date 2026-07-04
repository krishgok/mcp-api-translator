// Smoke test for `serve --transport http`: launch the proxy against a mock upstream, speak MCP
// over Streamable HTTP with the official SDK client, list tools, call one, and assert the
// upstream received the proxied request with the env-injected credential.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const SPEC = `${root}/test/fixtures/petstore.openapi.yaml`;
const ENTRY = `${root}/dist/index.js`;
const PORT = 3123;

function fail(msg) {
  console.error(`serve-http-smoke FAILED: ${msg}`);
  process.exit(1);
}
setTimeout(() => fail("timed out after 20s"), 20_000).unref();

// 1. Mock upstream that records the request.
let received = null;
const upstream = createServer((req, res) => {
  received = { method: req.method, url: req.url, apiKey: req.headers["x-api-key"] };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: 42, name: "Fido" }));
});
await new Promise((r) => upstream.listen(0, r));
const upstreamPort = upstream.address().port;

// 2. Launch serve mode over HTTP pointed at the mock.
const child = spawn(
  "node",
  [ENTRY, "serve", "--spec", SPEC, "--transport", "http", "--port", String(PORT)],
  {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, API_BASE_URL: `http://127.0.0.1:${upstreamPort}`, API_KEY: "smoke-key" },
  },
);
child.on("exit", (code) => {
  if (code && code !== 0) fail(`server exited with code ${code}`);
});
await new Promise((resolve) => {
  child.stderr.on("data", (d) => {
    if (String(d).includes("/mcp")) resolve();
  });
});

// 3. Drive it with the SDK's Streamable HTTP client.
const client = new Client({ name: "serve-http-smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
if (names.join(",") !== "createPet,getPetById,listPets") {
  fail(`unexpected tools: ${names.join(",")}`);
}

const call = await client.callTool({ name: "getPetById", arguments: { petId: 42 } });
if (call.isError) fail(`tool call errored: ${JSON.stringify(call)}`);
if (!received || received.url !== "/pets/42")
  fail(`upstream path wrong: ${JSON.stringify(received)}`);
if (received.apiKey !== "smoke-key") fail(`auth header not injected: ${JSON.stringify(received)}`);

await client.close();
upstream.close();
child.kill();
console.log(
  `serve-http-smoke OK — proxied ${received.method} ${received.url} over Streamable HTTP`,
);
process.exit(0);
