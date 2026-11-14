// ── Divergent Synthesis Engine ──────────────────────────────────────────────
//
// Feature: "Divergent-Convergent Adversarial Synthesis" (DCAS)
//
// Every existing coding agent (Devin, Cursor, Claude Code, Copilot Workspace,
// this codebase's own `builder.js` verify loop) follows some shape of
// plan → write → test → fix → repeat, on ONE implementation path. Retries
// vary *how hard it tries*, not *what kind of solution it tries*.
//
// This module is a different shape, built entirely out of primitives this
// codebase already has (SwarmManager for parallel scoped sub-agents,
// builder.js's sandboxed runVerification, the human-approval-gated pending
// pattern from healer.js):
//
//   Phase 1  DIVERGENT BRANCHING
//            N sub-agents, each under a genuinely different architectural
//            constraint (see DEFAULT_STRATEGIES), each working in its own
//            throwaway copy of the project. Not N attempts at the same idea —
//            N different ideas.
//
//   Phase 2  BLAST-RADIUS PROFILING
//            For every branch, diff against the untouched baseline, then grep
//            the REAL project tree for import/require sites that reference
//            each changed module. A branch that "works" but touches code used
//            in twelve other places is riskier than one that doesn't, even if
//            both pass their tests — this is checked BEFORE scoring, not
//            left implicit.
//
//   Phase 3  ADVERSARIAL SELF-PLAY
//            Per branch: a "breaker" sub-agent writes new edge-case/property
//            tests aimed at THAT branch's own diff and reports failures; a
//            "fixer" sub-agent (same branch, same directory) patches them.
//            Repeats until the breaker finds nothing new for
//            CONVERGENCE_STREAK rounds in a row, or maxRounds is hit. This is
//            adversarial hardening, not "run the existing suite once."
//
//   Phase 4  ARBITRATION
//            One model call sees every branch's diff, blast radius, and
//            adversarial-hardening outcome side by side and produces a merge
//            recommendation — including explicit conflicts a human needs to
//            resolve, mirroring swarm.js's arbitration pass but over full
//            implementations instead of findings.
//
//   Phase 5  TRUST-WEIGHTED HUMAN GATE
//            Nothing is ever auto-applied. A proposal is queued (same pattern
//            as healer.js's pending fixes) with a confidence score weighted
//            by that strategy's historical win rate (persisted ledger, same
//            idea as skill_ledger.js's score-from-history approach). Only
//            applyProposal(id, humanApproved=true) ever touches the real tree.
//
// HONEST LIMITS:
//   - Blast-radius and complexity-delta are cheap static heuristics (regex/
//     grep based), not a real call graph or AST diff. They're good enough to
//     rank branches relative to each other; don't read them as precise.
//   - _extractFailureCount() parses the breaker sub-agent's own natural-
//     language report for a failure count — it's a heuristic parser, not a
//     structured test-runner integration. If a project's test output format
//     is unusual, treat convergence as approximate.
//   - This is expensive: N branches × (1 build/verify + up to
//     adversarialRounds × 2 sub-agent calls) is a lot of tokens and wall
//     time. It's meant for genuinely hard/risky changes, not routine edits —
//     same "reserve it" framing swarm.js already gives spawn_subagent_swarm.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import chalk from 'chalk';
import { ApprovalGate } from './approval_gate.js';
import { runVerification, detectStack } from './builder.js';

const LEDGER_DIR  = './memory';
const LEDGER_FILE = path.join(LEDGER_DIR, 'synthesis_ledger.json');

const SANDBOX_EXCLUDE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.cache',
]);

const DEFAULT_STRATEGIES = [
  {
    name: 'minimal-diff',
    prompt: 'Solve this with the smallest possible change to existing code. Prefer editing over ' +
      'rewriting, reuse existing helpers/patterns exactly as they are, and avoid touching anything ' +
      'not strictly necessary to satisfy the task.',
  },
  {
    name: 'robust-defensive',
    prompt: 'Solve this prioritizing correctness under adversarial/edge-case input above all else: ' +
      'validate inputs, handle empty/null/huge/malformed cases explicitly, fail loudly and specifically ' +
      'rather than silently. Some extra verbosity/boilerplate is an acceptable tradeoff for this branch.',
  },
  {
    name: 'refactor-clean',
    prompt: 'Solve this by first improving the structure of the surrounding code the task touches ' +
      '(naming, duplication, separation of concerns), then implementing the task on top of that cleaner ' +
      'structure. A larger diff is acceptable if the result is clearly more maintainable.',
  },
  {
    name: 'library-leverage',
    prompt: 'Solve this by leaning on well-established libraries/stdlib features already present in ' +
      'this project\'s dependency tree (or trivially addable) instead of hand-rolling logic, even if ' +
      'that means a different shape of solution than a from-scratch implementation.',
  },
];

