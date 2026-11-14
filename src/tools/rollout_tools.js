// ── Rollout Sandbox Tools ────────────────────────────────────────────────────
// Exposes RolloutSandbox (src/core/rollout_sandbox.js) as callable tools.
// Context carries { rollout } — the shared RolloutSandbox instance — injected
// by the agent, same wiring pattern as { healer } in heal_tools.js / { deploy }
// in deploy_tools.js. simulate_rollout is given the WHOLE shared context (not
// just { rollout }) because its adapters reach context.deploy / context.
// worldModel / context.browser themselves — same reason spawn_subagent_swarm
// forwards the whole context as sharedContext rather than just { swarm }.

export const ROLLOUT_TOOLS = [

  {
    name: 'simulate_rollout',
    declaration: {
      name: 'simulate_rollout',
      description:
        'Before committing a consequential action for real, ACTUALLY RUN IT inside a throwaway fork first — ' +
        'not another round of text reasoning about what might happen. Generalizes the exact pattern healer.js ' +
        'already uses for self-heal fixes (copy → real sandboxed install/build/test → only then decide) into a ' +
        'first-class layer over any risky call: a multi-file rewrite, a deploy, a new background watch, or an ' +
        'outbound browser action. Give 1-4 candidates to try genuinely different approaches in parallel — every ' +
        'fork runs for real, concurrently, and (for 2+ successful candidates) a scoring pass ranks the ACTUAL ' +
        'outcomes against each other, not the plans. Use this instead of just describing what you expect to ' +
        'happen whenever there is real uncertainty about whether an approach will actually work, or whether one ' +
        'of several approaches is genuinely better — not for routine, obviously-safe edits.\n\n' +
        'Four action_kind values, each with its own candidate fields:\n' +
        '  - project_action: copies project_dir into a throwaway temp dir, applies candidate files there (if ' +
        'any), and runs the real install/build/test pipeline (or a custom command) inside a Docker sandbox — ' +
        'the real project_dir is never touched during simulation.\n' +
        '  - deploy_preview: runs a REAL, disposable preview deploy (throwaway URL) via deploy.js\'s own ' +
        'prepareDeployment(). Committing still funnels into deploy.js\'s unmodified production gate — this ' +
        'never bypasses apply_deployment. fly.io has no free preview (see deploy.js) and is reported as such, ' +
        'not treated as a successful trial.\n' +
        '  - world_watch: runs the exact real check (file stat / dir listing / command / URL fetch / MCP ' +
        'resource read) a live watch would run, once, before ever registering the recurring schedule.\n' +
        '  - browser_action: forks an ISOLATED browser session carrying the live session\'s storage state ' +
        '(cookies/login) and actually performs a previously-classified-irreversible action there — the real ' +
        'click/fill/select, not a dry-run read. HONEST LIMIT: unlike the other three, a real website has no ' +
        'throwaway copy of itself, so this is NOT a free trial — executing it IS the one real side effect. ' +
        'human_approved=true is REQUIRED up front for this kind, same rule as apply_browser_action, and the ' +
        'action already happened once simulate_rollout returns (apply_rollout just closes out the report).\n\n' +
        'Nothing here auto-commits (except the inherent, disclosed exception for browser_action above) — this ' +
        'always returns a pending rollout report. Show it to the human, then call apply_rollout with ' +
        'human_approved=true to commit the winning (or an explicitly chosen) candidate for real, or ' +
        'dismiss_rollout to discard.',
      parameters: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description: 'What this rollout is trying to determine, e.g. "auth refactor across 3 files" or "which of 2 caching strategies performs better".',
          },
          action_kind: {
            type: 'string',
            enum: ['project_action', 'deploy_preview', 'world_watch', 'browser_action'],
            description: 'Which kind of action every candidate below is an instance of.',
          },
          candidates: {
            type: 'array',
            description: '1-4 argument sets to actually try, in parallel. Which fields matter depends on action_kind — see each field\'s description.',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string', description: 'Short label for this candidate, e.g. "approach A: optimistic locking". All kinds.' },
                predicted_outcome: { type: 'string', description: 'What you expect to happen — shown in the report next to what ACTUALLY happened, for an honest comparison. All kinds.' },
                project_dir: { type: 'string', description: 'Real project directory to fork from. Required for project_action and deploy_preview.' },
                files: {
                  type: 'object',
                  description: 'project_action only. Map of {relativePath: fullFileContent} to apply inside the fork before running verification. Provide this and/or command.',
                },
                command: { type: 'string', description: 'project_action only. A custom shell command to run inside the fork instead of (or in addition to) the stack\'s default pipeline. Provide this and/or files.' },
                stack: { type: 'string', description: 'project_action / deploy_preview. Optional stack hint (e.g. "nextjs") — otherwise auto-detected.' },
                provider: { type: 'string', enum: ['vercel', 'netlify', 'fly', 'docker'], description: 'deploy_preview only. Required.' },
                image_tag: { type: 'string', description: 'deploy_preview only. Required when provider is "docker" — e.g. "myregistry/myapp:1.2.3".' },
                watch_kind: { type: 'string', enum: ['file', 'directory', 'command', 'url', 'mcp_resource'], description: 'world_watch only. Required.' },
                watch_target: { type: 'string', description: 'world_watch only. Required — the file/dir path, shell command, URL, or "server::uri" MCP resource to check.' },
                watch_label: { type: 'string', description: 'world_watch only, used only if this candidate is later committed. Defaults to watch_target.' },
                watch_interval_seconds: { type: 'integer', description: 'world_watch only, used only if committed. Defaults to the world model\'s default interval.' },
                watch_heal_project_dir: { type: 'string', description: 'world_watch only, used only if committed. Opts this watch into the self-healing loop (see healer.js) — only meaningful for a "command" watch.' },
                watch_heal_stack: { type: 'string', description: 'world_watch only, used only if committed, paired with watch_heal_project_dir.' },
                approval_id: { type: 'string', description: 'browser_action only. Required — the pending approval id from a prior browser_act() call that classified an action irreversible.' },
              },
            },
          },
          human_approved: {
            type: 'boolean',
            description: 'REQUIRED (must be true) when action_kind is "browser_action" — a real website has no free trial, so running the fork IS the real action. Not required (and not yet meaningful) for the other three kinds, which only need approval later, at apply_rollout.',
          },
        },
        required: ['label', 'action_kind', 'candidates'],
      },
    },
    async execute({ label, action_kind, candidates, human_approved }, context) {
      if (!context.rollout) return 'Rollout sandbox unavailable.';
      // rollout_sandbox.js's deploy_preview adapter forwards `options` straight into
      // deploy.js's prepareDeployment (same as prepare_deployment's own image_tag → options.imageTag
      // translation in deploy_tools.js) — fold the flat image_tag field in here per candidate.
      const mapped = (candidates || []).map(c => {
        if (!c || !c.image_tag) return c;
        const { image_tag, ...rest } = c;
        return { ...rest, options: { ...(rest.options || {}), imageTag: image_tag } };
      });
      try {
        const result = await context.rollout.simulate({
          label, action_kind, candidates: mapped, human_approved: !!human_approved, context,
        });
        return result.ok ? result.report : result.error;
      } catch (err) {
        return `Error running rollout: ${err.message}`;
      }
    },
  },

  {
    name: 'apply_rollout',
    declaration: {
      name: 'apply_rollout',
      description:
        'Commit the winning (or an explicitly chosen) candidate from a rollout to the REAL target — writes ' +
        'project_action files into the real project_dir, promotes a deploy_preview into deploy.js\'s own ' +
        'gated production plan (still requiring its own separate apply_deployment), registers a world_watch\'s ' +
        'recurring schedule, or (for browser_action, which already ran for real during simulate_rollout) just ' +
        'closes out the report. HARD RULE, same as apply_verified_fix/apply_deployment/apply_browser_action: ' +
        'always show the human the rollout report (every candidate\'s real outcome, and the scoring if there ' +
        'were several) first, and only call this with human_approved=true after they explicitly agree.',
      parameters: {
        type: 'object',
        properties: {
          rollout_id: { type: 'string', description: 'The pending rollout id — shown in the Rollout Sandbox section of context, in simulate_rollout\'s report, or by list_pending_rollouts.' },
          human_approved: { type: 'boolean', description: 'Must be true — confirms the human explicitly approved committing this exact rollout.' },
          candidate_index: {
            type: 'integer',
            description: 'Optional 1-based index of which candidate to commit. Omit to use the scored best candidate, or the first candidate that ran clean if scoring was unavailable/only one candidate succeeded.',
          },
        },
        required: ['rollout_id', 'human_approved'],
      },
    },
    async execute({ rollout_id, human_approved, candidate_index }, context) {
      if (!context.rollout) return 'Rollout sandbox unavailable.';
      return context.rollout.applyRollout(rollout_id, !!human_approved, candidate_index, context);
    },
  },

  {
    name: 'dismiss_rollout',
    declaration: {
      name: 'dismiss_rollout',
      description:
        'Discard a pending rollout without committing any candidate. Safe to call without approval for ' +
        'project_action/deploy_preview/world_watch — nothing was ever applied to the real target. For ' +
        'browser_action this only discards the REPORT — it cannot undo the real action that already ran ' +
        'during simulate_rollout (see rollout_sandbox.js HONEST LIMITS).',
      parameters: {
        type: 'object',
        properties: { rollout_id: { type: 'string', description: 'The pending rollout id to discard.' } },
        required: ['rollout_id'],
      },
    },
    async execute({ rollout_id }, context) {
      if (!context.rollout) return 'Rollout sandbox unavailable.';
      return context.rollout.dismissRollout(rollout_id);
    },
  },

  {
    name: 'list_pending_rollouts',
    declaration: {
      name: 'list_pending_rollouts',
      description:
        'List every rollout currently awaiting a decision, with how many candidates ran clean and (if scored) ' +
        'which one came out best. Use this if the Rollout Sandbox context section isn\'t in view, or to double ' +
        'check a rollout_id before calling apply_rollout. For full per-candidate detail, use the report ' +
        'simulate_rollout already returned rather than re-requesting it here.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, context) {
      if (!context.rollout) return 'Rollout sandbox unavailable.';
      return context.rollout.getContext();
    },
  },

];

