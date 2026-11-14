#!/usr/bin/env node
// ── MCP Server entry point ─────────────────────────────────────────────────
//
// This is the file an IDE's MCP config points `command`/`args` at, e.g.:
//   { "command": "node", "args": ["/absolute/path/to/JOJO 5/src/mcp-server.js"] }
//
// IDEs spawn this as a subprocess and may use any working directory — so,
// unlike index.js (always run manually from the project root via `npm
// start`), .env is resolved relative to *this file's own location* rather
// than process.cwd(). That's the one thing that differs from the normal
// REPL startup path; everything else (JojoAgent, ToolRegistry, MCP client,
// plugins) is identical to `npm start` — see core/mcp_server.js for the
// actual server logic.

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { runMcpServer } = await import('./core/mcp_server.js');

runMcpServer().catch(err => {
  console.error('[jojo mcp-server] fatal:', err);
  process.exit(1);
});

