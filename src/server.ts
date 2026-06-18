/** Builds the mcp-api-translator MCP server and registers its tools. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { GENERATOR_NAME, GENERATOR_VERSION } from "./version.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: GENERATOR_NAME,
    version: GENERATOR_VERSION,
  });
  registerTools(server);
  return server;
}
