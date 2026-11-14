// ── Swarm Tools ──────────────────────────────────────────────────────────────
// Exposes SwarmManager (src/core/swarm.js) as a single callable tool. Context
// carries { swarm } — the shared SwarmManager instance — injected by the
// agent, same wiring pattern as { tasks } in task_tools.js / { mcp } in
// mcp_tools.js.

export const SWARM_TOOLS = [

  {
    name: 'spawn_subagent_swarm',
    declaration: {
      name: 'spawn_subagent_swarm',
      description:
        'Spawn several scoped, EPHEMERAL sub-agents that investigate different facets of one hard ' +
        'task IN PARALLEL — each with its own narrow toolset and its own isolated context window — ' +
        'then run a single arbitration pass that merges their findings and explicitly flags where ' +
        'they disagree, instead of just picking one sub-agent\'s answer. ' +
        'Use for genuinely multi-faceted work where several independent angles beat one sequential ' +
        'pass, e.g.: "audit this codebase" → security + performance + readability sub-agents at ' +
        'once (tools like read_file, list_directory, bash_execute, code_execute); "should we do X" ' +
        '→ cost + risk + timeline sub-agents at once (tools like web_search, vector_recall). ' +
        'Do NOT use this for simple or single-facet requests — the parallel calls plus the ' +
        'arbitration pass cost real time and tokens, so reserve it for problems that genuinely ' +
        'benefit from several independent perspectives run at once. ' +
        'Sub-agents can never spawn further swarms, add MCP servers, install plugins, or apply ' +
        'skill updates, no matter what tools you list for them — those stay exclusively with you.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The shared task/target every sub-agent investigates its own facet of — e.g. ' +
              '"the codebase in ./src", "whether to migrate our database to Postgres".',
          },
          agents: {
            type: 'array',
            description: '2-6 sub-agents to run in parallel, each scoped to one distinct facet.',
            items: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  description: 'Short label for this facet, e.g. "security", "performance", "readability", "cost".',
                },
                focus: {
                  type: 'string',
                  description: 'Specific instructions for exactly what this sub-agent should investigate. Keep it narrow — the whole point is that it does NOT try to cover everything.',
                },
                tools: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'Exact tool names this sub-agent is allowed to call — a subset of your own tool ' +
                    'list, chosen for this facet specifically (e.g. ["read_file","list_directory",' +
                    '"bash_execute"] for a codebase-facing facet, or ["web_search"] for a research ' +
                    'facet). Give only what this facet actually needs.',
                },
              },
              required: ['role', 'focus'],
            },
          },
          max_iterations: {
            type: 'integer',
            description: 'Optional cap on tool-call rounds per sub-agent (default 6). Raise only for facets that plausibly need deeper digging.',
          },
        },
        required: ['task', 'agents'],
      },
    },
    async execute({ task, agents, max_iterations }, context) {
      if (!context.swarm) return 'Swarm system unavailable.';
      try {
        return await context.swarm.run(task, agents, {
          maxIterations: max_iterations || undefined,
          // Sub-agents' tool calls get the SAME context a normal tool call
          // would (memory, vectorMemory, skills, ...) — only which TOOLS
          // they can reach is restricted, not what those tools can see.
          sharedContext: context,
        });
      } catch (err) {
        return `Error running swarm: ${err.message}`;
      }
    },
  },

];

