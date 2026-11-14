# Plugins

Drop a plugin here and Jojo will pick it up on startup — the same idea as
Claude Code plugins: a self-contained unit that can add new tools, new REPL
slash commands, and/or bundle its own MCP server(s), without touching core
source at all.

See `example-plugin/` for a real, working reference (a `system_info` tool +
a `/sysinfo` command, zero external dependencies) — copy it, rename it, and
edit freely.

## Formats

### Flat file
`plugins/my-plugin.js` — a single file, default-exporting the plugin object.
Good for a plugin that's just one or two small tools.

```js
export default {
  description: 'One-line description shown in `plugins` and the system prompt.',
  tools: [
    {
      name: 'my_tool',
      declaration: {
        name: 'my_tool',
        description: 'What this tool does and when to use it.',
        parameters: { type: 'object', properties: { /* JSON Schema */ } },
      },
      async execute(args, context) {
        // context carries the same things src/tools/*.js get: memory,
        // vectorMemory, tasks, genAI, mcp, plugins, etc. (see agent.js's
        // run() method for the full list).
        return 'result string';
      },
    },
  ],
};
```

### Folder (allows bundling scripts / assets / a whole MCP server)
`plugins/my-plugin/plugin.json` (metadata) + `plugins/my-plugin/index.js`
(tools/commands, optional). Nothing in `plugin.json` is required except what
you want to declare statically — a plugin that ONLY bundles an MCP server
can skip `index.js` entirely.

`plugin.json`:
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What this plugin does.",
  "main": "index.js"
}
```

`index.js` (optional — same shape as the flat-file format above, plus two
more fields folders can use):
```js
export default {
  tools: [ /* ... */ ],

  commands: [
    {
      name: 'my-command',
      description: 'Shown in `plugins`.',
      prompt: 'A canned instruction sent to Jojo when the user types /my-command.',
      // Use {args} in the prompt to splice in whatever the user typed after
      // the command name, e.g. "Summarize this: {args}". If you omit
      // {args}, whatever the user typed is appended on a new line instead.
    },
  ],

  mcpServers: {
    // Same shape as an entry in mcp_servers.json. Namespaced internally as
    // "<plugin-name>:<server-name>" so two plugins (or a plugin and the
    // human's own config) can never silently collide.
    'my-bundled-server': { command: 'npx', args: ['-y', 'some-mcp-server-package'] },
  },
};
```

## Managing plugins

From the REPL:
- `plugins` — list every loaded plugin, its tools/commands/bundled servers, enabled state
- `plugins reload` — rescan `./plugins` after hand-editing a file
- `/<command>` — run a plugin's slash command directly, e.g. `/sysinfo`

Jojo can also do all of this itself mid-conversation, via tools:
- `plugin_list`, `plugin_reload`, `plugin_enable`, `plugin_disable`
- `plugin_install` — clone a git repo or copy a local folder into `./plugins`
  and load it immediately. **This runs whatever code the plugin contains**
  the moment it registers tools, so Jojo is instructed to only do this after
  you've explicitly approved the exact source in chat — never speculatively.

Disabling a plugin (via `plugin_disable` or hand-editing `plugins.json`)
doesn't delete it — its folder/file stays on disk, just inactive, and can be
re-enabled any time with `plugin_enable`.

## Security note

A plugin's tools run with the same trust level as `bash_execute` — Jojo's
agentic loop calls tools automatically, with no per-call human confirmation
gate. Only install plugins you trust the source of, same as you would for
any script you'd otherwise copy-paste and run yourself.

## Notes
- `README.md` and dotfiles are ignored, same as `skills/README.md`.
- A plugin's tools can never overwrite a hand-authored (`src/tools/*.js`)
  tool of the same name — a collision is skipped, not merged, and reported
  back to whoever installed it.
- See `MCP_AND_PLUGINS.md` at the project root for how this fits together
  with the MCP client (`mcp_servers.json`, `src/core/mcp.js`).

