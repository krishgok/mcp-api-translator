// End-to-end check for Python output: generate a Python project from the fixtures and py_compile
// every module so CI proves the emitted Python is syntactically valid (the analogue of `tsc` for
// the TypeScript output). Requires python3 on PATH.
import { fileURLToPath } from "node:url";
import { rm, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseSource, generateProject, appendToProject } from "../dist/lib.js";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const fixtures = `${root}/test/fixtures`;
const out = process.env.E2E_PY_OUT ?? `${root}/build/e2e-python-out`;

await rm(out, { recursive: true, force: true });

const petstore = await parseSource({ specPath: `${fixtures}/petstore.openapi.yaml` });
const gen = await generateProject(petstore, {
  outputDir: out,
  serverName: "e2e-py-mcp",
  language: "python",
});
console.log(`generated python: +${gen.toolsAdded} tools, ${gen.files.length} files`);

const echo = await parseSource({ specPath: `${fixtures}/echo.postman.json` });
const ext = await appendToProject(echo, { projectDir: out });
console.log(`extended python: +${ext.toolsAdded} tools, total ${ext.totalTools}`);

// Collect every generated .py file and compile it.
async function pyFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await pyFiles(full)));
    else if (e.name.endsWith(".py")) files.push(full);
  }
  return files;
}

const files = await pyFiles(out);
if (files.length === 0) throw new Error("no .py files were generated");
const res = spawnSync("python3", ["-m", "py_compile", ...files], { stdio: "inherit" });
if (res.status !== 0) {
  console.error("py_compile failed");
  process.exit(res.status ?? 1);
}
console.log(`py_compile OK for ${files.length} file(s)`);
console.log(`OUTPUT_DIR=${out}`);
