// Smoke test for `serve` mode: launch the runtime proxy against a mock upstream, do a real MCP
// stdio handshake, list tools, call one, and assert the upstream received the proxied request with
// the env-injected credential. Exits non-zero on any failure so CI catches regressions.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const SPEC = `${root}/test/fixtures/petstore.openapi.yaml`;
const ENTRY = `${root}/dist/index.js`;

function fail(msg) {
  console.error(`serve-smoke FAILED: ${msg}`);
  process.exit(1);
}

// 1. Mock upstream that records the request.
let received = null;
const upstream = createServer((req, res) => {
  received = { method: req.method, url: req.url, apiKey: req.headers["x-api-key"] };
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: 42, name: "Fido" }));
});
await new Promise((r) => upstream.listen(0, r));
const port = upstream.address().port;

// 2. Launch serve mode pointed at the mock.
const child = spawn("node", [ENTRY, "serve", "--spec", SPEC], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, API_BASE_URL: `http://127.0.0.1:${port}`, API_KEY: "smoke-key" },
});
const timer = setTimeout(() => fail("timed out after 15s"), 15_000);

let buf = "";
const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});
child.on("exit", (code) => {
  if (code && code !== 0) fail(`server exited with code ${code}`);
});

let id = 1;
const send = (method, params) => {
  const i = id++;
  const p = new Promise((r) => waiters.set(i, r));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  return p;
};
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const init = await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "serve-smoke", version: "0" },
});
if (init.result?.serverInfo?.name !== "mcp-api-translator-proxy") {
  fail(`unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`);
}
notify("notifications/initialized", {});

const list = await send("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
if (names.join(",") !== "createPet,getPetById,listPets") {
  fail(`unexpected tools: ${names.join(",")}`);
}

const call = await send("tools/call", { name: "getPetById", arguments: { petId: 42 } });
if (call.result?.isError) fail(`tool call errored: ${JSON.stringify(call.result)}`);
if (!received || received.url !== "/pets/42")
  fail(`upstream path wrong: ${JSON.stringify(received)}`);
if (received.apiKey !== "smoke-key") fail(`auth header not injected: ${JSON.stringify(received)}`);

clearTimeout(timer);
upstream.close();
child.stdin.end();
child.kill();
console.log(`serve-smoke OK — proxied ${received.method} ${received.url} with injected credential`);
process.exit(0);
