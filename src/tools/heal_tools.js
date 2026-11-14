// ── Self-Healing Tools ───────────────────────────────────────────────────────
// Exposes SelfHealer (src/core/healer.js) as callable tools. Context carries
// { healer } — the shared SelfHealer instance — injected by the agent, same
// wiring pattern as { worldModel } in world_tools.js / { swarm } in
// swarm_tools.js. The loop that PRODUCES a pending fix (world_model drift →
// swarm diagnosis → sandboxed builder verification) runs automatically in
// the background — these tools only cover the human-facing apply/dismiss/
// inspect side of it.

export const HEAL_TOOLS = [

  {
    name: 'apply_verified_fix',
    declaration: {
      name: 'apply_verified_fix',
      description:
        'Apply a self-healing fix that world_model detected drift on, a swarm diagnosed, and builder ' +
        'already verified end-to-end (install/build/test) inside an isolated sandbox — nothing has touched ' +
        'the real project tree yet. HARD RULE, same as mcp_add_server: always show the human the diagnosis, ' +
        'the candidate fix\'s file list, and the sandbox verification summary first, and only call this ' +
        'with human_approved=true after they explicitly agree. Never call it speculatively.',
      parameters: {
        type: 'object',
        properties: {
          fix_id: {
            type: 'string',
            description: 'The pending fix id — shown in the Self-Healing section of context, or by list_pending_fixes.',
          },
          human_approved: {
            type: 'boolean',
            description: 'Must be true — confirms the human explicitly approved applying this exact fix.',
          },
        },
        required: ['fix_id', 'human_approved'],
      },
    },
    async execute({ fix_id, human_approved }, { healer }) {
      if (!healer) return 'Self-healer unavailable.';
      return healer.applyFix(fix_id, !!human_approved);
    },
  },

  {
    name: 'dismiss_verified_fix',
    declaration: {
      name: 'dismiss_verified_fix',
      description:
        'Discard a pending self-healing fix without applying it. Safe to call without approval — it only ' +
        'removes a suggestion, it never touches the project tree.',
      parameters: {
        type: 'object',
        properties: { fix_id: { type: 'string', description: 'The pending fix id to discard.' } },
        required: ['fix_id'],
      },
    },
    async execute({ fix_id }, { healer }) {
      if (!healer) return 'Self-healer unavailable.';
      return healer.dismissFix(fix_id);
    },
  },

  {
    name: 'list_pending_fixes',
    declaration: {
      name: 'list_pending_fixes',
      description:
        'List every self-healing fix currently verified and awaiting human approval, with its diagnosis, ' +
        'root cause, and sandbox verification summary. Use this if the Self-Healing context section isn\'t ' +
        'enough detail, or to double check before calling apply_verified_fix.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { healer }) {
      if (!healer) return 'Self-healer unavailable.';
      const all = healer.listPending();
      if (!all.length) return 'No pending self-healing fixes.';
      return all.map(f =>
        `[${f.id}] "${f.watchLabel}" — ${f.description}\n` +
        `  Files: ${Object.keys(f.files).join(', ')}\n` +
        `  Diagnosis: ${f.diagnosis.split('\n')[0]}\n` +
        `  Root cause: ${f.rootCause.split('\n')[0]}\n` +
        `  Verification: ${f.verificationSummary}\n` +
        `  Candidates tried: ${f.candidatesTried}, created: ${f.createdAt}`
      ).join('\n\n');
    },
  },

];

