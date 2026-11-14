// ── Plugin Admin Tools ───────────────────────────────────────────────────────
// A plugin's own tools are merged directly into your normal tool list by
// agent.js — no prefix, no special handling, just call them. This file is
// the fixed set of *meta* tools for managing plugins themselves:
//
//   plugin_list      — every loaded plugin, its tools/commands, enabled state
//   plugin_install   — git-clone or copy a plugin into ./plugins (human-gated)
//   plugin_enable / plugin_disable — toggle without deleting
//   plugin_reload    — rescan ./plugins (e.g. after a human hand-edits a plugin)

export const PLUGIN_TOOLS = [

  // ── plugin_list ───────────────────────────────────────────────────────────
  {
    name: 'plugin_list',
    declaration: {
      name: 'plugin_list',
      description: 'List every loaded plugin: version, description, tools, slash commands, bundled MCP servers, and enabled/disabled state.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { plugins }) {
      if (!plugins) return 'Plugin manager unavailable.';
      if (!plugins.plugins.size) return 'No plugins loaded. Drop one into ./plugins/, or use plugin_install.';
      return [...plugins.plugins.entries()].map(([name, p]) => {
        if (p.error) return `- ${name}: FAILED to load — ${p.error}`;
        const status = p.enabled ? 'enabled' : 'disabled';
        const tools = p.tools.map(t => t.name).join(', ') || 'none';
        const cmds = p.commands.map(c => `/${c.name}`).join(', ') || 'none';
        const mcp = Object.keys(p.mcpServers).join(', ') || 'none';
        return `- ${name} v${p.version} [${status}] — ${p.description}\n  tools: ${tools}\n  commands: ${cmds}\n  bundled mcp servers: ${mcp}`;
      }).join('\n');
    },
  },

  // ── plugin_install ────────────────────────────────────────────────────────
  {
    name: 'plugin_install',
    declaration: {
      name: 'plugin_install',
      description:
        'Install a plugin into ./plugins — clones a git URL, or copies a local directory. ' +
        'The plugin is loaded immediately after install. HARD RULE: this runs whatever code the ' +
        'plugin contains the moment it registers tools — never call it without the human explicitly ' +
        'approving the exact source shown to them in chat first.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Git URL (https:// or git@) or local directory path.' },
          name:   { type: 'string', description: 'Optional folder name under ./plugins — derived from source if omitted.' },
          human_approved: { type: 'boolean', description: 'Must be true — confirms the human explicitly approved installing from this exact source.' },
        },
        required: ['source', 'human_approved'],
      },
    },
    async execute({ source, name, human_approved }, { plugins, mcp, refreshTools }) {
      if (!plugins) return 'Plugin manager unavailable.';
      if (!human_approved) return 'Refused: human_approved must be true. Show the human the exact source first and only call this after they say yes.';

      let result;
      try {
        result = await plugins.install({ source, name });
      } catch (err) {
        return `Install failed: ${err.message}`;
      }
      if (!result.ok) return `Installed plugins/${result.name}, but it could not be loaded: ${result.error}`;

      if (mcp) await mcp.reload(plugins.getMcpServers());
      refreshTools?.();

      return `Installed "${result.name}" — tools: ${result.tools.join(', ') || 'none'}; commands: ${result.commands.map(c => `/${c}`).join(', ') || 'none'}.`;
    },
  },

  // ── plugin_enable ─────────────────────────────────────────────────────────
  {
    name: 'plugin_enable',
    declaration: {
      name: 'plugin_enable',
      description: 'Enable a previously-disabled plugin.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Plugin name, as shown by plugin_list.' } },
        required: ['name'],
      },
    },
    async execute({ name }, { plugins, mcp, refreshTools }) {
      if (!plugins) return 'Plugin manager unavailable.';
      const p = await plugins.enable(name);
      if (!p) return `No plugin named "${name}".`;
      if (mcp) await mcp.reload(plugins.getMcpServers());
      refreshTools?.();
      return `Enabled "${name}" — ${p.tools.length} tool(s), ${p.commands.length} command(s) now active.`;
    },
  },

  // ── plugin_disable ────────────────────────────────────────────────────────
  {
    name: 'plugin_disable',
    declaration: {
      name: 'plugin_disable',
      description: 'Disable a plugin without deleting it (its tools/commands/bundled MCP servers stop being available).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Plugin name, as shown by plugin_list.' } },
        required: ['name'],
      },
    },
    async execute({ name }, { plugins, mcp, refreshTools }) {
      if (!plugins) return 'Plugin manager unavailable.';
      const p = await plugins.disable(name);
      if (!p) return `No plugin named "${name}".`;
      if (mcp) await mcp.reload(plugins.getMcpServers());
      refreshTools?.();
      return `Disabled "${name}".`;
    },
  },

  // ── plugin_reload ─────────────────────────────────────────────────────────
  {
    name: 'plugin_reload',
    declaration: {
      name: 'plugin_reload',
      description: 'Rescan ./plugins from disk — use after a human hand-edits a plugin file or adds one outside plugin_install.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { plugins, mcp, refreshTools }) {
      if (!plugins) return 'Plugin manager unavailable.';
      await plugins.reload();
      if (mcp) await mcp.reload(plugins.getMcpServers());
      refreshTools?.();
      return `Reloaded — ${plugins.plugins.size} plugin(s) found, ${[...plugins.plugins.values()].filter(p => p.enabled && !p.error).length} enabled and active.`;
    },
  },
];

