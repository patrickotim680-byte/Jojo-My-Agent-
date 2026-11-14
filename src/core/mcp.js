// ── MCP Client Manager ──────────────────────────────────────────────────────
//
// Real MCP (Model Context Protocol) client. Connects Jojo to any MCP server —
// local (stdio, spawned as a child process) or remote (Streamable HTTP /
// legacy SSE) — the exact same protocol Claude Desktop, Claude Code, and
// every other MCP host speaks. Every tool a connected server exposes is
// wrapped into Jojo's own { name, declaration, execute } tool shape (see
// bash.js for that shape) and merged into ToolRegistry by agent.js, so the
// model calls an MCP tool exactly like any built-in one — no special-casing
// anywhere else in the codebase.
//
// Uses the official @modelcontextprotocol/sdk (v1.x). A v2 beta of this SDK
// exists (new package split: @modelcontextprotocol/server / .../client) but
// as of this writing v1.x remains the supported release for production, so
// that's what this file targets: import paths like
// '@modelcontextprotocol/sdk/client/index.js' and '.../client/stdio.js'.
//
// Config lives in mcp_servers.json at the project root — gitignored, same
// pattern as .env. Copy mcp_servers.example.json to get started; it ships
// with real (disabled-by-default) examples. Shape:
//
//   { "mcpServers": {
//       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] },
//       "github":     { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
//                        "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } },
//       "anything":   { ..., "disabled": true }
//   } }
//
// Tool naming: mcp__<server>__<tool> — the same convention Claude Code
// itself uses for MCP tools, so it reads familiarly in tool-call logs.
//
// SECURITY NOTE (also in MCP_AND_PLUGINS.md): a connected MCP server runs
// with the same trust level as bash_execute — Jojo's agentic loop calls
// tools automatically, with no per-call human confirmation gate. Only
// enable servers you trust, same as you would for anything the bash tool
// itself could run.

import fs from 'fs/promises';
import chalk from 'chalk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const CONFIG_PATH      = process.env.MCP_CONFIG_PATH || './mcp_servers.json';
const CONNECT_TIMEOUT  = parseInt(process.env.MCP_CONNECT_TIMEOUT_MS || '15000');

// ── helpers ──────────────────────────────────────────────────────────────────

/** ${VAR_NAME} → process.env.VAR_NAME. Leaves the placeholder in place (and
 *  warns once) if the variable isn't set, rather than silently sending the
 *  literal string "undefined" to a server or spawned process. */
function interpolate(str, warn) {
  if (typeof str !== 'string') return str;
  return str.replace(/\$\{([A-Z0-9_]+)\}/gi, (match, name) => {
    if (process.env[name] != null) return process.env[name];
    warn?.(name);
    return match;
  });
}

function interpolateMap(obj = {}, warn) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = interpolate(v, warn);
  return out;
}

// On Windows, npx/npm/yarn/pnpm are .cmd shims — spawning them directly
// (without a shell) fails unpredictably. The documented fix (see
// modelcontextprotocol.io's Windows guidance) is to route them through
// `cmd /c`. uvx (Python's tool runner) is a real .exe and is left alone.
function resolveForPlatform(command, args) {
  if (process.platform !== 'win32') return { command, args };
  const NODE_SHIMS = new Set(['npx', 'npm', 'yarn', 'pnpm']);
  if (NODE_SHIMS.has(command)) return { command: 'cmd', args: ['/c', command, ...args] };
  return { command, args };
}

/** Sanitize a proposed tool name into something safe for function-calling
 *  name fields (Gemini/OpenAI-style): alnum + _ - only, bounded length.
 *  Collisions (e.g. two servers exposing the same tool name after
 *  truncation) get a numeric suffix instead of silently overwriting. */
