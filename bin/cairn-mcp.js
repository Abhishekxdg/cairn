#!/usr/bin/env node
// Executable entry point for the Cairn MCP server (stdio transport).
import { startStdioServer } from "../dist/mcp/server.js";

startStdioServer().catch((err) => {
  process.stderr.write(`cairn-mcp: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