const MAX_ADVERSARIAL_ROUNDS_DEFAULT = 2;
const CONVERGENCE_STREAK             = 2;   // rounds w/ zero new breaker-found failures → branch "converged"
const BRANCH_SWARM_MAX_ITERATIONS    = 8;
const ADVERSARIAL_MAX_ITERATIONS     = 5;

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function copyTree(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(src, dest, {
    recursive: true,
    filter: (p) => !SANDBOX_EXCLUDE.has(path.basename(p)),
  });
}

async function walkFiles(dir, base = dir, out = new Map()) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (SANDBOX_EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, base, out);
    } else if (entry.isFile()) {
      const rel = path.relative(base, full);
      out.set(rel, full);
    }
  }
  return out;
}

/** {relPath -> sha1} snapshot of a tree, used to diff branch vs. baseline. */
async function snapshotFiles(dir) {
  const files = await walkFiles(dir);
  const snap = {};
  for (const [rel, full] of files) {
    try {
      const buf = await fs.readFile(full);
      snap[rel] = crypto.createHash('sha1').update(buf).digest('hex');
    } catch { /* unreadable file (broken symlink etc) — skip */ }
  }
  return snap;
}

function diffSnapshots(before, after) {
  const changed = [], added = [], removed = [];
  for (const rel of Object.keys(after)) {
    if (!(rel in before)) added.push(rel);
    else if (before[rel] !== after[rel]) changed.push(rel);
  }
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) removed.push(rel);
  }
  return { changed, added, removed, touched: [...changed, ...added] };
}

/** Cheap complexity proxy: count of branching/logic tokens. Not real
 *  cyclomatic complexity — good enough to RANK branches against each other. */
function branchPointCount(src) {
  const matches = src.match(/\b(if|for|while|switch|catch)\b|&&|\|\|/g);
  return matches ? matches.length : 0;
}

async function complexityDelta(sourceDir, branchDir, touchedRelPaths) {
  let delta = 0;
  for (const rel of touchedRelPaths) {
    let before = '', after = '';
    try { before = await fs.readFile(path.join(sourceDir, rel), 'utf-8'); } catch { /* new file */ }
    try { after  = await fs.readFile(path.join(branchDir, rel), 'utf-8'); } catch { /* unreadable/binary */ }
    delta += Math.max(0, branchPointCount(after) - branchPointCount(before));
  }
  return delta;
}

/** For each touched file, grep the REAL project tree for import/require
 *  sites referencing its module path (by basename, minus extension) — a
 *  1-hop static "who depends on this" heuristic. */
async function estimateBlastRadius(sourceDir, touchedRelPaths) {
  const allFiles = await walkFiles(sourceDir);
  let dependentCount = 0;
  const dependents = new Set();

  for (const rel of touchedRelPaths) {
    const base = path.basename(rel).replace(/\.[jt]sx?$/, '');
    if (!base) continue;
    const needle = new RegExp(
      `(?:from\\s+['"][^'"]*${base}['"]|require\\(\\s*['"][^'"]*${base}['"]\\s*\\))`
    );
    for (const [depRel, depFull] of allFiles) {
      if (depRel === rel) continue;
      let content;
      try { content = await fs.readFile(depFull, 'utf-8'); } catch { continue; }
      if (needle.test(content)) {
        dependents.add(depRel);
        dependentCount++;
      }
    }
  }
  return { dependentCount, dependentFiles: [...dependents] };
}

function defaultLedger() {
  return { strategies: {} }; // name -> { wins, total }
}

