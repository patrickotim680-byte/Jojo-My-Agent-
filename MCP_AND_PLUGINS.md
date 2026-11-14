# MCP & Plugins

Two related features, both real (no simulated/mocked behavior anywhere in
this implementation):

1. **MCP client** — Jojo can connect to any [Model Context Protocol](https://modelcontextprotocol.io)
   server, local or remote, using the official `@modelcontextprotocol/sdk`.
   This is the exact same protocol Claude Desktop and Claude Code speak —
   thousands of existing MCP servers (filesystem, GitHub, databases, Slack,
   browsers, etc.) work with Jojo unmodified.
2. **Plugins** — a local extension mechanism (`./plugins/`) for adding your
   own tools, REPL slash commands, or bundling an MCP server, without
   touching `src/` at all.

Both merge directly into the same tool-calling loop every other Jojo tool
uses (`src/core/agent.js` → `src/tools/registry.js`) — the model doesn't
treat them specially, it just sees more tools.

---

## MCP servers

### Quick start

1. Copy the example config: `cp mcp_servers.example.json mcp_servers.json`
2. Edit an entry, remove its `"disabled": true`, fill in any real path/token.
3. Run Jojo (or, if it's already running, type `mcp reload`).
4. Type `mcp` to confirm it connected and see what tools it added.

`mcp_servers.json` is gitignored (like `.env`) since it often contains
machine-specific paths or, via `${VAR_NAME}` interpolation, references to
secrets that live in your `.env` instead.

### Config shape

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/you/allow"]
    },
    "a-remote-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    }
  }
}
```

- **Local (stdio)** servers: `command` + `args` (+ optional `env`, `cwd`).
  Jojo spawns this as a child process and talks to it over stdin/stdout.
  On Windows, `npx`/`npm`/`yarn`/`pnpm` are automatically routed through
  `cmd /c` — the documented fix for a well-known Windows spawn issue with
  those shims. `uvx` (Python's tool runner) needs no such wrapping.
- **Remote** servers: `"type": "http"` (Streamable HTTP, recommended) or
  `"sse"` (legacy) + `url` (+ optional `headers`).
- Any string field supports `${VAR_NAME}` — it's replaced with
  `process.env.VAR_NAME` at connect time. Put the actual secret in `.env`,
  reference it by name in `mcp_servers.json`.
- `"disabled": true` on any entry skips it without deleting the config.

### What gets exposed

Every tool a connected server offers shows up in Jojo's tool list as
`mcp__<server>__<toolname>` — the same naming convention Claude Code uses.
Nothing extra to learn: the model calls it exactly like `bash_execute` or
any other built-in tool.

Resources and prompts (MCP's other two primitives) aren't auto-namespaced
per-item the way tools are, since a server can expose an open-ended set of
them. Instead, four fixed tools reach them for any connected server:
`mcp_list_resources`, `mcp_read_resource`, `mcp_list_prompts`, `mcp_get_prompt`.

### Managing servers

From the REPL: `mcp` (status) / `mcp reload` (reconnect fresh from disk).

Jojo can also manage this itself, mid-conversation:
- `mcp_list_servers`, `mcp_remove_server`, `mcp_reload`
- `mcp_add_server` — writes a new entry to `mcp_servers.json` and connects
  immediately. **Gated**: Jojo is instructed to only call this after you've
  explicitly approved the exact command/URL shown to you in chat.

### Security note

A connected MCP server runs with the same trust level as `bash_execute` —
Jojo's agentic loop calls tools automatically, with **no per-call human
confirmation gate**. Treat "which MCP servers are enabled" with the same
care you'd give any local script or CLI tool with full user-level
permissions: prefer official/first-party servers, read what tools a new
server exposes before enabling it, and be extra cautious with anything that
can write files, run commands, or make outbound requests on your behalf.

---

## Using Jojo as an MCP server (works with any IDE)

The section above is Jojo acting as an MCP *client* — connecting out to
other servers. Jojo can also run as an MCP *server* itself, so any
MCP-aware IDE or app (Cursor, VS Code, Windsurf, Zed, Claude Desktop, Claude
Code, etc.) can add Jojo as a tool provider. Every tool in `ALL_TOOLS`
(`src/tools/registry.js`) — bash, files, web, memory, learning, widgets,
multimodal, nmap/aircrack, Blender/Unreal, skills, build tools, plus
whatever Jojo's own MCP client and plugins currently have connected — is
exposed this way. It's the same tool list the REPL agent uses; nothing is
hidden or re-implemented for this path.

### Quick start

1. Make sure `.env` has `PUTER_AUTH_TOKEN` set (same as normal `npm start`).
2. Point your IDE's MCP config at `node` with `src/mcp-server.js` as the
   argument, using the **absolute path** to this project (IDEs commonly
   spawn MCP servers with an unrelated working directory, and
   `mcp-server.js` resolves `.env` relative to its own location specifically
   so this doesn't matter — but the path to the script itself still needs
   to be absolute).
3. Restart/reload the IDE's MCP connections. Jojo's tools should show up
   alongside any other MCP servers it has configured.

You can also run it directly to sanity-check it starts cleanly:
`npm run mcp-server` (or `node src/index.js --mcp`, if that's what ends up
configured instead) — it should print a `[jojo mcp-server] ready — N tools
exposed` line on stderr and then sit waiting for a client on stdin/stdout.

### Config snippets

**Claude Desktop / Claude Code** (`claude_desktop_config.json` or
`.mcp.json`):
```json
{
  "mcpServers": {
    "jojo": {
      "command": "node",
      "args": ["/absolute/path/to/JOJO 5/src/mcp-server.js"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`, project or global):
```json
{
  "mcpServers": {
    "jojo": {
      "command": "node",
      "args": ["/absolute/path/to/JOJO 5/src/mcp-server.js"]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json` — note the `servers` key, not
`mcpServers`):
```json
{
  "servers": {
    "jojo": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/JOJO 5/src/mcp-server.js"]
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`): same shape as the
Claude Desktop / Cursor snippet above.

**Zed** (`settings.json`, under `"context_servers"`):
```json
{
  "context_servers": {
    "jojo": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/JOJO 5/src/mcp-server.js"]
      }
    }
  }
}
```

### How it's implemented

| Piece | File | Role |
|---|---|---|
| MCP server logic | `src/core/mcp_server.js` | Builds a `JojoAgent`, wraps `ToolRegistry` into the low-level `@modelcontextprotocol/sdk` `Server`'s `ListTools`/`CallTool` handlers, connects a `StdioServerTransport` |
| Entry point | `src/mcp-server.js` | What an IDE actually spawns — resolves `.env` relative to itself (IDEs may use any cwd), then calls `runMcpServer()` |
| Flag fallback | `src/index.js --mcp` | Same server, reachable from the normal REPL entry point too, for IDE configs that already point at `index.js` |

No separate schema translation layer was needed: every tool in
`ALL_TOOLS` already declares plain JSON Schema for its parameters (see
`bash.js` for the shape), which is exactly what MCP's `inputSchema` wants —
so this is a thin protocol adapter around the existing registry, not a
parallel implementation.

### Security note (same as the client side, mirrored)

Once an IDE has Jojo connected as a server, **every** tool Jojo has is one
call away — including `bash_execute`, `nmap_scan`, and the `aircrack`
tools — with no per-call confirmation gate from Jojo's side (the IDE host
may or may not add its own). Only point IDE configs at this on machines/
workspaces you trust, the same way you'd vet any local MCP server before
enabling it.

---

## Plugins

See [`plugins/README.md`](plugins/README.md) for the full author-facing
guide and [`plugins/example-plugin/`](plugins/example-plugin/) for a real,
working reference (a `system_info` tool + a `/sysinfo` slash command, zero
dependencies).

Short version: drop a `.js` file or a folder into `./plugins/`, export
`tools` (and optionally `commands` and/or `mcpServers`), and Jojo picks it up
on next start (or `plugins reload`). A plugin's tools merge into the normal
tool list with no special prefix. Commands become `/name` shortcuts in the
REPL that route a canned prompt through the agent.

Manage plugins with the `plugins` / `plugins reload` REPL commands, or the
`plugin_list` / `plugin_install` / `plugin_enable` / `plugin_disable` /
`plugin_reload` tools (same human-approval gate as `mcp_add_server` applies
to `plugin_install`, since it runs whatever code the plugin contains).

---

## How this fits together internally

| Piece | File | Role |
|---|---|---|
| MCP client | `src/core/mcp.js` | Connects to servers, wraps their tools into Jojo's `{name, declaration, execute}` shape |
| MCP server | `src/core/mcp_server.js` + `src/mcp-server.js` | The reverse direction — exposes `ToolRegistry` itself over MCP so any IDE can use Jojo (see the section above) |
| MCP admin tools | `src/tools/mcp_tools.js` | `mcp_list_servers`, `mcp_add_server`, resources/prompts, etc. — static, always loaded |
| Plugin loader | `src/core/plugins.js` | Discovers/loads plugins from disk, tracks enabled state |
| Plugin admin tools | `src/tools/plugin_tools.js` | `plugin_list`, `plugin_install`, etc. — static, always loaded |
| Wiring | `src/tools/registry.js` | `registerMany(tools, source)` / `unregisterBySource(source)` — dynamic tools (source `'mcp'` or `'plugin'`) can never shadow a hand-authored (`'core'`) tool |
| Orchestration | `src/core/agent.js` | `init()` loads plugins → connects MCP (incl. anything plugins bundle) → `refreshDynamicTools()` syncs the registry; `shutdown()` closes MCP connections gracefully |

This mirrors the same "hand-authored is protected, dynamic content is
additive" philosophy `skills.js` already uses for Capability Synthesis — see
that file's comments if you're extending either system further.

