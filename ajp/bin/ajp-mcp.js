#!/usr/bin/env node
// Executable entry point for the AJP MCP server (stdio transport).
import { startStdioServer } from "../dist/mcp/server.js";

startStdioServer().catch((err) => {
  process.stderr.write(`ajp-mcp: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
