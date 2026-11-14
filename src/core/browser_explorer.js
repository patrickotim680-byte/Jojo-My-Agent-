// ── Parallel Browser Explorer ────────────────────────────────────────────────
//
// Feature: divergent multi-tab exploration for AMBIGUOUS navigation tasks —
// "find the best deal", "figure out which of these three signup flows is
// cheapest", "locate the refund policy" on a site whose structure is unknown.
// Sequential agents backtrack one path at a time; this opens N tabs (real,
// isolated BrowserSessionManager sessions) for N different hypotheses about
// where the answer lives, runs them concurrently via SwarmManager (same
// mechanism synthesis.js uses for code branches, applied to navigation
// branches instead), then arbitrates which session actually reached the goal.
//
// Every session an explorer opens still goes through the SAME irreversibility
// gate as a single-session run — parallelism only ever applies to
// exploration/reading, never lets N branches independently trigger N
// irreversible actions unsupervised. Sub-agents can propose pending actions
// (via browser_act) exactly as normal; they still land in
// BrowserSessionManager.pendingActions for a human to review afterward.

import chalk from 'chalk';

const MAX_HYPOTHESES = 5;
const DEFAULT_MAX_ITERATIONS = 6;

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export class ParallelBrowserExplorer {
  /**
   * @param {SwarmManager} swarm - the agent's shared SwarmManager instance.
   * @param {BrowserSessionManager} browser - the agent's shared browser engine.
   */
  constructor({ swarm, browser }) {
    this.swarm = swarm;
    this.browser = browser;
    this.lastRun = null;
  }

  /**
   * @param {string} url - starting URL every branch begins from.
   * @param {string} goal - what counts as success, e.g. "find the lowest total price including shipping".
   * @param {Array<{name:string, instruction:string}>} hypotheses - up to 5 divergent paths to try in parallel.
   */
  async explore({ url, goal, hypotheses, sharedContext }) {
    if (!url) return { ok: false, error: 'url is required.' };
    if (!goal) return { ok: false, error: 'goal is required.' };
    const list = (hypotheses && hypotheses.length ? hypotheses : [
      { name: 'primary-nav', instruction: 'Follow the most obvious primary navigation path toward the goal.' },
      { name: 'search',       instruction: 'Use any on-site search/filter functionality to reach the goal directly.' },
    ]).slice(0, MAX_HYPOTHESES);

    console.log(chalk.magenta(`\n[browser-explorer] Opening ${list.length} parallel sessions for: ${goal}`));

    const sessionIds = {};
    for (const h of list) {
      sessionIds[h.name] = await this.browser.openSession(url);
    }

    const agents = list.map(h => ({
      role: h.name,
      focus:
        `Goal: ${goal}\n\nYou have your OWN isolated browser session — session_id: "${sessionIds[h.name]}". ` +
        `ALWAYS pass this exact session_id to every browser_* tool call; never open a new session, never use ` +
        `another session's id. Starting page: ${url}.\n\n` +
        `YOUR HYPOTHESIS/PATH: ${h.instruction}\n\n` +
        `Explore ONLY this path toward the goal. When you either reach the goal or determine this path ` +
        `doesn't lead there, report clearly: whether you reached the goal, exactly what you found (prices, ` +
        `text, whatever the goal asks for), and the URL you ended on. If any action you'd need is ` +
        `irreversible (submitting a form, confirming a purchase, etc.), call browser_act as normal — it ` +
        `will come back pending human approval rather than executing; report that it's pending, don't treat ` +
        `it as done.`,
      tools: ['browser_extract', 'browser_act', 'browser_navigate', 'browser_list_elements'],
    }));

    const swarmReport = await this.swarm.run(goal, agents, {
      maxIterations: DEFAULT_MAX_ITERATIONS,
      sharedContext,
    });

    // Snapshot each branch's final state for arbitration (independent of
    // whatever prose the swarm report contains).
    const branchStates = [];
    for (const h of list) {
      const sid = sessionIds[h.name];
      let finalExtract = null;
      try { finalExtract = await this.browser.extract(sid, { focus: goal }); }
      catch (err) { finalExtract = { error: err.message }; }
      branchStates.push({ hypothesis: h.name, sessionId: sid, finalUrl: finalExtract?.url, finalExtract });
    }

    const arbitration = await this._arbitrate(goal, branchStates, swarmReport, sharedContext);

    const result = {
      goal, url,
      branches: branchStates.map(b => ({ hypothesis: b.hypothesis, sessionId: b.sessionId, finalUrl: b.finalUrl })),
      swarmReport,
      arbitration,
      pendingActions: this.browser.listPendingActions(),
    };
    this.lastRun = result;
    return this._format(result);
  }

  async _arbitrate(goal, branchStates, swarmReport, sharedContext) {
    const table = branchStates.map(b =>
      `- ${b.hypothesis} (session ${b.sessionId}): ended at ${b.finalUrl || '(unknown)'}\n` +
      `  vision summary: ${(b.finalExtract?.visionSummary || b.finalExtract?.error || '(n/a)').slice(0, 300)}`
    ).join('\n');

    const arbitrationAgents = [{
      role: 'arbitration',
      focus:
        `Goal: ${goal}\n\nSeveral browser sessions independently explored different paths toward this ` +
        `goal in parallel. Their final states:\n${table}\n\nRaw exploration report:\n${swarmReport}\n\n` +
        `State plainly which session (if any) actually achieved the goal, what the concrete answer/result ` +
        `is, and which sessions can be closed as dead ends. If none reached the goal, say so and suggest ` +
        `what to try next.`,
      tools: [],
    }];
    return this.swarm.run(goal, arbitrationAgents, { maxIterations: 1, sharedContext });
  }

  _format(result) {
    const lines = [
      `Parallel exploration complete for: "${result.goal}"`,
      '',
      'Branches:',
      ...result.branches.map(b => `  ${b.hypothesis}: session ${b.sessionId} → ${b.finalUrl || '(unknown)'}`),
      '',
      'Arbitration:',
      result.arbitration,
    ];
    if (result.pendingActions.length) {
      lines.push('', `${result.pendingActions.length} action(s) are pending human approval — see list_pending_browser_actions.`);
    }
    lines.push('', 'Sessions were left OPEN for inspection — close them with browser_close_session once reviewed.');
    return lines.join('\n');
  }
}

