// ── Review Board ──────────────────────────────────────────────────────────────
//
// Feature: Multi-Perspective Adversarial Code Review
//
// A single pass reviewing its own work shares the same blind spots it had
// while writing it — same assumptions, same things it didn't think to check.
// This module doesn't use a different or "smarter" model underneath; it gets
// better verdicts out of the SAME model by changing the process:
//
//   1. SPECIALIZED PARALLEL REVIEWERS
//      Several sub-agents review the SAME diff, each scoped to exactly ONE
//      axis (correctness-vs-spec, security, performance, maintainability by
//      default) and given ONLY read-only tools (read_file, list_directory,
//      bash_execute — no write_file in their tool list at all, so a reviewer
//      is structurally incapable of "fixing" what it's supposed to be
//      critiquing, not just instructed not to).
//
//   2. DEVIL'S ADVOCATE
//      A separate sub-agent then argues specifically FOR REJECTING the
//      change, as persuasively as it honestly can, using the specialized
//      reviewers' findings as ammunition. It's explicitly told that if it
//      genuinely can't build a credible case, it should say so plainly
//      rather than manufacture a weak objection — the point is real
//      adversarial pressure, not theater.
//
//   3. VERDICT SYNTHESIS
//      One final pass weighs the specialized findings against the devil's
//      advocate case and returns a structured verdict — PASS /
//      PASS_WITH_CONCERNS / BLOCK — with a concern list, not just a vibe.
//
// HOW THIS COMPOSES WITH synthesis.js:
//   DivergentSynthesisEngine already ranks branches and arbitrates a winner
//   (see synthesis.js Phase 4). Call ReviewBoard.review({ dir: winningBranch.dir,
//   task }) on that winner BEFORE it's surfaced as a pending proposal, and
//   attach the verdict to the proposal — a BLOCK verdict should downgrade
//   confidence or hold the proposal back entirely, the same way an unverified
//   fix never gets surfaced in healer.js. Not wired automatically here since
//   you're integrating this yourself — see the tool-wiring sketch at the
//   bottom of this file for the shape to hook it in with.
//
// HONEST LIMITS:
//   - This is still one underlying model reviewing itself from different
//     angles, not an independent second opinion from a different system.
//     Correlated blind spots (something the model is systematically wrong
//     about regardless of framing) can survive all four passes. Treat a
//     PASS verdict as "passed structured adversarial review," not as proof
//     of correctness.
//   - Reviewers can read and run commands (bash_execute) but cannot write —
//     enforced by omitting write_file from their tool list, not by prompt
//     instruction alone. If your agent's tool registry ever adds a
//     write-capable tool under a different name, update DEFAULT reviewer
//     tools here to keep excluding it.
//   - _parseVerdict() is a heuristic text parse of the verdict sub-agent's
//     own report, not a structured/enforced output format. It defaults to
//     the more cautious PASS_WITH_CONCERNS when the text is ambiguous rather
//     than guessing PASS.
//   - This costs 4+ real sub-agent calls (N reviewers + devil's advocate +
//     verdict) per review. Reserve it for changes worth that cost — exactly
//     the same "don't use this for routine edits" framing synthesis.js and
//     browser_explorer.js already give their own expensive workflows.

const DEFAULT_AXES = [
  {
    name: 'correctness',
    prompt:
      'Check the change against what the task actually asked for — not just "does it run," but does it ' +
      'handle the edge cases and failure modes the task implies (empty/null/huge inputs, concurrent calls, ' +
      'partial failures)? Look for logic that\'s subtly wrong, not just code that\'s broken.',
  },
  {
    name: 'security',
    prompt:
      'Look for injection risks (SQL/command/template), unsanitized input reaching a sensitive sink, secrets ' +
      'or credentials handled carelessly, missing authz/authn checks on anything newly exposed, and unsafe ' +
      'deserialization. If nothing in this diff touches a security-relevant surface, say so plainly.',
  },
  {
    name: 'performance',
    prompt:
      'Look for obviously avoidable O(n^2)-or-worse patterns on data that can realistically grow, unbounded ' +
      'loops/recursion, N+1 query patterns, or resources (files, connections, listeners) opened without being ' +
      'closed/released. Ignore micro-optimizations that don\'t matter at realistic scale.',
  },
  {
    name: 'maintainability',
    prompt:
      'Look for naming that misleads, logic duplicated instead of reused, functions doing too many unrelated ' +
      'things, and missing/misleading comments on anything genuinely non-obvious. Don\'t nitpick style that a ' +
      'linter would catch — focus on things a formatter can\'t fix.',
  },
];

const REVIEWER_TOOLS = ['read_file', 'list_directory', 'bash_execute']; // no write_file — see HONEST LIMITS
const REVIEWER_MAX_ITERATIONS = 4;
const ADVOCATE_MAX_ITERATIONS = 4;
const VERDICT_MAX_ITERATIONS  = 1;

const VERDICT_TOKENS = ['BLOCK', 'PASS_WITH_CONCERNS', 'PASS']; // check in this order — BLOCK/concerns are more specific than a bare PASS

export class ReviewBoard {
  /** @param {SwarmManager} swarm - the agent's shared SwarmManager instance. */
  constructor({ swarm }) {
    this.swarm = swarm;
    this.lastReview = null;
  }

