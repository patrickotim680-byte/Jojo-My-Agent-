// ── World Model Tools ────────────────────────────────────────────────────────
// Explicit, model-callable controls over WorldModel (src/core/world_model.js).
// Context carries { worldModel } — the shared WorldModel instance — injected
// by the agent, same wiring pattern as { tasks } in task_tools.js.

export const WORLD_TOOLS = [

  {
    name: 'world_watch_add',
    declaration: {
      name: 'world_watch_add',
      description:
        'Start watching something for changes on an INDEPENDENT BACKGROUND SCHEDULE — a file, a ' +
        'directory (shallow listing), a shell command\'s output (e.g. a CI status check, a health' +
        '-check curl, `git status`), a URL, or an MCP resource. Jojo re-checks it periodically even ' +
        'when nobody is talking to it, narrates a detected change directly to the terminal the moment ' +
        'it happens, and also surfaces it in the next reply so it isn\'t missed. Use this whenever the ' +
        'user asks to be told about, kept up to date on, or alerted to something changing — "let me ' +
        'know if this file changes", "watch the build for me", "tell me if this API starts erroring". ' +
        'For a "command" watch over something like a test suite or CI status inside a real project, pass ' +
        'heal_project_dir to opt this watch into the self-healing loop: on drift, Jojo automatically spawns ' +
        'a diagnosis swarm, tests any candidate fix in an isolated sandbox, and — only if it verifies clean — ' +
        'surfaces it as a pending fix for apply_verified_fix, never touching the real tree on its own.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['file', 'directory', 'command', 'url', 'mcp_resource'],
            description: 'What kind of thing to watch.',
          },
          target: {
            type: 'string',
            description:
              'file/directory path, shell command, URL, or for mcp_resource: "<server_name>::<resource_uri>".',
          },
          label: { type: 'string', description: 'Short human-readable name for this watch (optional — defaults to target).' },
          interval_seconds: {
            type: 'integer',
            description: 'How often to re-check, in seconds (default 60). Use longer intervals for expensive checks like commands or URLs.',
          },
          heal_project_dir: {
            type: 'string',
            description:
              'OPTIONAL — opts this watch into the self-healing loop. The real project directory this watch ' +
              'is monitoring (e.g. a "command" watch running `npm test` inside it). On drift, a diagnosis ' +
              'swarm investigates and any candidate fix is verified in an isolated sandbox copy of this ' +
              'directory before ever being surfaced. Omit for a plain notify-only watch.',
          },
          heal_stack: {
            type: 'string',
            description: 'Stack key for heal_project_dir\'s verification pipeline (react-vite, nextjs, node-express, python-fastapi, static, or "auto" to detect). Only used if heal_project_dir is set.',
          },
          notify_voice: {
            type: 'boolean',
            description:
              'OPTIONAL — if true AND a voice session is currently active when this watch drifts, speak a ' +
              'one-line summary out loud instead of only narrating it to the terminal / surfacing it in the ' +
              'next reply. Use for things worth an ambient spoken ping (e.g. "let me know out loud when the ' +
              'build finishes"). Has no effect outside an active voice session.',
          },
        },
        required: ['kind', 'target'],
      },
    },
    async execute({ kind, target, label, interval_seconds, heal_project_dir, heal_stack, notify_voice }, { worldModel }) {
      if (!worldModel) return 'World model unavailable.';
      try {
        const w = await worldModel.addWatch({
          kind, target, label,
          intervalMs: interval_seconds ? interval_seconds * 1000 : undefined,
          heal: heal_project_dir ? { projectDir: heal_project_dir, stack: heal_stack } : undefined,
          notifyVoice: !!notify_voice,
        });
        return `Now watching [${w.id}] "${w.label}" (${w.kind}) every ${Math.round(w.intervalMs / 1000)}s` +
          `${w.heal ? ` — self-healing enabled against ${w.heal.projectDir}` : ''}` +
          `${w.notifyVoice ? ' — will speak a ping on drift if voice mode is active' : ''}.`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'world_watch_remove',
    declaration: {
      name: 'world_watch_remove',
      description: 'Stop watching something previously added with world_watch_add. Use world_watch_list to get ids.',
      parameters: {
        type: 'object',
        properties: { watch_id: { type: 'string', description: 'The id returned by world_watch_add / world_watch_list.' } },
        required: ['watch_id'],
      },
    },
    async execute({ watch_id }, { worldModel }) {
      if (!worldModel) return 'World model unavailable.';
      const ok = await worldModel.removeWatch(watch_id);
      return ok ? `Stopped watching [${watch_id}].` : `No watch found with id "${watch_id}".`;
    },
  },

  {
    name: 'world_watch_list',
    declaration: {
      name: 'world_watch_list',
      description: 'List everything currently being watched, with kind, target, schedule, and when it was last checked/last changed.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { worldModel }) {
      if (!worldModel) return 'World model unavailable.';
      const all = worldModel.listWatches();
      if (!all.length) return 'Nothing is being watched yet. Use world_watch_add to start.';
      return all.map(w =>
        `[${w.id}] "${w.label}" (${w.kind}: ${w.target}) — every ${Math.round(w.intervalMs / 1000)}s` +
        `${w.lastCheckedAt ? `, last checked ${w.lastCheckedAt}` : ', not checked yet'}` +
        `${w.lastChangedAt ? `, last changed ${w.lastChangedAt}` : ''}` +
        `${w.lastError ? ` — ⚠ last check errored: ${w.lastError}` : ''}` +
        `${w.heal?.enabled ? ` — 🔧 self-healing enabled (${w.heal.projectDir})` : ''}`
      ).join('\n');
    },
  },

  {
    name: 'world_watch_check_now',
    declaration: {
      name: 'world_watch_check_now',
      description:
        'Force an immediate check of one watched item right now, bypassing its schedule — use when ' +
        'the user wants a fresh check this instant rather than waiting for the next scheduled tick.',
      parameters: {
        type: 'object',
        properties: { watch_id: { type: 'string', description: 'The id to check now.' } },
        required: ['watch_id'],
      },
    },
    async execute({ watch_id }, { worldModel }) {
      if (!worldModel) return 'World model unavailable.';
      try {
        const w = await worldModel.checkNow(watch_id);
        if (w.lastError) return `Checked [${w.id}] "${w.label}" — error: ${w.lastError}`;
        const changedNow = w.lastChangedAt === w.lastCheckedAt;
        return `Checked [${w.id}] "${w.label}" — ${changedNow ? 'CHANGED since last check' : 'no change'}.`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'world_events_list',
    declaration: {
      name: 'world_events_list',
      description:
        'List recent drift events (detected changes/errors) across all watches, most recent first. ' +
        'Use to review history beyond what\'s auto-surfaced in your context each turn.',
      parameters: {
        type: 'object',
        properties: {
          limit:       { type: 'integer', description: 'Max events to return (default 20).' },
          unseen_only: { type: 'boolean', description: 'If true, only events not yet surfaced this session (default false).' },
        },
      },
    },
    async execute({ limit, unseen_only }, { worldModel }) {
      if (!worldModel) return 'World model unavailable.';
      let events = worldModel.events.slice().reverse();
      if (unseen_only) events = events.filter(e => !e.seen);
      events = events.slice(0, limit || 20);
      if (!events.length) return 'No events recorded yet.';
      return events
        .map(e => `[${e.timestamp}] ${e.type === 'error' ? '⚠' : '🆕'} "${e.label}" — ${e.summary.split('\n')[0]}`)
        .join('\n');
    },
  },

];

