// ── MCP Server ───────────────────────────────────────────────────────────────
//
// The mirror image of mcp.js. mcp.js lets Jojo *consume* other MCP servers;
// this file turns Jojo itself *into* one — so any MCP-aware IDE or app
// (Cursor, VS Code, Windsurf, Zed, Claude Desktop, Claude Code, etc.) can add
// Jojo as a tool provider, the same way Jojo can add them. Together the two
// make Jojo bidirectional.
//
// Uses the low-level `Server` class (not the `McpServer` convenience wrapper)
// because Jojo's tool declarations are already plain JSON Schema — see
// bash.js for the shape (`{ name, declaration: { name, description,
// parameters }, execute }`). The low-level API takes `parameters` as-is for
// `inputSchema`, so no zod conversion is needed; ALL_TOOLS in registry.js
// stays the single source of truth for both the REPL agent and this server.
//
// Transport: stdio only, by design. This is how every MCP host launches a
// local server — it spawns `node src/mcp-server.js` as a child process and
// speaks JSON-RPC over stdin/stdout. See MCP_AND_PLUGINS.md for per-IDE
// config snippets (Claude Desktop, Cursor, VS Code, Windsurf, Zed).
//
// STDOUT DISCIPLINE: once the stdio transport is connected, stdout is
// reserved exclusively for MCP's JSON-RPC frames — any stray console.log
// (from Jojo itself or a dependency) would corrupt the stream and break the
// host's parser. agent.init() itself never writes to stdout (only the
// REPL's explicit `show()`-style commands do, and those aren't called
// here), but we still redirect console.log → stderr defensively for the
// lifetime of the server, since a plugin or MCP-client dependency loaded
// during init() is outside this file's control.
//
// SAME TRUST LEVEL AS THE CLIENT SIDE: everything in MCP_AND_PLUGINS.md's
// "Security note" applies in reverse here too. Once an IDE has Jojo
// connected as a server, every tool in ALL_TOOLS — including bash_execute,
// nmap, and aircrack — is one call away, with no per-call confirmation gate.
// Only connect Jojo to IDE hosts/workspaces you trust, the same way you'd
// vet any local MCP server before enabling it.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { JojoAgent } from './agent.js';

export async function runMcpServer() {
  // Redirect anything written via console.log to stderr instead, so it
  // can never land in the middle of a JSON-RPC frame on stdout. Restored
  // in the SIGINT/SIGTERM handlers purely for symmetry — the process exits
  // right after anyway.
  console.log = (...args) => console.error(...args);

  const agent = new JojoAgent();
  await agent.init();

  const server = new Server(
    { name: 'jojo', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Every tool Jojo has — hand-authored plus whatever's currently connected
  // via its own MCP client / plugins — shows up here. The list is captured
  // fresh on every ListTools call (not cached at startup) so it stays
  // correct if the human runs `mcp reload` / `plugins reload` from a
  // different Jojo REPL sharing the same machine mid-session... though in
  // practice this process owns its own agent instance, so this mostly just
  // guards against any future dynamic-registration path.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: agent.tools.getDeclarations().map(d => ({
      name:        d.name,
      description: d.description,
      inputSchema: d.parameters || { type: 'object', properties: {} },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await agent.tools.execute(name, args || {}, {
        memory:       agent.memory,
        vectorMemory: agent.vectorMemory,
        learning:     agent.learning,
        tasks:        agent.tasks,
        genAI:        agent.genAI,
        geminiModel:  agent.model,
        skills:       agent.skills,
        skillLedger:  agent.skillLedger,
        mcp:          agent.mcp,
        plugins:      agent.plugins,
        refreshTools: () => agent.refreshDynamicTools(),
      });
      return { content: [{ type: 'text', text: String(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[jojo mcp-server] ready — ${agent.tools.list().length} tools exposed`);

  const shutdown = async () => {
    await agent.shutdown().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

