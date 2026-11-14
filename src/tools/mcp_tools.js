// ── MCP Admin Tools ──────────────────────────────────────────────────────────
// The tools a *connected* MCP server exposes are registered directly into
// ToolRegistry by agent.js (as mcp__<server>__<toolname>) — you'll just see
// them in your normal tool list, no special handling needed to call them.
//
// This file is the small, fixed set of *meta* tools for managing those
// connections and reaching the other two MCP primitives (resources, prompts)
// that don't map cleanly onto individually-namespaced tools the way
// tools/list does:
//
//   mcp_list_servers    — status + tool/resource/prompt counts for every configured server
//   mcp_add_server      — write a new server into mcp_servers.json and connect it (human-gated)
//   mcp_remove_server   — disconnect + remove a server from config
//   mcp_reload          — reconnect everything fresh (e.g. after a human hand-edits the config file)
//   mcp_list_resources / mcp_read_resource  — the MCP "resources" primitive
//   mcp_list_prompts   / mcp_get_prompt     — the MCP "prompts" primitive

export const MCP_TOOLS = [

  // ── mcp_list_servers ─────────────────────────────────────────────────────
  {
    name: 'mcp_list_servers',
    declaration: {
      name: 'mcp_list_servers',
      description: 'List every configured MCP server, its connection status, and what it exposes (tools/resources/prompts).',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { mcp }) {
      if (!mcp) return 'MCP manager unavailable.';
      if (!mcp.servers.size) return 'No MCP servers configured. See mcp_servers.example.json, or use mcp_add_server.';
      return [...mcp.servers.entries()].map(([name, s]) => {
        if (s.status === 'connected') return `- ${name} [connected]: ${s.tools.length} tool(s), ${s.resources.length} resource(s), ${s.prompts.length} prompt(s)`;
        if (s.status === 'disabled')  return `- ${name} [disabled]`;
        return `- ${name} [FAILED]: ${s.error}`;
      }).join('\n');
    },
  },

  // ── mcp_add_server ───────────────────────────────────────────────────────
  {
    name: 'mcp_add_server',
    declaration: {
      name: 'mcp_add_server',
      description:
        'Add a new MCP server to mcp_servers.json and connect to it immediately. ' +
        'For a LOCAL server give command + args (+ optional env, cwd) — this spawns a real ' +
        'subprocess. For a REMOTE server give type ("http" or "sse") + url (+ optional headers). ' +
        'Use ${VAR_NAME} in any string field to reference an environment variable rather than ' +
        'hardcoding a secret. HARD RULE: this can execute an arbitrary local command or contact ' +
        'an arbitrary URL — never call it without the human explicitly approving the exact command/url ' +
        'you are about to write, shown to them in chat first.',
      parameters: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: 'Short identifier for the server, e.g. "filesystem".' },
          command: { type: 'string', description: 'Local stdio server: the executable to spawn, e.g. "npx".' },
          args:    { type: 'array', items: { type: 'string' }, description: 'Args for "command", e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path"].' },
          env:     { type: 'object', description: 'Extra env vars for the spawned process (merged with the current environment).' },
          type:    { type: 'string', enum: ['http', 'sse'], description: 'Remote server transport. Omit for local (command-based) servers.' },
          url:     { type: 'string', description: 'Remote server URL. Required if "type" is set.' },
          headers: { type: 'object', description: 'Extra HTTP headers for a remote server, e.g. { "Authorization": "Bearer ${MY_TOKEN}" }.' },
          human_approved: { type: 'boolean', description: 'Must be true — confirms the human explicitly approved this exact config in chat.' },
        },
        required: ['name', 'human_approved'],
      },
    },
    async execute({ name, command, args = [], env, type, url, headers, human_approved }, { mcp, refreshTools }) {
      if (!mcp) return 'MCP manager unavailable.';
      if (!human_approved) return 'Refused: human_approved must be true. Show the human the exact server config first and only call this after they say yes.';
      if (!command && !url) return 'Refused: provide either "command" (local) or "url" (remote).';

      const cfg = command
        ? { command, args, ...(env ? { env } : {}) }
        : { type: type || 'http', url, ...(headers ? { headers } : {}) };

      const server = await mcp.addServer(name, cfg);
      refreshTools?.();

      if (server.status !== 'connected') return `Wrote "${name}" to mcp_servers.json, but connection failed: ${server.error}`;
      return `Connected "${name}" — ${server.tools.length} tool(s) now available: ${server.tools.map(t => `mcp__${name}__${t.name}`).join(', ') || '(none)'}.`;
    },
  },

  // ── mcp_remove_server ────────────────────────────────────────────────────
  {
    name: 'mcp_remove_server',
    declaration: {
      name: 'mcp_remove_server',
      description: 'Disconnect an MCP server and remove it from mcp_servers.json.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Server name, as shown by mcp_list_servers.' } },
        required: ['name'],
      },
    },
    async execute({ name }, { mcp, refreshTools }) {
      if (!mcp) return 'MCP manager unavailable.';
      if (!mcp.servers.has(name)) return `No MCP server named "${name}".`;
      await mcp.removeServer(name);
      refreshTools?.();
      return `Removed "${name}".`;
    },
  },

  // ── mcp_reload ───────────────────────────────────────────────────────────
  {
    name: 'mcp_reload',
    declaration: {
      name: 'mcp_reload',
      description: 'Disconnect and reconnect every MCP server fresh from mcp_servers.json — use after a human hand-edits that file.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { mcp, plugins, refreshTools }) {
      if (!mcp) return 'MCP manager unavailable.';
      await mcp.reload(plugins?.getMcpServers() || {});
      refreshTools?.();
      const connected = [...mcp.servers.values()].filter(s => s.status === 'connected').length;
      const failed    = [...mcp.servers.values()].filter(s => s.status === 'error').length;
      return `Reloaded — ${connected} connected, ${failed} failed, ${mcp.servers.size - connected - failed} disabled.`;
    },
  },

  // ── mcp_list_resources ───────────────────────────────────────────────────
  {
    name: 'mcp_list_resources',
    declaration: {
      name: 'mcp_list_resources',
      description: 'List resources (files/data the server exposes for reading, not calling) offered by one connected MCP server.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'Server name, as shown by mcp_list_servers.' } },
        required: ['server'],
      },
    },
    async execute({ server }, { mcp }) {
      if (!mcp) return 'MCP manager unavailable.';
      try {
        const resources = await mcp.listResources(server);
        if (!resources.length) return `"${server}" exposes no resources.`;
        return resources.map(r => `- ${r.uri} — ${r.name || ''}${r.description ? `: ${r.description}` : ''}${r.mimeType ? ` (${r.mimeType})` : ''}`).join('\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  // ── mcp_read_resource ────────────────────────────────────────────────────
  {
    name: 'mcp_read_resource',
    declaration: {
      name: 'mcp_read_resource',
      description: 'Read one resource by URI from a connected MCP server (see mcp_list_resources for available URIs).',
      parameters: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Server name.' },
          uri:    { type: 'string', description: 'Resource URI, exactly as returned by mcp_list_resources.' },
        },
        required: ['server', 'uri'],
      },
    },
    async execute({ server, uri }, { mcp }) {
      if (!mcp) return 'MCP manager unavailable.';
      try {
        return await mcp.readResource(server, uri);
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  // ── mcp_list_prompts ─────────────────────────────────────────────────────
  {
    name: 'mcp_list_prompts',
    declaration: {
      name: 'mcp_list_prompts',
      description: 'List reusable prompt templates offered by one connected MCP server.',
      parameters: {
        type: 'object',
        properties: { server: { type: 'string', description: 'Server name, as shown by mcp_list_servers.' } },
        required: ['server'],
      },
    },
    async execute({ server }, { mcp }) {
      if (!mcp) return 'MCP manager unavailable.';
      try {
        const prompts = await mcp.listPrompts(server);
        if (!prompts.length) return `"${server}" exposes no prompts.`;
        return prompts.map(p => `- ${p.name}${p.description ? `: ${p.description}` : ''}${p.arguments?.length ? ` (args: ${p.arguments.map(a => a.name).join(', ')})` : ''}`).join('\n');
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  // ── mcp_get_prompt ───────────────────────────────────────────────────────
  {
    name: 'mcp_get_prompt',
    declaration: {
      name: 'mcp_get_prompt',
      description: 'Fetch and render one prompt template from a connected MCP server (see mcp_list_prompts for names/args).',
      parameters: {
        type: 'object',
        properties: {
          server:    { type: 'string', description: 'Server name.' },
          name:      { type: 'string', description: 'Prompt name, exactly as returned by mcp_list_prompts.' },
          arguments: { type: 'object', description: 'Arguments the prompt template expects, if any.' },
        },
        required: ['server', 'name'],
      },
    },
    async execute({ server, name, arguments: promptArgs = {} }, { mcp }) {
      if (!mcp) return 'MCP manager unavailable.';
      try {
        return await mcp.getPrompt(server, name, promptArgs);
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },
];

