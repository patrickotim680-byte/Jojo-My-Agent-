// ── Review Tools ──────────────────────────────────────────────────────────────
// Exposes ReviewBoard (src/core/review_board.js) as a callable tool. Context
// carries { reviewBoard } — shared instance — injected by the agent, same
// wiring pattern as { swarm }/{ healer }/{ synthesis }/{ browser } elsewhere.
// Stateless beyond the last in-memory run — no init(), no ledger.

export const REVIEW_TOOLS = [

  {
    name: 'review_code',
    declaration: {
      name: 'review_code',
      description:
        'Run a multi-perspective adversarial review on a directory of code: specialized sub-agents each ' +
        'review ONE axis (correctness-vs-spec, security, performance, maintainability) with read-only tools ' +
        '(they cannot write/modify anything), then a devil\'s-advocate sub-agent argues specifically FOR ' +
        'rejecting the change, then a final pass weighs both into a verdict: PASS, PASS_WITH_CONCERNS, or ' +
        'BLOCK. Costs 4+ sub-agent calls — reserve this for changes worth that cost (e.g. the winning branch ' +
        'from divergent_synthesis, or any change you\'re about to hand back as finished), not routine edits. ' +
        'A BLOCK or PASS_WITH_CONCERNS verdict should be shown to the human before you present the code as done.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'Directory containing the code to review (e.g. a synthesis branch dir, or the real project dir for a plain edit).' },
          task: { type: 'string', description: 'What the change was supposed to accomplish, for context.' },
          axes: {
            type: 'array',
            description: 'Optional override of the default 4 review axes (correctness, security, performance, maintainability). Each item: {name, prompt}.',
            items: {
              type: 'object',
              properties: {
                name:   { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['name', 'prompt'],
            },
          },
        },
        required: ['dir', 'task'],
      },
    },
    async execute({ dir, task, axes }, context) {
      if (!context.reviewBoard) return 'Review board unavailable.';
      try {
        return await context.reviewBoard.review({ dir, task, axes, sharedContext: context });
      } catch (err) {
        return `Error running review board: ${err.message}`;
      }
    },
  },

];