  /**
   * @param {string} dir - directory containing the code to review (e.g. a synthesis branch dir, or the real project dir for a plain edit).
   * @param {string} task - what the change was supposed to accomplish, for context.
   * @param {Array<{name:string, prompt:string}>} [axes] - override the default 4 review axes.
   */
  async review({ dir, task, axes, sharedContext }) {
    if (!dir) return { ok: false, error: 'dir is required.' };
    if (!task) return { ok: false, error: 'task is required.' };
    const axisList = (axes && axes.length) ? axes : DEFAULT_AXES;

    // ── Phase 1: specialized parallel reviewers ──────────────────────────
    const reviewerAgents = axisList.map(axis => ({
      role: axis.name,
      focus:
        `Task the code in ${dir} was supposed to accomplish: ${task}\n\n` +
        `Review ONLY the ${axis.name} of this code. ${axis.prompt}\n\n` +
        `Read the relevant files in ${dir} — do not modify anything (you don't have write access anyway). ` +
        `Report concrete findings as a list: file, the specific issue, severity (low/medium/high), and a ` +
        `suggested fix. If you find nothing wrong on this axis after actually looking, say so explicitly — ` +
        `do not invent minor nitpicks to seem thorough.`,
      tools: REVIEWER_TOOLS,
    }));
    const reviewerReport = await this.swarm.run(task, reviewerAgents, {
      maxIterations: REVIEWER_MAX_ITERATIONS, sharedContext,
    });

    // ── Phase 2: devil's advocate ─────────────────────────────────────────
    const advocateAgents = [{
      role: 'devils-advocate',
      focus:
        `Task: ${task}\nCode under review: ${dir}\n\n` +
        `Specialized reviewers found:\n${reviewerReport}\n\n` +
        `Argue AGAINST merging this change as persuasively and honestly as you can — read the code yourself, ` +
        `don't just restate the findings above. Find the strongest REAL reason(s) it shouldn't ship, even if ` +
        `the specialized reviewers found nothing severe. If you genuinely cannot build a credible case against ` +
        `it after actually trying, say that explicitly and plainly rather than manufacturing a weak objection.`,
      tools: REVIEWER_TOOLS,
    }];
    const advocateCase = await this.swarm.run(task, advocateAgents, {
      maxIterations: ADVOCATE_MAX_ITERATIONS, sharedContext,
    });

    // ── Phase 3: verdict synthesis ─────────────────────────────────────────
    const verdictAgents = [{
      role: 'verdict',
      focus:
        `Task: ${task}\n\nSpecialized reviewer findings:\n${reviewerReport}\n\n` +
        `Devil's advocate case against merging:\n${advocateCase}\n\n` +
        `Weigh these and return a verdict. Start your response with EXACTLY ONE of these words: BLOCK, ` +
        `PASS_WITH_CONCERNS, or PASS. Then give a short rationale, and a bulleted list of concerns (if any) ` +
        `each tagged with severity. BLOCK means a real reviewer would reject this outright. PASS_WITH_CONCERNS ` +
        `means mergeable but with specific things worth fixing first or watching after. PASS means no ` +
        `significant concerns from either the specialists or the devil's advocate.`,
      tools: [],
    }];
    const verdictText = await this.swarm.run(task, verdictAgents, {
      maxIterations: VERDICT_MAX_ITERATIONS, sharedContext,
    });

    const result = {
      dir, task, axes: axisList.map(a => a.name),
      reviewerReport, advocateCase, verdictText,
      verdict: this._parseVerdict(verdictText),
      reviewedAt: new Date().toISOString(),
    };
    this.lastReview = result;
    return this._format(result);
  }

  _parseVerdict(text) {
    const head = String(text || '').trim().toUpperCase();
    for (const token of VERDICT_TOKENS) {
      if (head.startsWith(token)) return token;
    }
    // Ambiguous output — default to the cautious middle ground rather than
    // guessing PASS (same "when unsure, bias toward the gated path"
    // philosophy as browser.js's _classifyReversibility).
    for (const token of VERDICT_TOKENS) {
      if (head.includes(token)) return token;
    }
    return 'PASS_WITH_CONCERNS';
  }

  _format(result) {
    return [
      `Review board verdict for "${result.task}" (${result.dir}): ${result.verdict}`,
      '',
      `Axes reviewed: ${result.axes.join(', ')}`,
      '',
      'Specialized reviewer findings:',
      result.reviewerReport,
      '',
      "Devil's advocate case:",
      result.advocateCase,
      '',
      'Verdict rationale:',
      result.verdictText,
    ].join('\n');
  }

  getContext() {
    if (!this.lastReview) return '(no review run yet)';
    const r = this.lastReview;
    return `Last review: "${r.task}" → ${r.verdict} (${r.dir}, at ${r.reviewedAt})`;
  }
}

// ── Suggested tool wiring (not included — wire this yourself) ─────────────
// A tool wrapper follows the exact same shape as SYNTHESIS_TOOLS/BROWSER_TOOLS:
//
//   {
//     name: 'review_code',
//     declaration: { name: 'review_code', description: '...', parameters: {
//       type: 'object',
//       properties: {
//         dir:  { type: 'string', description: 'Directory to review.' },
//         task: { type: 'string', description: 'What the change was supposed to accomplish.' },
//       },
//       required: ['dir', 'task'],
//     } },
//     async execute({ dir, task }, { reviewBoard }) {
//       if (!reviewBoard) return 'Review board unavailable.';
//       return reviewBoard.review({ dir, task, sharedContext: arguments[1] });
//     },
//   }
//
// Instantiate alongside the other engines in agent.js:
//   this.reviewBoard = new ReviewBoard({ swarm: this.swarm });
// and add `reviewBoard: this.reviewBoard,` to _toolContext(). No init()/ledger
// needed — this module holds no persistent state beyond the last in-memory run.

