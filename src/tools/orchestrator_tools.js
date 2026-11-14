// ── Orchestrator Tools ────────────────────────────────────────────────────────
// Exposes LargeAppOrchestrator (src/core/orchestrator.js). Context carries
// { orchestrator, synthesis } — synthesis is optional, only needed if the
// agent wants to route specific modules through divergent_synthesis.

export const ORCHESTRATOR_TOOLS = [

  {
    name: 'plan_large_app',
    declaration: {
      name: 'plan_large_app',
      description:
        'Decompose a large app spec into a dependency-ordered module graph (up to 12 modules) via one ' +
        'architect sub-agent pass. Returns the module list — review it with the human before calling ' +
        'build_large_app, especially the dependency edges (a wrong dependency changes build order).',
      parameters: {
        type: 'object',
        properties: { spec: { type: 'string', description: 'The full app specification/requirements.' } },
        required: ['spec'],
      },
    },
    async execute({ spec }, { orchestrator }) {
      if (!orchestrator) return 'Large-app orchestrator unavailable.';
      try {
        const plan = await orchestrator.plan({ spec });
        return `Planned ${plan.modules.length} module(s)${plan.fallbackUsed ? ' (fallback — could not parse a real breakdown, treating as one module)' : ''}:\n` +
          plan.modules.map(m => `- ${m.name} (depends on: ${m.dependsOn.join(', ') || 'none'}) → ${m.dir}\n  ${m.description}`).join('\n');
      } catch (err) {
        return `Error planning app: ${err.message}`;
      }
    },
  },

  {
    name: 'build_large_app',
    declaration: {
      name: 'build_large_app',
      description:
        'Build a large app from a prior plan_large_app() call (or an explicit module list): builds ' +
        'independent modules concurrently in dependency-ordered waves, runs integration verification against ' +
        'the WHOLE target directory after every wave (not just at the end), tracks progress as a real task ' +
        'on the task board, and optionally runs one review_code pass over the finished app. Expensive — this ' +
        'runs one sub-agent build per module plus a build/test cycle per wave. Only route specific modules ' +
        'through divergent_synthesis (via use_synthesis_for) if they\'re genuinely high-stakes; the rest get ' +
        'one straightforward implementer pass.',
      parameters: {
        type: 'object',
        properties: {
          spec: { type: 'string', description: 'The app spec (same one passed to plan_large_app, or standalone if modules is given explicitly).' },
          target_dir: { type: 'string', description: 'Directory to build the app into.' },
          use_synthesis_for: { type: 'array', items: { type: 'string' }, description: 'Module names to build via divergent_synthesis instead of a single pass — reserve for genuinely high-stakes modules.' },
          review_after_build: { type: 'boolean', description: 'Run one review_code pass over the finished app. Defaults to true.' },
        },
        required: ['spec', 'target_dir'],
      },
    },
    async execute({ spec, target_dir, use_synthesis_for, review_after_build }, context) {
      if (!context.orchestrator) return 'Large-app orchestrator unavailable.';
      try {
        return await context.orchestrator.build({
          spec, targetDir: target_dir,
          useSynthesisFor: use_synthesis_for || [],
          reviewAfterBuild: review_after_build !== false,
          synthesis: context.synthesis,
          sharedContext: context,
        });
      } catch (err) {
        return `Error building app: ${err.message}`;
      }
    },
  },

];

