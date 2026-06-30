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

  it("refuses to extend a Python project (TS-only append)", async () => {
    const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
    await expect(appendToProject(echo, { projectDir: dir })).rejects.toThrow(
      /TypeScript projects only/,
    );
  });
});
