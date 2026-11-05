#!/usr/bin/env node
// cli.mjs — entry point: `npx arakice-nhl-mcp` (stdio). Configuration: README.md.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.mjs';

try {
  await createServer().connect(new StdioServerTransport());
} catch (e) {
  console.error(`[arakice-nhl-mcp] ${e.message}`);
  process.exit(1);
}
