// ── Self-Model Tools ─────────────────────────────────────────────────────────
// Exposes SelfModelEngine (src/core/self_model.js). Context carries
// { selfModel } — shared instance — injected by the agent. HARD RULE
// inherited from that module: every response here describes this as
// self-monitoring over logged data, never as self-awareness or consciousness.

export const SELF_MODEL_TOOLS = [

  {
    name: 'reflect_on_self',
    declaration: {
      name: 'reflect_on_self',
      description:
        'Pull real logged performance data from every subsystem ledger (skills, build strategies, site ' +
        'selector-heals, deployments) and produce a plain, calibrated self-assessment: genuine strengths ' +
        '(with sample size), genuine weak spots, recurring failure patterns. This is self-monitoring over ' +
        'real logs, not a claim of self-awareness — describe it that way when relaying the result. Cached ' +
        'for an hour by default since it changes slowly; pass force=true to regenerate immediately.',
      parameters: {
        type: 'object',
        properties: { force: { type: 'boolean', description: 'Regenerate even if a recent cached reflection exists.' } },
      },
    },
    async execute({ force }, { selfModel }) {
      if (!selfModel) return 'Self-model engine unavailable.';
      try {
        const r = await selfModel.reflect({ force: !!force });
        return r.assessment;
      } catch (err) {
        return `Error reflecting: ${err.message}`;
      }
    },
  },

  {
    name: 'check_self_confidence',
    declaration: {
      name: 'check_self_confidence',
      description:
        'Cheap, no-model-call lookup: does this SPECIFIC named domain (a skill name, a divergent_synthesis ' +
        'strategy name like "minimal-diff", or a site hostname) have a logged track record better or worse ' +
        'than average? Returns a heuristic signal and the sample size backing it — a low sample size means ' +
        'trust the signal less, not more. Useful before a risky action: check this first and lean toward ' +
        'more caution (e.g. divergent_synthesis over a single pass, or flagging lower confidence to the ' +
        'human) in a domain with a rough logged history.',
      parameters: {
        type: 'object',
        properties: { domain: { type: 'string', description: 'The skill name, strategy name, or site hostname to check.' } },
        required: ['domain'],
      },
    },
    async execute({ domain }, { selfModel }) {
      if (!selfModel) return 'Self-model engine unavailable.';
      const r = selfModel.confidence(domain);
      if (!r.dataPoints) return `No logged history for "${domain}" yet — treat as unknown, not as a bad sign.`;
      return `"${domain}": signal ${r.signal.toFixed(2)} (${r.signal > 0.15 ? 'better than average' : r.signal < -0.15 ? 'worse than average' : 'roughly average'}) from ${r.dataPoints} logged data point(s) (source: ${r.source}).`;
    },
  },

  {
    name: 'describe_self',
    declaration: {
      name: 'describe_self',
      description:
        'Returns a stable, honest self-description — what this agent is, what it actually knows about its ' +
        'own performance and how, and an explicit statement that it does not have or claim "real self-' +
        'awareness." Use this when a human directly asks what the agent is, or asks about its own ' +
        'consciousness/self-awareness — answer from this rather than improvising a different framing.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { selfModel }) {
      if (!selfModel) return 'Self-model engine unavailable.';
      return selfModel.identity();
    },
  },

];