export class DivergentSynthesisEngine {
  /**
   * @param {object} genAI - PuterAI-shaped client (unused directly here —
   *   all model calls route through `swarm`, kept for future direct-call use).
   * @param {ToolRegistry} toolRegistry - parent's full registry (for reference/logging only).
   * @param {SwarmManager} swarm - the SAME SwarmManager instance the agent already owns;
   *   branches and adversarial roles are just scoped swarm runs.
   * @param {object} [secondOpinion] - optional SecondOpinionEngine instance. If given, the
   *   winning branch gets a mandatory cross-vendor pass (see second_opinion.js) BEFORE the
   *   proposal is even queued for human review — an independent opinion baked into what the
   *   human sees from the start, not a separate step they have to remember to ask for.
   */
  constructor({ genAI, toolRegistry, swarm, secondOpinion }) {
    this.genAI = genAI;
    this.toolRegistry = toolRegistry;
    this.swarm = swarm;
    this.secondOpinion = secondOpinion || null;
    this.ledger = defaultLedger();
    this.gate = new ApprovalGate({ idPrefix: 'prop', kind: 'synthesis proposal' });
    this.lastRun = null;
  }

  async init() {
    await fs.mkdir(LEDGER_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(LEDGER_FILE, 'utf-8');
      this.ledger = { ...defaultLedger(), ...JSON.parse(raw) };
    } catch {
      await this._saveLedger();
    }
  }

  async _saveLedger() {
    await fs.writeFile(LEDGER_FILE, JSON.stringify(this.ledger, null, 2), 'utf-8');
  }

  _trustFor(strategyName) {
    const rec = this.ledger.strategies[strategyName];
    if (!rec || rec.total < 3) return 0.5; // no/thin history — neutral prior
    return rec.wins / rec.total;
  }

  _updateTrust(winningStrategyName, allStrategyNames) {
    for (const name of allStrategyNames) {
      const rec = this.ledger.strategies[name] || (this.ledger.strategies[name] = { wins: 0, total: 0 });
      rec.total++;
      if (name === winningStrategyName) rec.wins++;
    }
  }

