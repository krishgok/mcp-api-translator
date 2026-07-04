import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSource } from "../src/parsers/index.js";
import { generateProject, appendToProject } from "../src/emitters/project.js";
import { readManifest } from "../src/manifest.js";

const fixtures = path.dirname(fileURLToPath(import.meta.url)) + "/fixtures";
const read = (dir: string, rel: string) => readFile(path.join(dir, rel), "utf8");

describe("python generation", () => {
  let dir: string;
  const pkg = "swagger_petstore_mcp";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pygen-"));
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(model, { outputDir: dir, language: "python" });
  });

  it("writes a Python package with the expected modules", async () => {
    const top = await readdir(dir);
    expect(top).toContain("pyproject.toml");
    expect(top).toContain(pkg);
    const mods = await readdir(path.join(dir, pkg));
    expect(mods.sort()).toEqual([
      "__init__.py",
      "__main__.py",
      "auth.py",
      "config.py",
      "http_client.py",
      "server.py",
      "tools.json",
      "tools.py",
    ]);
  });

  it("records language: python in the manifest", async () => {
    const manifest = await readManifest(dir);
    expect(manifest?.language).toBe("python");
    expect(manifest?.tools.map((t) => t.name).sort()).toEqual([
      "createPet",
      "getPetById",
      "listPets",
    ]);
  });

  it("serializes tools (schema + plan) to tools.json", async () => {
    const tools = JSON.parse(await read(dir, `${pkg}/tools.json`));
    expect(Array.isArray(tools)).toBe(true);
    const getPet = tools.find((t: { name: string }) => t.name === "getPetById");
    expect(getPet.plan.pathTemplate).toBe("/pets/{petId}");
    expect(getPet.plan.pathParams).toEqual(["petId"]);
    expect(getPet.inputSchema.type).toBe("object");
  });

  it("uses the low-level MCP SDK and reads auth from the environment", async () => {
    const server = await read(dir, `${pkg}/server.py`);
    expect(server).toContain("from mcp.server.lowlevel import Server");
    const auth = await read(dir, `${pkg}/auth.py`);
    expect(auth).toContain('_read_env(ns, "API_KEY")');
    expect(auth).not.toContain("secret"); // no embedded credential values
  });
});

describe("python tool catalog", () => {
  it("writes tool-catalog.json for python projects too", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pygen-"));
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(model, { outputDir: dir, language: "python", toolCatalog: true });
    const catalog = JSON.parse(await read(dir, "tool-catalog.json"));
    expect(catalog.tools).toHaveLength(3);
    expect(catalog.tools[0].tags).toEqual(["pets"]);
  });
});

describe("python oauth client-credentials", () => {
  it("emits a _get_token helper reading the client id/secret", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pygen-"));
    const model = await parseSource({ specPath: `${fixtures}/oauth.openapi.yaml` });
    await generateProject(model, { outputDir: dir, serverName: "widgets", language: "python" });
    const auth = await read(dir, "widgets/auth.py");
    expect(auth).toContain("def _get_token(");
    expect(auth).toContain('_read_env(ns, "API_CLIENT_ID")');
    expect(auth).toContain("client_credentials");
    const env = await read(dir, ".env.example");
    expect(env).toContain("API_CLIENT_ID=");
    expect(env).toContain("API_CLIENT_SECRET=");
  });
});

describe("python oauth refresh-token grant", () => {
  it("emits _get_refresh_token with an API_TOKEN fallback", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pygen-"));
    const model = await parseSource({ specPath: `${fixtures}/oauth-refresh.openapi.yaml` });
    await generateProject(model, { outputDir: dir, serverName: "gadgets", language: "python" });
    const auth = await read(dir, "gadgets/auth.py");
    expect(auth).toContain("def _get_refresh_token(");
    expect(auth).toContain('"grant_type": "refresh_token"');
    expect(auth).toContain('_read_env(ns, "API_REFRESH_TOKEN")');
    expect(auth).toContain('_read_env(ns, "API_TOKEN")');
    expect(auth).not.toContain("def _get_token(");
    const env = await read(dir, ".env.example");
    expect(env).toContain("API_REFRESH_TOKEN=");
  });
});

