import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
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
    expect(auth).toContain('os.environ.get("API_KEY")');
    expect(auth).not.toContain("secret"); // no embedded credential values
  });
});

describe("python oauth client-credentials", () => {
  it("emits a _get_token helper reading the client id/secret", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pygen-"));
    const model = await parseSource({ specPath: `${fixtures}/oauth.openapi.yaml` });
    await generateProject(model, { outputDir: dir, serverName: "widgets", language: "python" });
    const auth = await read(dir, "widgets/auth.py");
    expect(auth).toContain("def _get_token(");
    expect(auth).toContain('os.environ.get("API_CLIENT_ID")');
    expect(auth).toContain("client_credentials");
    const env = await read(dir, ".env.example");
    expect(env).toContain("API_CLIENT_ID=");
    expect(env).toContain("API_CLIENT_SECRET=");
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