  /**
   * Run the full DCAS pipeline against a task. Never touches sourceDir —
   * everything happens in throwaway copies until a human approves applying
   * the winning branch's files back via applyProposal().
   */
  async run({ task, sourceDir, stack, strategies, adversarialRounds, sharedContext }) {
    if (!task || !task.trim()) return { ok: false, error: 'task is required.' };
    if (!sourceDir) return { ok: false, error: 'sourceDir is required.' };
    try { await fs.access(sourceDir); }
    catch { return { ok: false, error: `sourceDir "${sourceDir}" does not exist.` }; }

    const strategyList = (strategies && strategies.length)
      ? strategies.map(s => (typeof s === 'string' ? { name: s, prompt: s } : s))
      : DEFAULT_STRATEGIES;
    const rounds = Math.max(1, Math.min(5, adversarialRounds || MAX_ADVERSARIAL_ROUNDS_DEFAULT));
    const runId = uid('syn');

    console.log(chalk.magenta(`\n[synthesis] Branching ${strategyList.length} strategies for: ${task}`));

    const baseline = await snapshotFiles(sourceDir);

    // ── Phase 1: divergent branching ────────────────────────────────────────
    const branchDirs = {};
    for (const strat of strategyList) {
      const dir = path.join(os.tmpdir(), `jojo-synth-${runId}-${strat.name}`);
      await copyTree(sourceDir, dir);
      branchDirs[strat.name] = dir;
    }

    const branchAgents = strategyList.map(strat => ({
      role: strat.name,
      focus:
        `${task}\n\nSTRATEGY CONSTRAINT for this branch: ${strat.prompt}\n\n` +
        `WORK ONLY inside this directory: ${branchDirs[strat.name]} — pass it as the cwd argument to ` +
        `every bash_execute call, and use paths inside it for every read_file/write_file call. Do not ` +
        `read or write anything outside this directory. When done, summarize what you changed and why.`,
      tools: ['read_file', 'write_file', 'list_directory', 'bash_execute', 'code_execute'],
    }));

    await this.swarm.run(task, branchAgents, {
      maxIterations: BRANCH_SWARM_MAX_ITERATIONS,
      sharedContext,
    });

    // ── Phase 2: blast-radius + verification per branch ─────────────────────
    const branches = [];
    for (const strat of strategyList) {
      const dir = branchDirs[strat.name];
      const after = await snapshotFiles(dir);
      const diff = diffSnapshots(baseline, after);
      const blastRadius = await estimateBlastRadius(sourceDir, diff.touched);
      const complexity = await complexityDelta(sourceDir, dir, diff.touched);

      let resolvedStack = stack;
      if (!resolvedStack || resolvedStack === 'auto') {
        resolvedStack = await detectStack(dir).catch(() => 'unknown');
      }
      let verification = { ok: null, summary: 'No detected/buildable stack — verification skipped.' };
      if (resolvedStack && resolvedStack !== 'unknown') {
        verification = await runVerification({ targetDir: dir, stack: resolvedStack })
          .catch(err => ({ ok: false, error: err.message }));
      }

      branches.push({
        strategy: strat.name, dir, diff, blastRadius, complexityDelta: complexity,
        stack: resolvedStack, verification, adversarial: null, score: 0,
      });
    }

    // ── Phase 3: adversarial self-play, per branch ───────────────────────────
    for (const b of branches) {
      console.log(chalk.magenta(`[synthesis] Adversarial hardening: ${b.strategy}`));
      b.adversarial = await this._adversarialHarden(b, task, rounds, sharedContext);
    }

    // ── Phase 4: score + arbitration ─────────────────────────────────────────
    for (const b of branches) b.score = this._scoreBranch(b);
    branches.sort((a, b) => b.score - a.score);
    const arbitration = await this._arbitrate(task, branches, sharedContext);

    // ── Phase 4.5: mandatory cross-vendor second opinion on the winner ──────
    // A DIFFERENT model looks at the winning branch fresh, before the human
    // even sees the proposal — see second_opinion.js HONEST LIMITS. This
    // never blocks or changes which branch is recommended; it only adds an
    // independent opinion to what gets queued for review.
    let secondOpinion = null;
    if (this.secondOpinion && branches[0]) {
      const winnerForOpinion = branches[0];
      secondOpinion = await this.secondOpinion.getSecondOpinion({
        subject: `divergent-synthesis winning branch "${winnerForOpinion.strategy}"`,
        detail:
          `Task: ${task}\n` +
          `Files changed: ${winnerForOpinion.diff.touched.join(', ') || '(none)'}\n` +
          `Files removed: ${winnerForOpinion.diff.removed.join(', ') || '(none)'}\n` +
          `Blast radius: ${winnerForOpinion.blastRadius.dependentCount} dependent files\n` +
          `Verification: ${winnerForOpinion.verification.ok} — ${winnerForOpinion.verification.summary || winnerForOpinion.verification.error || '(n/a)'}\n` +
          `Adversarial hardening: converged=${winnerForOpinion.adversarial.converged} (${winnerForOpinion.adversarial.rounds} rounds)\n` +
          `Arbitration notes: ${arbitration}`,
        question:
          'Based on this summary, does this branch look ready to apply to the real project? Flag anything ' +
          'that looks risky, incomplete, or worth the human double-checking before they approve it.',
      });
    }

    // ── Phase 5: trust-weighted proposal, human-gated ────────────────────────
    const winner = branches[0];
    const trust = winner ? this._trustFor(winner.strategy) : 0.5;
    const confidence = winner
      ? Math.round(Math.min(100, Math.max(0,
          (winner.verification.ok ? 40 : 0) +
          (winner.adversarial.converged ? 25 : 0) +
          trust * 25 +
          (winner.blastRadius.dependentCount === 0 ? 10 : 0)
        )))
      : 0;

    const proposal = {
      id: uid('prop'),
      runId, task, sourceDir,
      createdAt: new Date().toISOString(),
      branches: branches.map(b => ({
        strategy: b.strategy,
        dir: b.dir,
        filesChanged: b.diff.touched,
        filesRemoved: b.diff.removed,
        blastRadius: b.blastRadius.dependentCount,
        blastRadiusFiles: b.blastRadius.dependentFiles,
        complexityDelta: b.complexityDelta,
        verificationOk: b.verification.ok,
        verificationSummary: b.verification.summary || b.verification.error || '(n/a)',
        adversarialConverged: b.adversarial.converged,
        adversarialRoundsRun: b.adversarial.rounds,
        score: b.score,
      })),
      recommended: winner ? winner.strategy : null,
      arbitration,
      secondOpinion,
      confidence,
    };

    this.gate.propose(proposal);
    this.lastRun = proposal;
    if (winner) this._updateTrust(winner.strategy, strategyList.map(s => s.name));
    await this._saveLedger();

    return this._formatProposal(proposal);
  }

