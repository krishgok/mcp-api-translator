// End-to-end check: generate a project from the bundled fixtures, then (separately) the
// CI/script step compiles the generated project to prove the output is valid TypeScript.
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import path from "node:path";
import { parseSource, generateProject, appendToProject } from "../dist/lib.js";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const fixtures = `${root}/test/fixtures`;
const out = process.env.E2E_OUT ?? `${root}/build/e2e-out`;

await rm(out, { recursive: true, force: true });

const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
const gen = await generateProject(petstore, {
  outputDir: out,
  serverName: "e2e-mcp",
  transport: "both",
});
console.log(`generated: +${gen.toolsAdded} tools`);

const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
const ext = await appendToProject(echo, { projectDir: out });
console.log(`appended: +${ext.toolsAdded} tools, total ${ext.totalTools}`);

console.log(`OUTPUT_DIR=${out}`);
