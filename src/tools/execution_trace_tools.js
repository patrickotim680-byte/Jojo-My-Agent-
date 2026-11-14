// ── Execution Trace Tools ────────────────────────────────────────────────────
// Feature: visible reasoning trail, spoken on request.
//
// execution_trace.js already logs one entry per completed turn (routing
// classification + which tools actually ran + outcome — see agent.js's
// conductor.recordOutcome() call at the end of run()). This exposes the
// most recent entry as a short, spoken-friendly explanation instead of
// requiring the person to read the raw ledger themselves.
//
// Context carries { executionTrace } — the shared ExecutionTraceLedger
// instance — same wiring pattern as every other *_tools.js file in this
// codebase.

const ROUTE_LABELS = {
  direct: 'answered directly',
  swarm: 'split the work across a few parallel sub-agents',
  'second_opinion+review_board': 'got a second opinion and a review pass before acting, since it looked irreversible',
};

export const EXECUTION_TRACE_TOOLS = [

  {
    name: 'explain_last_action',
    declaration: {
      name: 'explain_last_action',
      description:
        'Explain, in 1-2 short spoken-friendly sentences, what you just did on the previous turn and why — ' +
        'which route was used, which tools actually ran, and whether a self-critique pass caught and fixed ' +
        'an issue. Use this when the user asks something like "why did you do that", "what did you just do", ' +
        'or "walk me through that" — never volunteer this unprompted.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { executionTrace }) {
      const entries = executionTrace?.entries || [];
      const last = entries[entries.length - 1];
      if (!last) return "I don't have a logged action from a previous turn to explain yet.";

      const routeLabel = ROUTE_LABELS[last.route] || `used the "${last.route}" route`;
      const tools = last.toolsUsed?.length ? ` using ${last.toolsUsed.slice(0, 4).join(', ')}` : '';
      const outcomeNote = last.outcome === 'correction'
        ? ' A quick self-check caught an issue and I fixed it before answering.'
        : '';
      const reversibleNote = last.reversible ? 'reversible' : 'flagged as not easily reversible';

      return `Last turn I ${routeLabel}${tools} (complexity ${last.complexity}, ${reversibleNote}).${outcomeNote}`;
    },
  },

];