  async _adversarialHarden(branch, task, maxRounds, sharedContext) {
    let noNewFailStreak = 0;
    let converged = false;
    let roundsRun = 0;
    const log = [];

    for (let round = 1; round <= maxRounds; round++) {
      roundsRun = round;

      const breakerAgents = [{
        role: 'breaker',
        focus:
          `Branch "${branch.strategy}" (directory: ${branch.dir}) just implemented: ${task}\n\n` +
          `Write NEW adversarial/edge-case tests in this directory targeting the change just made — ` +
          `boundary values, malformed/empty/huge input, unexpected types, concurrent calls, whatever ` +
          `applies to this code. Do NOT fix anything. Run the new tests and report the EXACT number of ` +
          `tests that failed (say "N failing" explicitly) plus a one-line reason for each failure.`,
        tools: ['read_file', 'write_file', 'list_directory', 'bash_execute'],
      }];
      const breakerReport = await this.swarm.run(task, breakerAgents, {
        maxIterations: ADVERSARIAL_MAX_ITERATIONS, sharedContext,
      });
      const failCount = this._extractFailureCount(breakerReport);
      log.push({ round, role: 'breaker', failCount, report: breakerReport });

      if (failCount === 0) {
        noNewFailStreak++;
        if (noNewFailStreak >= CONVERGENCE_STREAK) { converged = true; break; }
        continue;
      }
      noNewFailStreak = 0;

      const fixerAgents = [{
        role: 'fixer',
        focus:
          `Branch "${branch.strategy}" (directory: ${branch.dir}) has failing adversarial tests just ` +
          `written by another sub-agent. Patch the IMPLEMENTATION (never the tests themselves) so the ` +
          `failures below are fixed, without breaking the original task. Re-run the tests afterward and ` +
          `confirm the outcome.\n\nBreaker's report:\n${breakerReport}`,
        tools: ['read_file', 'write_file', 'list_directory', 'bash_execute'],
      }];
      const fixerReport = await this.swarm.run(task, fixerAgents, {
        maxIterations: ADVERSARIAL_MAX_ITERATIONS, sharedContext,
      });
      log.push({ round, role: 'fixer', report: fixerReport });
    }

    return { rounds: roundsRun, converged, log };
  }

  /** Heuristic parse of a breaker sub-agent's natural-language report for a
   *  failure count — see HONEST LIMITS at the top of this file. */
  _extractFailureCount(reportText) {
    const text = String(reportText || '');
    const m = /(\d+)\s+(?:tests?\s+)?(?:are\s+)?fail(?:ing|ed)?/i.exec(text);
    if (m) return parseInt(m[1], 10);
    if (/\b0\s+fail|no\s+failures?|all\s+pass(?:ed|ing)?/i.test(text)) return 0;
    return /\bfail/i.test(text) ? 1 : 0;
  }

  _scoreBranch(b) {
    let score = 0;
    if (b.verification.ok === true) score += 40;
    else if (b.verification.ok === null) score += 15; // unverifiable stack — neutral, not penalized to zero
    if (b.adversarial?.converged) score += 30;
    score += Math.max(0, 15 - b.blastRadius.dependentCount);
    score += Math.max(0, 15 - Math.min(15, b.complexityDelta));
    return Math.round(score);
  }

  async _arbitrate(task, branches, sharedContext) {
    if (!branches.length) return 'No branches produced — nothing to arbitrate.';
    const table = branches.map(b =>
      `- ${b.strategy}: score=${b.score}, verified=${b.verification.ok}, ` +
      `adversarially_converged=${b.adversarial.converged} (${b.adversarial.rounds} rounds), ` +
      `blast_radius=${b.blastRadius.dependentCount} dependents, complexity_delta=${b.complexityDelta}, ` +
      `files_touched=[${b.diff.touched.join(', ')}]`
    ).join('\n');

    const arbitrationAgents = [{
      role: 'arbitration',
      focus:
        `Task: ${task}\n\nFour branches independently implemented this under different constraints. ` +
        `Their comparative results:\n${table}\n\n` +
        `Recommend which branch's implementation to apply, OR describe a specific per-file merge ` +
        `(e.g. "take branch X's version of fileA.js, branch Y's version of fileB.js") if that's clearly ` +
        `better than any single branch wholesale. Explicitly flag any file where two branches made ` +
        `INCOMPATIBLE changes that a human must resolve by hand — do not silently pick one. Be concise.`,
      tools: [],
    }];
    return this.swarm.run(task, arbitrationAgents, { maxIterations: 1, sharedContext });
  }

