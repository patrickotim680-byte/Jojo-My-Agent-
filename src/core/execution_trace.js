// execution_trace.js — the missing cross-subsystem memory.
//
// self_model.js already reads skill_ledger, synthesis's ledger, site_ledger,
// and deploy's ledger — four independent "did MY thing work" records. None
// of them capture the ROUTING decision that led there in the first place
// (direct call vs swarm vs second_opinion+review_board), so a question like
// "does routing ambiguous requests to swarm actually help?" has no data to
// answer it with — each subsystem only knows about itself.
//
// This is a thin ring-buffer ledger, same "real counts, fails soft, capped
// size" posture as every other ledger in this codebase: conductor.js writes
// one entry per completed turn (classification + route chosen + which tools
// actually ran + outcome), self_model.js reads it as a fifth source.

const MAX_ENTRIES = parseInt(process.env.EXECUTION_TRACE_MAX || '500', 10);

export class ExecutionTraceLedger {
  constructor() {
    this.entries = []; // oldest evicted first once MAX_ENTRIES is hit
  }

  /** outcome: 'success' | 'correction' | 'unknown' — same vocabulary
   *  skill_ledger.js already uses, so cross-referencing by hand is at least
   *  consistent even though these are two separate ledgers. */
  record({ taskId, tier, complexity, reversible, ambiguous, route, toolsUsed = [], outcome = 'unknown' }) {
    this.entries.push({
      taskId, tier, complexity, reversible, ambiguous, route,
      toolsUsed, outcome, at: new Date().toISOString(),
    });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  /** Grouped by route, real counts only. What self_model.js's reflect() call
   *  actually consumes — see self_model.js's _gatherRawStats(). */
  summarizeByRoute() {
    const byRoute = {};
    for (const e of this.entries) {
      const r = byRoute[e.route] || (byRoute[e.route] = { total: 0, success: 0, correction: 0, unknown: 0 });
      r.total++;
      r[e.outcome === 'success' || e.outcome === 'correction' ? e.outcome : 'unknown']++;
    }
    return byRoute;
  }

  getContext() {
    if (!this.entries.length) return '(no routed turns logged yet)';
    const byRoute = this.summarizeByRoute();
    const lines = Object.entries(byRoute).map(([route, s]) =>
      `${route}: ${s.total} turn(s), ${s.success} clean success, ${s.correction} needed correction`);
    return `Execution trace (${this.entries.length} logged turn(s)):\n  ${lines.join('\n  ')}`;
  }
}

