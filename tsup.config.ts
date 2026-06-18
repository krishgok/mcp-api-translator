import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/lib.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  sourcemap: true,
  // Keep the CLI runnable directly via the `bin` shebang.
  banner: { js: "#!/usr/bin/env node" },
});