describe("python extend", () => {
  it("appends another API into tools.json, merges auth, and is idempotent", async () => {
    const pdir = await mkdtemp(path.join(tmpdir(), "pyext-"));
    const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(petstore, { outputDir: pdir, serverName: "agg-py", language: "python" });

    const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
    const ext = await appendToProject(echo, { projectDir: pdir });
    expect(ext.toolsAdded).toBe(3);
    expect(ext.totalTools).toBe(6);

    // tool data merged into the single tools.json
    const tools = JSON.parse(await read(pdir, "agg_py/tools.json"));
    expect(tools).toHaveLength(6);

    // both APIs' auth schemes are now wired into the regenerated auth.py
    const auth = await read(pdir, "agg_py/auth.py");
    expect(auth).toContain('"apiKey" in security');
    expect(auth).toContain('"bearerAuth" in security');

    const manifest = await readManifest(pdir);
    expect(manifest?.language).toBe("python");
    expect(manifest?.sources).toHaveLength(2);
    expect(manifest?.securitySchemes.map((s) => s.name).sort()).toEqual(["apiKey", "bearerAuth"]);

    // re-appending the same spec adds nothing
    const again = await appendToProject(
      await parseSource({ specPath: `${fixtures}/echo.postman.json` }),
      { projectDir: pdir },
    );
    expect(again.toolsAdded).toBe(0);
    expect(again.totalTools).toBe(6);
  });
});

describe("python per-API env namespacing", () => {
  it("records sourceNamespace per tool and resolves namespaced env vars", async () => {
    const pdir = await mkdtemp(path.join(tmpdir(), "pyns-"));
    const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(petstore, { outputDir: pdir, serverName: "ns-py", language: "python" });
    const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
    await appendToProject(echo, { projectDir: pdir });

    const tools = JSON.parse(await read(pdir, "ns_py/tools.json"));
    const namespaces = new Set(tools.map((t: { sourceNamespace?: string }) => t.sourceNamespace));
    expect(namespaces).toEqual(new Set(["SWAGGER_PETSTORE", "ECHO_API"]));

    const config = await read(pdir, "ns_py/config.py");
    expect(config).toContain("def resolve_base_url(ns=None):");
    expect(config).toContain('"SWAGGER_PETSTORE": "https://petstore.example.com/v1"');

    const auth = await read(pdir, "ns_py/auth.py");
    expect(auth).toContain("def _read_env(ns, name):");
    expect(auth).toContain("def apply_auth(headers, query, security, ns=None):");

    const server = await read(pdir, "ns_py/server.py");
    expect(server).toContain('tool.get("sourceNamespace")');

    const env = await read(pdir, ".env.example");
    expect(env).toContain("SWAGGER_PETSTORE_API_KEY=");
    expect(env).toContain("ECHO_API_API_TOKEN=");
  });

  it("extends a legacy tools.json (no sourceNamespace) without breaking it", async () => {
    const pdir = await mkdtemp(path.join(tmpdir(), "pyleg-"));
    const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(petstore, { outputDir: pdir, serverName: "leg-py", language: "python" });

    // Simulate a pre-namespacing project: strip sourceNamespace from the records.
    const toolsPath = path.join(pdir, "leg_py/tools.json");
    const legacy = JSON.parse(await readFile(toolsPath, "utf8")).map(
      ({ sourceNamespace: _sourceNamespace, ...rest }: Record<string, unknown>) => rest,
    );
    await writeFile(toolsPath, JSON.stringify(legacy, null, 2) + "\n");

    const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
    const ext = await appendToProject(echo, { projectDir: pdir });
    expect(ext.toolsAdded).toBe(3);
    const merged = JSON.parse(await read(pdir, "leg_py/tools.json"));
    // Legacy records stay namespace-less (bare env vars); new ones carry their namespace.
    expect(
      merged.find((t: { name: string }) => t.name === "getPetById").sourceNamespace,
    ).toBeUndefined();
    expect(
      merged.filter((t: { sourceNamespace?: string }) => t.sourceNamespace === "ECHO_API"),
    ).toHaveLength(3);
  });
});