  _formatProposal(p) {
    const lines = [
      `Divergent synthesis complete for: "${p.task}"`,
      `Proposal id: ${p.id}  (confidence: ${p.confidence}/100)`,
      '',
      'Branches (ranked by score):',
      ...p.branches.map(b =>
        `  [${b.score}] ${b.strategy} — verified=${b.verificationOk}, ` +
        `adversarially_converged=${b.adversarialConverged} (${b.adversarialRoundsRun} rounds), ` +
        `blast_radius=${b.blastRadius}, complexity_delta=${b.complexityDelta}\n` +
        `        files: ${b.filesChanged.join(', ') || '(none)'}`
      ),
      '',
      `Recommended: ${p.recommended || '(none — no branch produced usable output)'}`,
      '',
      'Arbitration:',
      p.arbitration,
      '',
      'Independent second opinion:',
      this.secondOpinion ? this.secondOpinion.format(p.secondOpinion) : 'Not requested — second_opinion engine unavailable.',
      '',
      `Nothing has been applied. Call apply_synthesis_proposal("${p.id}", human_approved=true) after ` +
      `review, or dismiss_synthesis_proposal("${p.id}") to discard.`,
    ];
    return lines.join('\n');
  }

  listPending() {
    return this.gate.list();
  }

  getContext() {
    return this.gate.getContext(p =>
      `[${p.id}] "${p.task}" — recommended: ${p.recommended || 'none'}, confidence: ${p.confidence}/100, ` +
      `${p.branches.length} branches evaluated`
    );
  }

  async _cleanupBranchDirs(proposal) {
    await Promise.all(proposal.branches.map(b =>
      fs.rm(b.dir, { recursive: true, force: true }).catch(() => {})
    ));
  }

  async applyProposal(id, humanApproved, chooseStrategy) {
    const { ok, message, result, record } = await this.gate.apply(id, humanApproved, async proposal => {
      const branchMeta = chooseStrategy
        ? proposal.branches.find(b => b.strategy === chooseStrategy)
        : proposal.branches.find(b => b.strategy === proposal.recommended) || proposal.branches[0];
      if (!branchMeta) throw new Error('No branch available to apply.');

      const written = [];
      for (const rel of branchMeta.filesChanged) {
        const from = path.join(branchMeta.dir, rel);
        const to   = path.join(proposal.sourceDir, rel);
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
        written.push(rel);
      }
      for (const rel of branchMeta.filesRemoved) {
        await fs.rm(path.join(proposal.sourceDir, rel), { force: true });
      }

      // Only reached after files actually landed successfully — matches the
      // original ordering (cleanup + pending-delete happened after the
      // try/catch, never on the error path).
      await this._cleanupBranchDirs(proposal);
      return { branchMeta, written };
    });

    if (!ok) {
      if (message.startsWith('Refused:')) return 'Refused: applyProposal requires explicit human_approved=true. Never call this speculatively.';
      if (message.startsWith('No pending')) return `No pending synthesis proposal with id "${id}".`;
      if (message.includes('No branch available to apply.')) return 'No branch available to apply.';
      return `Error applying proposal: ${message.replace(/^Error applying synthesis proposal: /, '')}`;
    }

    const { branchMeta, written } = result;
    return `Applied branch "${branchMeta.strategy}" from proposal ${id} to ${record.sourceDir}.\n` +
      `Files written: ${written.join(', ') || '(none)'}\n` +
      `Files removed: ${branchMeta.filesRemoved.join(', ') || '(none)'}\n` +
      `Recommend running verify_project on ${record.sourceDir} now that it's the real tree.`;
  }

  async dismissProposal(id) {
    if (!this.gate.get(id)) return `No pending synthesis proposal with id "${id}".`;
    await this.gate.dismiss(id, proposal => this._cleanupBranchDirs(proposal));
    return `Discarded synthesis proposal ${id}. No files were touched in the real project tree.`;
  }
}

