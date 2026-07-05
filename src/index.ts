/**
 * Entry point.
 *
 * Default (no args): run the mcp-api-translator meta-server over stdio (the 4 generator tools).
 * `serve` subcommand: run a runtime proxy that mounts spec(s) as live tools — no codegen.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { runServe } from "./runtime/cli.js";
import { log } from "./runtime/logger.js";

async function runMeta(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("mcp-api-translator running on stdio");
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "serve") {
    await runServe(rest);
  } else {
    await runMeta();
  }
}

main().catch((err) => {
  log.error("fatal", { error: err });
  process.exit(1);
});