function safeName(raw, taken) {
  let name = String(raw).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (!taken.has(name)) return name;
  let i = 2;
  while (taken.has(`${name.slice(0, 60)}_${i}`)) i++;
  return `${name.slice(0, 60)}_${i}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Turn an MCP CallToolResult into the plain string Jojo's tool-calling loop
 *  expects back. Handles the content-block union, structuredContent, and
 *  the isError flag — see the MCP spec's Tools section. */
function resultToString(result) {
  if (!result) return '(no result)';
  const parts = [];
  for (const item of result.content || []) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'image') parts.push(`[image result: ${item.mimeType || 'unknown mime type'} — not viewable in this text channel]`);
    else if (item.type === 'audio') parts.push(`[audio result: ${item.mimeType || 'unknown mime type'} — not playable in this text channel]`);
    else if (item.type === 'resource' || item.type === 'resource_link') parts.push(`[resource: ${item.resource?.uri || item.uri || 'unknown uri'}]`);
    else parts.push(`[unrecognized content block: ${item.type}]`);
  }
  let text = parts.join('\n').trim();
  if (result.structuredContent) {
    text += (text ? '\n\n' : '') + 'Structured output:\n' + JSON.stringify(result.structuredContent, null, 2);
  }
  if (result.isError) text = `Tool reported an error: ${text || '(no message)'}`;
  return text || '(empty result)';
}

/** Turn an MCP ReadResourceResult into a display string. */
function resourceToString(result, maxChars = 5000) {
  if (!result?.contents?.length) return '(empty resource)';
  return result.contents.map(c => {
    if (typeof c.text === 'string') {
      const t = c.text.length > maxChars ? c.text.slice(0, maxChars) + `\n[truncated — ${maxChars}/${c.text.length} chars]` : c.text;
      return `${c.uri} (${c.mimeType || 'text'}):\n${t}`;
    }
    if (c.blob) return `${c.uri} (${c.mimeType || 'binary'}): [binary content, base64, ${c.blob.length} chars encoded — not rendered]`;
    return `${c.uri}: (unrecognized resource content)`;
  }).join('\n\n');
}

// ── McpManager ───────────────────────────────────────────────────────────────

export class McpManager {
  constructor() {
    this.servers = new Map(); // name → { status, client, transport, config, tools, resources, prompts, instructions, error }
  }

  /** Connect every server from mcp_servers.json plus any extraServers passed
   *  in (e.g. servers bundled by loaded plugins — see PluginManager.getMcpServers()). */
  async init(extraServers = {}) {
    const config = await this._loadConfig();
    const all = { ...config.mcpServers, ...extraServers };
    const names = Object.keys(all);
    if (!names.length) return;
    await Promise.all(names.map(name => this._connectOne(name, all[name])));
  }

  async _loadConfig() {
    try {
      const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
      const json = JSON.parse(raw);
      return { mcpServers: json.mcpServers || {} };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(chalk.red(`[mcp] Failed to parse ${CONFIG_PATH}: ${err.message}`));
      }
      return { mcpServers: {} };
    }
  }

  async _saveConfig(mcpServers) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2) + '\n', 'utf-8');
  }

  async _connectOne(name, cfg) {
    if (!cfg || cfg.disabled) {
      this.servers.set(name, { status: 'disabled', config: cfg, tools: [], resources: [], prompts: [] });
      return;
    }

    const warnEnv = (v) => process.stdout.write(chalk.yellow(`  [mcp:${name}] "\${${v}}" referenced but not set in the environment\n`));

    try {
      let transport;
      const isRemote = cfg.type === 'http' || cfg.type === 'sse' || (!!cfg.url && !cfg.command);

      if (isRemote) {
        const url = new URL(interpolate(cfg.url, warnEnv));
        const headers = cfg.headers ? interpolateMap(cfg.headers, warnEnv) : undefined;
        const opts = headers ? { requestInit: { headers } } : undefined;
        transport = cfg.type === 'sse'
          ? new SSEClientTransport(url, opts)
          : new StreamableHTTPClientTransport(url, opts);
      } else {
        if (!cfg.command) throw new Error('config needs either "command" (stdio) or "url"/"type" (remote)');
        const rawArgs = (cfg.args || []).map(a => interpolate(a, warnEnv));
        const { command, args } = resolveForPlatform(cfg.command, rawArgs);
        transport = new StdioClientTransport({
          command,
          args,
          cwd: cfg.cwd ? interpolate(cfg.cwd, warnEnv) : undefined,
          env: { ...process.env, ...interpolateMap(cfg.env || {}, warnEnv) },
          stderr: 'pipe',
        });
      }

      const client = new Client({ name: `jojo-${name}`, version: '1.0.0' });
      client.onerror = (err) => process.stdout.write(chalk.red(`  [mcp:${name}] transport error: ${err.message}\n`));

      await withTimeout(client.connect(transport), CONNECT_TIMEOUT, `connecting to MCP server "${name}"`);

      const [toolsRes, resourcesRes, promptsRes] = await Promise.all([
        client.listTools().catch(() => ({ tools: [] })),
        client.listResources().catch(() => ({ resources: [] })),
        client.listPrompts().catch(() => ({ prompts: [] })),
      ]);

      let instructions = null;
      try { instructions = client.getInstructions?.() || null; } catch { /* older SDK — not fatal */ }

      this.servers.set(name, {
        status: 'connected', client, transport, config: cfg,
        tools:     toolsRes.tools || [],
        resources: resourcesRes.resources || [],
        prompts:   promptsRes.prompts || [],
        instructions,
      });

      process.stdout.write(chalk.green(`  ✓ [mcp] "${name}" connected`) + chalk.gray(` — ${toolsRes.tools?.length || 0} tool(s), ${resourcesRes.resources?.length || 0} resource(s), ${promptsRes.prompts?.length || 0} prompt(s)\n`));
    } catch (err) {
      this.servers.set(name, { status: 'error', error: err.message, config: cfg, tools: [], resources: [], prompts: [] });
      process.stdout.write(chalk.red(`  ✗ [mcp] "${name}" failed to connect: ${err.message}\n`));
    }
  }

  /** Disconnect everything and reconnect fresh from mcp_servers.json (+ any
   *  extraServers, e.g. after a plugin reload changed what's bundled). */
  async reload(extraServers = {}) {
    await this.disconnectAll();
    this.servers.clear();
    await this.init(extraServers);
  }

  async disconnectAll() {
    await Promise.allSettled(
      [...this.servers.values()].filter(s => s.client).map(s => s.client.close())
    );
  }

  /** Write a new server into mcp_servers.json and connect it immediately.
   *  Caller (mcp_tools.js) is responsible for gating this behind explicit
   *  human approval — connecting can mean spawning an arbitrary local
   *  process or making requests to an arbitrary URL. */
  async addServer(name, cfg) {
    const current = await this._loadConfig();
    current.mcpServers[name] = cfg;
    await this._saveConfig(current.mcpServers);
    await this._connectOne(name, cfg);
    return this.servers.get(name);
  }

  async removeServer(name) {
    const s = this.servers.get(name);
    if (s?.client) await s.client.close().catch(() => {});
    this.servers.delete(name);
    const current = await this._loadConfig();
    delete current.mcpServers[name];
    await this._saveConfig(current.mcpServers);
  }

  /** Flattened, Jojo-shaped tool list across every connected server. */
  getTools() {
    const manager = this;
    const out = [];
    const taken = new Set();
    for (const [serverName, s] of this.servers.entries()) {
      if (s.status !== 'connected') continue;
      for (const t of s.tools) {
        const name = safeName(`mcp__${serverName}__${t.name}`, taken);
        taken.add(name);
        out.push({
          name,
          declaration: {
            name,
            description: `[MCP server: ${serverName}] ${t.description || t.name}`.slice(0, 1024),
            parameters: (t.inputSchema && t.inputSchema.type) ? t.inputSchema : { type: 'object', properties: {} },
          },
          async execute(args) {
            const server = manager.servers.get(serverName);
            if (!server || server.status !== 'connected') return `Error: MCP server "${serverName}" is not connected.`;
            try {
              const result = await server.client.callTool({ name: t.name, arguments: args || {} });
              return resultToString(result);
            } catch (err) {
              return `Error calling MCP tool "${t.name}" on server "${serverName}": ${err.message}`;
            }
          },
        });
      }
    }
    return out;
  }

  // ── Resources & Prompts (called via the generic tools in mcp_tools.js —
  //    unlike tools, these aren't auto-namespaced per-item since a server
  //    can expose an unbounded/dynamic set of them via resource templates) ──

  async listResources(serverName) {
    const s = this.servers.get(serverName);
    if (!s || s.status !== 'connected') throw new Error(`MCP server "${serverName}" is not connected.`);
    return s.resources;
  }

  async readResource(serverName, uri) {
    const s = this.servers.get(serverName);
    if (!s || s.status !== 'connected') throw new Error(`MCP server "${serverName}" is not connected.`);
    const result = await s.client.readResource({ uri });
    return resourceToString(result);
  }

  async listPrompts(serverName) {
    const s = this.servers.get(serverName);
    if (!s || s.status !== 'connected') throw new Error(`MCP server "${serverName}" is not connected.`);
    return s.prompts;
  }

  async getPrompt(serverName, promptName, args = {}) {
    const s = this.servers.get(serverName);
    if (!s || s.status !== 'connected') throw new Error(`MCP server "${serverName}" is not connected.`);
    const result = await s.client.getPrompt({ name: promptName, arguments: args });
    return (result.messages || [])
      .map(m => `[${m.role}] ${m.content?.text ?? JSON.stringify(m.content)}`)
      .join('\n');
  }

  // ── Context for the system prompt (mirrors SkillsSystem.getContext()) ────

  getContext() {
    const entries = [...this.servers.entries()];
    if (!entries.length) return '(no MCP servers configured — see mcp_servers.example.json, or use mcp_add_server)';
    return entries.map(([name, s]) => {
      if (s.status === 'disabled') return `- ${name}: disabled (mcp_servers.json)`;
      if (s.status === 'error')    return `- ${name}: FAILED to connect — ${s.error}`;
      const toolNames = s.tools.map(t => `mcp__${name}__${t.name}`).join(', ') || '(no tools)';
      const extra = [];
      if (s.resources?.length) extra.push(`${s.resources.length} resource(s) via mcp_list_resources/mcp_read_resource`);
      if (s.prompts?.length)   extra.push(`${s.prompts.length} prompt(s) via mcp_list_prompts/mcp_get_prompt`);
      const extraText = extra.length ? `\n  Also exposes: ${extra.join('; ')}` : '';
      const instr = s.instructions ? `\n  Server instructions: ${s.instructions}` : '';
      return `- ${name} — tools: ${toolNames}${extraText}${instr}`;
    }).join('\n');
  }

  list() {
    console.log(chalk.cyan('\n🔌  MCP Servers:\n'));
    if (!this.servers.size) {
      console.log(chalk.gray('  (none configured — copy mcp_servers.example.json to mcp_servers.json, or ask Jojo to add one)\n'));
      return;
    }
    for (const [name, s] of this.servers.entries()) {
      if (s.status === 'connected') {
        console.log(
          chalk.white(`  · ${name}`) + chalk.green('  [connected]') +
          chalk.gray(`  ${s.tools.length} tool(s), ${s.resources.length} resource(s), ${s.prompts.length} prompt(s)`)
        );
        s.tools.forEach(t => console.log(chalk.gray(`      - mcp__${name}__${t.name}`)));
      } else if (s.status === 'disabled') {
        console.log(chalk.gray(`  · ${name}  [disabled]`));
      } else {
        console.log(chalk.white(`  · ${name}`) + chalk.red('  [failed]') + chalk.gray(`  ${s.error}`));
      }
    }
    console.log('');
  }
}

