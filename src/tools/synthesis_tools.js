// ── Divergent Synthesis Tools ────────────────────────────────────────────────
// Exposes DivergentSynthesisEngine (src/core/synthesis.js) as callable tools.
// Context carries { synthesis } — the shared engine instance — injected by
// the agent, same wiring pattern as { swarm } in swarm_tools.js / { healer }
// in heal_tools.js. divergent_synthesis PRODUCES a pending proposal; apply/
// dismiss/list mirror heal_tools.js's human-facing side of that same pattern.

export const SYNTHESIS_TOOLS = [

  {
    name: 'divergent_synthesis',
    declaration: {
      name: 'divergent_synthesis',
      description:
        'Run Divergent-Convergent Adversarial Synthesis (DCAS) on a hard/risky coding task: spawn ' +
        'several sub-agents that each implement the SAME task under a genuinely different architectural ' +
        'constraint in isolated copies of the project, profile each branch\'s blast radius (who else in ' +
        'the codebase depends on what it touched), adversarially harden each branch (a "breaker" sub-agent ' +
        'tries to break it, a "fixer" patches it, repeated until nothing new breaks), then arbitrate a ' +
        'ranked merge recommendation. This is far more expensive than a normal edit — reserve it for ' +
        'changes where correctness or blast radius genuinely matters (core logic, security-sensitive code, ' +
        'anything touching many call sites), not routine edits. Nothing is applied to the real project ' +
        'automatically — this only produces a pending proposal; use apply_synthesis_proposal after review.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The coding task every branch independently implements, e.g. "add rate limiting to the /api/upload endpoint".',
          },
          source_dir: {
            type: 'string',
            description: 'Path to the real project directory. Never written to directly — every branch works in its own throwaway copy.',
          },
          stack: {
            type: 'string',
            description: 'Optional stack hint (e.g. "node", "python") — passed to the same auto-detection build_tools.js uses. Defaults to auto-detect per branch.',
          },
          strategies: {
            type: 'array',
            description: 'Optional override of the default 4 strategies (minimal-diff, robust-defensive, refactor-clean, library-leverage). Each item: {name, prompt} describing the architectural constraint for that branch.',
            items: {
              type: 'object',
              properties: {
                name:   { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['name', 'prompt'],
            },
          },
          adversarial_rounds: {
            type: 'integer',
            description: 'Max breaker/fixer rounds per branch before giving up on convergence (default 2, capped at 5).',
          },
        },
        required: ['task', 'source_dir'],
      },
    },
    async execute({ task, source_dir, stack, strategies, adversarial_rounds }, context) {
      if (!context.synthesis) return 'Divergent synthesis engine unavailable.';
      try {
        return await context.synthesis.run({
          task,
          sourceDir: source_dir,
          stack,
          strategies,
          adversarialRounds: adversarial_rounds,
          sharedContext: context,
        });
      } catch (err) {
        return `Error running divergent synthesis: ${err.message}`;
      }
    },
  },

  {
    name: 'apply_synthesis_proposal',
    declaration: {
      name: 'apply_synthesis_proposal',
      description:
        'Apply a divergent-synthesis proposal\'s winning (or explicitly chosen) branch to the real ' +
        'project tree. HARD RULE, same as apply_verified_fix: always show the human the branch ranking, ' +
        'blast radius, and arbitration notes first, and only call this with human_approved=true after ' +
        'they explicitly agree. Never call it speculatively.',
      parameters: {
        type: 'object',
        properties: {
          proposal_id: { type: 'string', description: 'The pending proposal id from divergent_synthesis\'s output or list_synthesis_proposals.' },
          human_approved: { type: 'boolean', description: 'Must be true — confirms the human explicitly approved applying this proposal.' },
          strategy: { type: 'string', description: 'Optional — apply a specific branch by strategy name instead of the recommended one.' },
        },
        required: ['proposal_id', 'human_approved'],
      },
    },
    async execute({ proposal_id, human_approved, strategy }, { synthesis }) {
      if (!synthesis) return 'Divergent synthesis engine unavailable.';
      return synthesis.applyProposal(proposal_id, !!human_approved, strategy);
    },
  },

  {
    name: 'dismiss_synthesis_proposal',
    declaration: {
      name: 'dismiss_synthesis_proposal',
      description:
        'Discard a pending divergent-synthesis proposal without applying it, and clean up its branch ' +
        'directories. Safe to call without approval — never touches the real project tree.',
      parameters: {
        type: 'object',
        properties: { proposal_id: { type: 'string', description: 'The pending proposal id to discard.' } },
        required: ['proposal_id'],
      },
    },
    async execute({ proposal_id }, { synthesis }) {
      if (!synthesis) return 'Divergent synthesis engine unavailable.';
      return synthesis.dismissProposal(proposal_id);
    },
  },

  {
    name: 'list_synthesis_proposals',
    declaration: {
      name: 'list_synthesis_proposals',
      description:
        'List every divergent-synthesis proposal currently pending human review, with branch scores, ' +
        'verification/adversarial-hardening results, and the recommended branch.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { synthesis }) {
      if (!synthesis) return 'Divergent synthesis engine unavailable.';
      const all = synthesis.listPending();
      if (!all.length) return 'No pending synthesis proposals.';
      return all.map(p =>
        `[${p.id}] "${p.task}" — recommended: ${p.recommended || 'none'} (confidence ${p.confidence}/100)\n` +
        p.branches.map(b => `    ${b.strategy}: score=${b.score}, verified=${b.verificationOk}, blast_radius=${b.blastRadius}`).join('\n')
      ).join('\n\n');
    },
  },

];

