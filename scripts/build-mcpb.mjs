// Build MCPB bundles (https://github.com/modelcontextprotocol/mcpb) of the meta-server for one-click
// installs (Claude Desktop) and for Smithery, which only accepts stdio servers as .mcpb bundles.
// Requires `npm run build` first. Writes to build/mcpb/:
//
// - mcp-api-translator-<version>.mcpb           standard bundle; manifest passes `mcpb validate`
// - mcp-api-translator-<version>-smithery.mcpb  same files, but each manifest tool also carries its
//   inputSchema. Smithery's publish copies manifest.tools verbatim into its server card and rejects
//   tools without an inputSchema, while the MCPB manifest schema rejects that key — so one file can't
//   satisfy both, and `mcpb pack` refuses the Smithery manifest. We pack the valid bundle and swap
//   only manifest.json in the archive.
//
// The server is installed from `npm pack` output with production deps only, so the bundle holds
// exactly what npm users get. Tools come from the staged server's own tools/list (no hand-kept
// copy to drift), and the finished bundle is unpacked and smoke-tested before the script exits 0.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { packExtension, unpackExtension } from "@anthropic-ai/mcpb";
import { unzipSync, zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "build", "mcpb");
const STAGE = path.join(OUT, "stage");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const pkg = readJson(path.join(root, "package.json"));
const registry = readJson(path.join(root, "server.json"));
const ENTRY_REL = `server/node_modules/${pkg.name}/dist/index.js`;

function fail(msg) {
  console.error(`build-mcpb FAILED: ${msg}`);
  process.exit(1);
}

function npm(args, cwd) {
  // Under `npm run`, npm_execpath is npm's JS entry: run it with this Node directly. That avoids a
  // shell (npm.cmd on Windows needs one), so paths with spaces are passed through intact.
  const cli = process.env.npm_execpath;
  const r = cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd, stdio: "inherit" })
    : spawnSync("npm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) fail(`npm ${args.join(" ")} exited ${r.status}`);
}

/** Start the server at `entry` over stdio, run `steps` against it, then stop it. */
async function withServer(entry, steps) {
  const child = spawn("node", [entry], { stdio: ["pipe", "pipe", "ignore"] });
  const timer = setTimeout(() => fail(`${entry} timed out after 30s`), 30_000);
  const waiters = new Map();
  let buf = "";
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
    }
  });
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, (msg) =>
        msg.error ? fail(`${method}: ${msg.error.message}`) : resolve(msg.result),
      );
      send({ jsonrpc: "2.0", id, method, params });
    });
  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "build-mcpb", version: pkg.version },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return await steps({ init, request });
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

// 1. Stage: the npm tarball, installed with production deps only.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(STAGE, "server"), { recursive: true });
npm(["pack", "--silent", "--pack-destination", OUT], root);
const tarball = readdirSync(OUT).find((f) => f.endsWith(".tgz"));
if (!tarball) fail("npm pack produced no tarball");
writeFileSync(path.join(STAGE, "server", "package.json"), '{ "private": true }\n');
npm(
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-save", path.join(OUT, tarball)],
  path.join(STAGE, "server"),
);
rmSync(path.join(STAGE, "server", "package.json"));
rmSync(path.join(STAGE, "server", "package-lock.json"), { force: true });
// The AGPL/NOTICE terms must travel with every redistribution.
for (const f of ["LICENSE", "NOTICE", "LICENSING.md"]) {
  cpSync(path.join(root, f), path.join(STAGE, f));
}

// 2. Manifest, with tools read from the staged server itself.
const tools = await withServer(path.join(STAGE, ENTRY_REL), async ({ request }) => {
  return (await request("tools/list", {})).tools;
});
const manifest = {
  manifest_version: "0.3",
  name: pkg.name,
  display_name: registry.title,
  version: pkg.version,
  description: registry.description,
  long_description:
    "Point it at an OpenAPI (3.0/3.1, Swagger 2.0) spec or a Postman collection to preview, " +
    "generate, or extend a runnable MCP server project (TypeScript or Python) that exposes the " +
    "API's operations as tools. Runs locally: generated projects are written to your machine, " +
    "and credentials are read from environment variables at runtime, never embedded.",
  author: { name: pkg.author, url: "https://github.com/krishgok" },
  repository: { type: "git", url: pkg.repository.url.replace(/^git\+/, "") },
  homepage: pkg.homepage,
  documentation: `${registry.repository.url}/blob/main/docs/usage-workflow.md`,
  support: pkg.bugs.url,
  license: pkg.license,
  keywords: ["openapi", "swagger", "postman", "api", "codegen", "mcp"],
  server: {
    type: "node",
    entry_point: ENTRY_REL,
    mcp_config: { command: "node", args: [`\${__dirname}/${ENTRY_REL}`] },
  },
  tools: tools.map(({ name, description }) => ({ name, description })),
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: pkg.engines.node.replace(/^>=(\d+)$/, ">=$1.0.0") },
  },
};
writeFileSync(path.join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// 3. Standard bundle (packExtension validates the manifest and applies the default .mcpbignore).
const bundle = path.join(OUT, `${pkg.name}-${pkg.version}.mcpb`);
if (!(await packExtension({ extensionPath: STAGE, outputPath: bundle, silent: true }))) {
  fail("mcpb pack rejected the bundle (see errors above)");
}

// 4. Smithery bundle: identical archive, manifest tools extended with their input schemas.
const smitheryManifest = {
  ...manifest,
  tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    ...(title ? { title } : {}),
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
  })),
};
const files = unzipSync(readFileSync(bundle));
files["manifest.json"] = new TextEncoder().encode(JSON.stringify(smitheryManifest, null, 2) + "\n");
const smitheryBundle = bundle.replace(/\.mcpb$/, "-smithery.mcpb");
writeFileSync(smitheryBundle, zipSync(files, { level: 9 }));

// 5. Smoke-test both archives as a client would run them: unpack, start, list, call.
for (const file of [bundle, smitheryBundle]) {
  const dir = path.join(OUT, "smoke", path.basename(file, ".mcpb"));
  if (!(await unpackExtension({ mcpbPath: file, outputDir: dir, silent: true }))) {
    fail(`could not unpack ${file}`);
  }
  await withServer(path.join(dir, ENTRY_REL), async ({ init, request }) => {
    if (init.serverInfo.version !== pkg.version) {
      fail(`${file}: server reports ${init.serverInfo.version}, expected ${pkg.version}`);
    }
    const listed = (await request("tools/list", {})).tools.map((t) => t.name).join(",");
    const expected = tools.map((t) => t.name).join(",");
    if (listed !== expected) fail(`${file}: tools ${listed} != ${expected}`);
    const res = await request("tools/call", { name: "list_supported_features", arguments: {} });
    if (res.isError) fail(`${file}: list_supported_features returned an error`);
  });
  const shipped = readJson(path.join(dir, "manifest.json"));
  if (file === smitheryBundle && !shipped.tools.every((t) => typeof t.inputSchema === "object")) {
    fail(`${file}: a tool is missing its inputSchema`);
  }
}

rmSync(STAGE, { recursive: true, force: true });
rmSync(path.join(OUT, "smoke"), { recursive: true, force: true });
rmSync(path.join(OUT, tarball));
console.log(
  `build-mcpb OK: ${path.relative(root, bundle)}, ${path.relative(root, smitheryBundle)}`,
);
