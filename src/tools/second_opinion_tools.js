// ── Second Opinion Tool ──────────────────────────────────────────────────────
// Exposes SecondOpinionEngine (src/core/second_opinion.js) as a callable tool
// for AD HOC use. Context carries { secondOpinion } — the shared engine
// instance — injected by the agent, same wiring pattern as { reviewBoard } in
// review_tools.js. The three high-stakes gates (prepare_deployment,
// browser_act, divergent_synthesis) already call this engine automatically —
// this tool is for asking for an independent cross-vendor check anywhere
// else you judge it's warranted (a risky-looking file edit, a plan the human
// seems unsure about, anything you want a second, differently-trained model
// to sanity-check before you commit to it).

export const SECOND_OPINION_TOOLS = [

  {
    name: 'get_second_opinion',
    declaration: {
      name: 'get_second_opinion',
      description:
        'Ask a model from a DIFFERENT vendor (not Anthropic) to independently review something you\'re ' +
        'about to do or just produced — a plan, a diff, a decision — and flag anything it sees wrong. ' +
        'Unlike review_code, this is a genuinely independent check: different architecture, different ' +
        'training data, different blind spots, not the same model reviewing itself from another angle. ' +
        'Use it for genuinely high-stakes or uncertain calls, not routine work — it\'s a real extra model ' +
        'call. Returns a DISAGREE / CONCERNS / CONCUR verdict plus rationale, or an explicit failure if no ' +
        'cross-vendor model could be reached (never silently treat that as a pass).',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Short label for what\'s being reviewed, e.g. "plan to rewrite the auth middleware".' },
          detail: { type: 'string', description: 'The actual material to review — the plan, diff, or decision text itself.' },
          question: { type: 'string', description: 'Optional — a specific question to ask instead of the default general safety/correctness prompt.' },
        },
        required: ['subject', 'detail'],
      },
    },
    async execute({ subject, detail, question }, { secondOpinion }) {
      if (!secondOpinion) return 'Second opinion engine unavailable.';
      const result = await secondOpinion.getSecondOpinion({ subject, detail, question });
      return secondOpinion.format(result);
    },
  },

];

