import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSource } from "../src/parsers/index.js";
import { generateProject, appendToProject } from "../src/emitters/project.js";
import { readManifest, writeManifest, MANIFEST_VERSION } from "../src/manifest.js";

const fixtures = path.dirname(fileURLToPath(import.meta.url)) + "/fixtures";

async function read(dir: string, rel: string): Promise<string> {
  return readFile(path.join(dir, rel), "utf8");
}

describe("project generation", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mcpgen-"));
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(model, { outputDir: dir, serverName: "petstore-mcp" });
  });

  it("writes the expected project files", async () => {
    const files = await readdir(dir);
    expect(files).toContain("package.json");
    expect(files).toContain(".mcp-translator.json");
    expect(files).toContain("server.json");
    const tools = await readdir(path.join(dir, "src", "tools"));
    expect(tools.sort()).toEqual(["createPet.ts", "getPetById.ts", "index.ts", "listPets.ts"]);
  });

  it("emits a JSON-Schema input and a request plan per tool", async () => {
    const getPet = await read(dir, "src/tools/getPetById.ts");
    expect(getPet).toContain('"pathTemplate": "/pets/{petId}"');
    expect(getPet).toContain('"pathParams": [\n    "petId"\n  ]');
    expect(getPet).toContain('"type": "object"');
  });

  it("injects detected auth from env, never embeds secrets", async () => {
    const auth = await read(dir, "src/auth.ts");
    expect(auth).toContain('security.includes("apiKey")');
    expect(auth).toContain('process.env["API_KEY"]');
    const envExample = await read(dir, ".env.example");
    expect(envExample).toContain("API_KEY=");
    expect(envExample).toContain("API_BASE_URL=https://petstore.example.com/v1");
  });

  it("records every tool in the manifest", async () => {
    const manifest = await readManifest(dir);
    expect(manifest?.tools.map((t) => t.name).sort()).toEqual([
      "createPet",
      "getPetById",
      "listPets",
    ]);
  });

  it("stamps the manifest with the current schema version", async () => {
    const manifest = await readManifest(dir);
    expect(manifest?.manifestVersion).toBe(MANIFEST_VERSION);
  });
});

describe("manifest schema version", () => {
  it("refuses to append to a manifest written by a newer format", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpgen-"));
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(model, { outputDir: dir });

    const manifest = await readManifest(dir);
    await writeManifest(dir, { ...manifest!, manifestVersion: MANIFEST_VERSION + 1 });

    await expect(appendToProject(model, { projectDir: dir })).rejects.toThrow(/newer than/);
  });
});

describe("append", () => {
  it("is idempotent and aggregates multiple APIs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpgen-"));
    const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(petstore, { outputDir: dir, serverName: "agg-mcp" });

    // Re-appending the same spec adds nothing.
    const again = await appendToProject(
      await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` }),
      { projectDir: dir },
    );
    expect(again.toolsAdded).toBe(0);

    // Appending a different API aggregates its tools.
    const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
    const result = await appendToProject(echo, { projectDir: dir });
    expect(result.toolsAdded).toBe(3);
    expect(result.totalTools).toBe(6);

    const manifest = await readManifest(dir);
    expect(manifest?.sources.length).toBe(3);
    // both auth schemes now present
    expect(manifest?.securitySchemes.map((s) => s.name).sort()).toEqual(["apiKey", "bearerAuth"]);
  });
});

describe("guards", () => {
  it("refuses to regenerate over an existing project without force", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mcpgen-"));
    const model = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
    await generateProject(model, { outputDir: dir });
    await expect(generateProject(model, { outputDir: dir })).rejects.toThrow(/already a generated/);
  });
});

describe("hardening", () => {
  it("does not let a spec-derived scheme name break out of a generated comment", async () => {
    // A hostile security-scheme key containing a newline + code payload.
    const payload = "globalThis.PWNED = true;";
    const spec = {
      openapi: "3.0.0",
      info: { title: "Evil API", version: "1.0.0" },
      servers: [{ url: "https://evil.example.com" }],
      paths: {
        "/ping": { get: { operationId: "ping", responses: { "200": { description: "ok" } } } },
      },
      components: {
        securitySchemes: {
          [`evil\n  ${payload}\n  //`]: { type: "apiKey", in: "header", name: "X-API-Key" },
        },
      },
    };
    const dir = await mkdtemp(path.join(tmpdir(), "mcpgen-"));
    const model = await parseSource({ spec: JSON.stringify(spec), format: "openapi" });
    await generateProject(model, { outputDir: dir });
    const auth = await read(dir, "src/auth.ts");
    // The escaped name may appear inside a string literal/comment, but a real newline must never
    // break the payload out onto its own line as an executable statement.
    const brokeOut = auth.split("\n").filter((line) => line.trim().startsWith("globalThis.PWNED"));
    expect(brokeOut).toEqual([]);
  });

  it("treats an undeclared {token} in the path as a required string input", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "Tokens API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        // widgetId appears in the path but is NOT declared as a parameter.
        "/widgets/{widgetId}": {
          get: { operationId: "getWidget", responses: { "200": { description: "ok" } } },
        },
      },
    };
    const dir = await mkdtemp(path.join(tmpdir(), "mcpgen-"));
    const model = await parseSource({ spec: JSON.stringify(spec), format: "openapi" });
    await generateProject(model, { outputDir: dir });
    const tool = await read(dir, "src/tools/getWidget.ts");
    expect(tool).toContain('"pathParams": [\n    "widgetId"\n  ]');
    expect(tool).toContain('"widgetId"');
    expect(tool).toContain('"required"');
  });
});
