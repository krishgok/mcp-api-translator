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

// Also emit an OAuth client-credentials project so CI compiles the async-auth path.
const oauthOut = `${out}-oauth`;
await rm(oauthOut, { recursive: true, force: true });
const oauth = await parseSource({ specPath: `${fixtures}/oauth.openapi.yaml` });
await generateProject(oauth, { outputDir: oauthOut, serverName: "e2e-oauth-mcp" });
console.log(`generated oauth project at ${oauthOut}`);

// And an OAuth refresh-token-grant project so CI compiles that auth path too.
const refreshOut = `${out}-oauth-refresh`;
await rm(refreshOut, { recursive: true, force: true });
const refresh = await parseSource({ specPath: `${fixtures}/oauth-refresh.openapi.yaml` });
await generateProject(refresh, { outputDir: refreshOut, serverName: "e2e-oauth-refresh-mcp" });
console.log(`generated oauth-refresh project at ${refreshOut}`);

console.log(`OUTPUT_DIR=${out}`);
