/** Entry point: run mcp-api-translator over stdio. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-api-translator running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
