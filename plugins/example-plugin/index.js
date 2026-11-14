// plugins/example-plugin/index.js
//
// Reference plugin for Jojo. Copy this folder, rename it, and edit freely —
// this is the exact shape PluginManager (src/core/plugins.js) expects:
//
//   export default {
//     name, version, description,   // optional here if already in plugin.json;
//                                    // whichever this file exports wins on conflict
//     tools:      [ ... ],          // same { name, declaration, execute } shape
//                                    // every file in src/tools/*.js uses
//     commands:   [ ... ],          // REPL slash commands: /name args…
//     mcpServers: { ... },          // optional — MCP servers this plugin wants connected
//   };
//
// No build step and no special imports required — this file is loaded with
// a plain dynamic import(), so anything valid in src/tools/*.js (Node
// built-ins, npm packages already in node_modules) is valid here too.

import os from 'os';

export default {
  description: 'Reference plugin — system_info tool + /sysinfo command.',

  tools: [
    {
      name: 'system_info',
      declaration: {
        name: 'system_info',
        description: 'Get real info about the machine Jojo is running on: OS, CPU, memory, uptime, hostname, Node version.',
        parameters: { type: 'object', properties: {} },
      },
      async execute() {
        const totalMem = os.totalmem();
        const freeMem  = os.freemem();
        const cpus     = os.cpus();
        return [
          `Host: ${os.hostname()}`,
          `Platform: ${os.platform()} ${os.release()} (${os.arch()})`,
          `CPU: ${cpus[0]?.model || 'unknown'} × ${cpus.length} core(s)`,
          `Memory: ${(freeMem / 1e9).toFixed(1)}GB free / ${(totalMem / 1e9).toFixed(1)}GB total`,
          `Uptime: ${(os.uptime() / 3600).toFixed(1)} hour(s)`,
          `Node: ${process.version}`,
        ].join('\n');
      },
    },
  ],

  commands: [
    {
      name: 'sysinfo',
      description: 'Quick system_info summary, no typing required.',
      prompt: 'Use the system_info tool and give me a one-paragraph summary of this machine.',
    },
  ],

  // mcpServers: {},  // ← uncomment + fill in if this plugin should bring its own MCP server(s)
};

