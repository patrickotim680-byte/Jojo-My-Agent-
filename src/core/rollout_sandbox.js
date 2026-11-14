// ── Rollout Sandbox ──────────────────────────────────────────────────────────
//
// Feature: "Simulate the action before committing to it — for real."
//
// Every other layer in this codebase that reasons about a risky action does
// so in TEXT: reasoning.js's plan → critique → refine is three hidden model
// calls, never an execution. browser.js's dry-run reads a form's current
// field values without submitting it. deploy.js's prepareDeployment() runs a
// generic build/test pass, not the actual deploy command. That's a real
// improvement over "no check at all," but it's still a guess dressed up as
// diligence — the same "think, then act, then hope" shape as any other
// agent, just with an extra thinking step.
//
// healer.js already does better than that, but only for one call site: a
// self-heal candidate fix is copied into a throwaway directory, ACTUALLY
// installed/built/tested inside a Docker sandbox (see builder.js's
// verifyCandidateFix + core/sandbox.js), and only a fix that genuinely
// passed is ever surfaced. This module generalizes that exact pattern —
// snapshot → real execution in a throwaway fork → diff predicted vs actual →
// (for multiple candidates) parallel forks scored against each other, the
// same way swarm.js runs parallel sub-agents and arbitrates their findings —
// into a first-class layer any risky tool call can go through, not just
// self-heal fixes:
//
//   project_action   generalizes healer.js/builder.js's own pattern to ANY
//                    file-rewrite-and/or-verify action ("multi-file
//                    rewrite" in the upgrade brief this shipped from) — copy
//                    the real project dir into a throwaway temp dir, apply
//                    the candidate's file edits there (if any), run the
//                    real install/build/test pipeline (or a custom command)
//                    INSIDE a Docker sandbox against the copy, never the
//                    real tree. Reuses builder.js's runVerification /
//                    applyFilesToDir directly — no logic duplicated.
//
//   deploy_preview   generalizes apply_deployment: runs deploy.js's own
//                    prepareDeployment() with environment FORCED to
//                    'preview' — a real, disposable deploy against a
//                    throwaway URL — and hands back what actually happened
//                    (did it build, did it deploy, what URL, what output),
//                    instead of only the generic build/test pass
//                    prepareDeployment() does today for a production plan.
//                    Committing chains into deploy.js's OWN, UNMODIFIED
//                    production gate — this never bypasses apply_deployment.
//
//   world_watch      generalizes world_watch_add: runs the exact real check
//                    (file stat / dir listing / shell command / URL fetch /
//                    MCP resource read) a live watch would run, once, before
//                    ever registering the recurring watch — see
//                    WorldModel.previewWatch(). No Docker fork needed here:
//                    the target is external, so "run it for real" just
//                    means doing the real check now instead of only after
//                    committing to a schedule.
//
//   browser_action   generalizes apply_browser_action ("an outbound reply"
//                    in the upgrade brief): forks a NEW, isolated browser
//                    session carrying the SAME storage state (cookies/login)
//                    as the live one, and actually performs the classified-
//                    irreversible action there — not a dry-run field read,
//                    the real click/fill/select — then dual-ground-reads the
//                    REAL resulting page. See HONEST LIMITS: unlike the
//                    other three kinds, this one is NOT a free trial (a real
//                    website has no throwaway copy of itself), so simulating
//                    this kind requires human_approved=true UP FRONT, same
//                    as apply_browser_action requires it today.
//
// For N>1 candidates, every fork runs in parallel (Promise.allSettled, one
// hanging/erroring candidate never blocks the rest — same shape as
// swarm.js's _runSubAgent), and — once every real outcome is in — a single
// hidden model call scores the ACTUAL results against each other and ranks
// them, explicitly flagging tradeoffs/disagreement the same way swarm.js's
// _arbitrate reconciles parallel findings, except this is scoring what
// really happened, not merging what was said.
//
// Nothing here auto-commits. simulate() only ever produces a pending rollout
// record — same human-approval-gated pattern as apply_verified_fix /
// apply_synthesis_proposal / apply_deployment / apply_browser_action.
// applyRollout() is what actually commits the winning (or explicitly chosen)
// candidate for real against the LIVE target.
//
// HONEST LIMITS:
//   - This is a layer OVER the existing gates, not a replacement for them.
//     Committing a project_action rollout still just calls applyFilesToDir
//     against the real tree; committing a deploy_preview rollout still
//     funnels into deploy.js's own prepareDeployment(environment:
//     'production') → apply_deployment(human_approved=true) gate, untouched.
//     Nothing here grants itself a shortcut around a safeguard that already
//     exists elsewhere in this codebase.
//   - Forking is only genuinely free/reversible for project_action,
//     world_watch, and (per deploy.js's own classification) most
//     deploy_preview candidates. It is NOT free for browser_action: a real
//     website has no throwaway copy of itself, so "forking" it only
//     isolates JOJO'S OWN session/process boundary, not the target server's
//     view of what happened. If the classified action is something like a
//     real form submission, executing the fork IS the real, one-time side
//     effect — see the class-level HARD RULE on human_approved for this kind.
//   - fly.io deploys have no distinct preview mode (see deploy.js) — a
//     deploy_preview candidate targeting provider "fly" cannot be forked for
//     free either; this is reported plainly (pending:true, nothing executed)
//     rather than silently treated as a successful trial.
//   - Scoring parallel candidates is one hidden model call over STRUCTURED
//     real outcomes (verification reports, deploy records, page reads) —
//     much less room to hallucinate than judging prose plans, but still a
//     model call, not a proof. Treat the ranking as a strong recommendation,
//     not a guarantee, same caveat as swarm.js's arbitration.
//   - fileDiff() below is a plain line-count delta per file, not a real
//     unified diff — good enough to see the shape of a change at a glance,
//     not a substitute for read_file on the actual candidate content.

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import chalk from 'chalk';
import { runVerification, applyFilesToDir } from './builder.js';
import { getProjectSandbox } from './sandbox.js';
import { DEFAULT_MODEL } from './puter_client.js';

const MAX_CANDIDATES        = 4; // lower than swarm.js's MAX_AGENTS=6 — each candidate here can run a full Docker build, a real deploy, or a real browser action, not just an LLM call
const DEFAULT_TIMEOUT_MS    = parseInt(process.env.ROLLOUT_TIMEOUT_MS || '240000'); // 4 min/candidate
const MAX_PENDING_ROLLOUTS  = 20;
const SANDBOX_EXCLUDE       = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.cache']);

// Per-kind metadata. requiresApprovalToSimulate=true means this kind has no
// genuinely free/reversible fork (see HONEST LIMITS) — simulate() itself
// enforces human_approved=true for these BEFORE running anything, the exact
// same gate apply_browser_action already enforces for the same action.
const ADAPTER_META = {
  project_action: { label: 'project file-change / build-verify action', requiresApprovalToSimulate: false },
  deploy_preview: { label: 'deployment (run as a real preview probe)',   requiresApprovalToSimulate: false },
  world_watch:    { label: 'world-model watch (previewed before adding)', requiresApprovalToSimulate: false },
  browser_action: { label: 'browser action (outbound reply / form submit / etc)', requiresApprovalToSimulate: true },
};

function uid(prefix = 'rollout') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Candidate "${label}" timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function truncate(s, n = 2000) {
  s = String(s || '');
  if (s.length <= n) return s;
  return `${s.slice(0, Math.floor(n * 0.7))}\n… [truncated ${s.length - n} chars] …\n${s.slice(-Math.floor(n * 0.25))}`;
}

async function copyProjectDir(sourceDir, destDir) {
  await fs.cp(sourceDir, destDir, { recursive: true, filter: (src) => !SANDBOX_EXCLUDE.has(path.basename(src)) });
}

/** Plain line-count delta per file — see HONEST LIMITS: this is deliberately
 *  NOT a real unified diff, just enough to see the shape of a change. */
async function fileDiffs(sourceDir, files) {
  const out = [];
  for (const [rel, newContent] of Object.entries(files || {})) {
    const full = path.join(sourceDir, rel);
    let before = null;
    try { before = await fs.readFile(full, 'utf-8'); } catch { /* new file */ }
    const linesBefore = before == null ? 0 : before.split('\n').length;
    const linesAfter  = String(newContent).split('\n').length;
    out.push({
      path: rel, existed: before != null,
      linesBefore, linesAfter, lineDelta: linesAfter - linesBefore,
    });
  }
  return out;
}

export class RolloutSandbox {
  /** @param {object} [opts.genAI] - PuterAI-shaped client, used ONLY for the
   *  cross-candidate scoring pass (see _score) when 2+ candidates succeed.
   *  Everything else this engine touches (deploy, worldModel, browser) is
   *  reached per-call via the shared tool context, not stored here — same
   *  reasoning as SwarmManager taking sharedContext per-call rather than
   *  holding every possible collaborator in its own constructor. */
  constructor({ genAI } = {}) {
    this.genAI = genAI || null;
    this.pending = new Map(); // rolloutId -> record
  }

  // ── Public entry point ─────────────────────────────────────────────────────

  /**
   * @param {string} label          - what this rollout is trying to determine, e.g. "auth refactor across 3 files".
   * @param {string} action_kind    - one of: project_action | deploy_preview | world_watch | browser_action
   * @param {object[]} candidates   - 1-4 candidate argument sets for that kind (see per-kind adapter for fields).
   * @param {boolean} [human_approved] - REQUIRED (must be true) when action_kind is browser_action — see HONEST LIMITS.
   * @param {object} context        - the normal shared tool context (deploy/worldModel/browser/etc), forwarded from the tool layer.
   */
  async simulate({ label, action_kind, candidates, human_approved, context } = {}) {
    if (!label || !String(label).trim()) return { ok: false, error: 'label is required.' };
    const meta = ADAPTER_META[action_kind];
    if (!meta) return { ok: false, error: `Unknown action_kind "${action_kind}". Use: ${Object.keys(ADAPTER_META).join(', ')}.` };
    if (!Array.isArray(candidates) || !candidates.length) {
      return { ok: false, error: 'candidates must be a non-empty array (1-4 argument sets to try).' };
    }
    if (meta.requiresApprovalToSimulate && !human_approved) {
      return {
        ok: false,
        error: `Refused: action_kind "${action_kind}" has no free/reversible fork — a real website has no ` +
          `throwaway copy of itself, so running this candidate for real IS the real action (see rollout_sandbox.js ` +
          `HONEST LIMITS). Show the human what this candidate would do first, and only call simulate_rollout with ` +
          `human_approved=true after they explicitly agree — same rule as apply_browser_action.`,
      };
    }

    const bounded = candidates.slice(0, MAX_CANDIDATES);
    if (candidates.length > MAX_CANDIDATES) {
      process.stdout.write(chalk.yellow(`  [rollout] capped at ${MAX_CANDIDATES} candidates (${candidates.length} requested)\n`));
    }

    process.stdout.write(chalk.cyan(
      `\n  🧪 [rollout] "${label}" — running ${bounded.length} candidate(s) for real (${meta.label})…\n`
    ));

    const settled = await Promise.allSettled(
      bounded.map((c, i) => withTimeout(this._runCandidate(action_kind, c, i, context), DEFAULT_TIMEOUT_MS, `candidate_${i + 1}`))
    );

    const results = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      return { index: i, ok: false, error: s.reason?.message || String(s.reason), description: bounded[i].description };
    });

    results.forEach(r => {
      const line = r.ok ? chalk.green(`  🧪 [rollout:${r.index + 1}] ran clean — ${truncate(r.actualSummary, 90)}`)
                         : chalk.red(`  🧪 [rollout:${r.index + 1}] failed — ${truncate(r.error || r.actualSummary, 90)}`);
      process.stdout.write(line + '\n');
    });

    let scoring = null;
    if (results.filter(r => r.ok).length > 1) {
      process.stdout.write(chalk.cyan(`  🧪 [rollout] scoring ${results.length} real outcomes against each other…\n`));
      scoring = await this._score(label, results).catch(() => null);
    }

    if (this.pending.size >= MAX_PENDING_ROLLOUTS) {
      const oldest = this.pending.keys().next().value;
      this.pending.delete(oldest);
    }

    const rolloutId = uid();
    const record = {
      id: rolloutId, label, actionKind: action_kind, candidates: bounded,
      results, scoring, createdAt: new Date().toISOString(),
      alreadyExecuted: action_kind === 'browser_action', // see HONEST LIMITS — nothing left to "commit" for this kind
    };
    this.pending.set(rolloutId, record);

    return { ok: true, rolloutId, ...record, report: this._format(record) };
  }

  async _runCandidate(action_kind, candidate, index, context) {
    const started = Date.now();
    let out;
    switch (action_kind) {
      case 'project_action': out = await this._forkProjectAction(candidate, context); break;
      case 'deploy_preview': out = await this._forkDeployPreview(candidate, context); break;
      case 'world_watch':    out = await this._forkWorldWatch(candidate, context);    break;
      case 'browser_action': out = await this._forkBrowserAction(candidate, context); break;
      default: throw new Error(`No adapter for action_kind "${action_kind}".`);
    }
    return {
      index, description: candidate.description || null, predicted: candidate.predicted_outcome || null,
      durationMs: Date.now() - started, ...out,
    };
  }

  // ── Adapter: project_action (generalizes healer.js/builder.js) ─────────────
  // candidate: { project_dir, files？:{relPath:content}, command？:string, stack？:string }
  async _forkProjectAction(candidate, _context) {
    const { project_dir, files, command, stack } = candidate;
    if (!project_dir) return { ok: false, error: 'project_dir is required for action_kind "project_action".' };
    try { await fs.access(project_dir); } catch { return { ok: false, error: `project_dir "${project_dir}" does not exist.` }; }
    if (!files && !command) return { ok: false, error: 'Provide at least one of files or command to actually try something.' };

    const tempDir = path.join(os.tmpdir(), `jojo-rollout-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
    try {
      await copyProjectDir(project_dir, tempDir);
      if (files && Object.keys(files).length) await applyFilesToDir(tempDir, files);

      const verification = await runVerification({
        targetDir: tempDir,
        stack,
        customSteps: command ? [{ name: 'candidate_action', cmd: command, required: true }] : undefined,
        sandbox: true,
      });

      const diffs = files ? await fileDiffs(project_dir, files) : undefined;
      const lastStep = verification.steps?.[verification.steps.length - 1];

      return {
        ok: !!verification.ok,
        actualSummary: verification.summary || verification.error || '(no summary)',
        steps: (verification.steps || []).map(s => ({ name: s.name, ok: s.ok, durationMs: s.durationMs, output: truncate(s.output, 800) })),
        fileDiffs: diffs,
        rawOutputTail: truncate(lastStep?.output),
        detectedStack: verification.stack,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async _commitProjectAction(candidate) {
    const { project_dir, files, command } = candidate;
    const written = files && Object.keys(files).length ? await applyFilesToDir(project_dir, files) : [];
    let commandResult = null;
    if (command) {
      const sbx = await getProjectSandbox(project_dir);
      commandResult = await sbx.exec(command);
    }
    return `Applied to REAL project dir ${project_dir}: ${written.length ? `wrote ${written.join(', ')}` : '(no file changes)'}` +
      `${command ? `; ran real command — ${commandResult.ok ? 'succeeded' : 'FAILED'}: ${truncate(commandResult.output, 500)}` : ''}.`;
  }

  // ── Adapter: deploy_preview (generalizes apply_deployment) ──────────────────
  // candidate: { project_dir, provider, options？:object, stack？:string }
  async _forkDeployPreview(candidate, context) {
    if (!context?.deploy) return { ok: false, error: 'Deploy engine unavailable in this context.' };
    const { project_dir, provider, options, stack } = candidate;
    if (!project_dir || !provider) return { ok: false, error: 'project_dir and provider are required for action_kind "deploy_preview".' };

    const result = await context.deploy.prepareDeployment({
      dir: project_dir, provider, environment: 'preview',
      task: `rollout candidate preview (${provider})`, stack, options: options || {},
    });

    if (result.pending) {
      // No free preview exists for this provider (e.g. fly.io — see deploy.js
      // HONEST LIMITS). Say so plainly rather than treating "got queued as a
      // gated production plan" as if a trial had actually run.
      return {
        ok: false,
        actualSummary: `No reversible preview exists for provider "${provider}" — prepareDeployment queued this ` +
          `as a gated production plan (${result.planId}) instead of executing anything. Nothing was run.`,
        pending: true, planId: result.planId,
      };
    }
    if (!result.ok) {
      return { ok: false, error: result.error || 'prepareDeployment failed.', verification: result.verification };
    }
    return {
      ok: result.result?.ok !== false,
      actualSummary: `Real preview deploy executed via ${provider}${result.result?.url ? ` — ${result.result.url}` : ''}.`,
      url: result.result?.url || null,
      rawOutputTail: truncate(result.result?.rawOutputTail),
      verification: result.plan?.verificationSummary,
    };
  }

  async _commitDeployPreview(candidate, rolloutId, context) {
    if (!context?.deploy) return 'Deploy engine unavailable in this context.';
    const { project_dir, provider, options, stack } = candidate;
    const result = await context.deploy.prepareDeployment({
      dir: project_dir, provider, environment: 'production',
      task: `promoted from rollout ${rolloutId} — preview already executed and verified for real`,
      stack, options: options || {},
    });
    if (result.pending) {
      return `Preview evidence looked good — prepareDeployment has queued a PRODUCTION plan [${result.planId}], ` +
        `still requiring its own separate apply_deployment(plan_id, human_approved=true). This does not deploy ` +
        `to production by itself.\n\n${result.summary}`;
    }
    // environment:'production' is ALWAYS classified production-risk by deploy.js's own
    // _isProductionRisk (true for every provider once environment==='production', not just
    // fly) — so result.pending is unreachable-false here except when prepareDeployment
    // failed outright (bad dir, missing/unauthenticated CLI, or the production build/test
    // gate itself failing). Report that honestly rather than implying something ran.
    return `Could not queue a production plan for provider "${provider}": ${result.error || 'unknown error'}` +
      `${result.verification ? `\n${JSON.stringify(result.verification)}` : ''}`;
  }

  // ── Adapter: world_watch (generalizes world_watch_add) ──────────────────────
  // candidate: { watch_kind, watch_target, watch_label？, watch_interval_seconds？, watch_heal_project_dir？, watch_heal_stack？ }
  async _forkWorldWatch(candidate, context) {
    if (!context?.worldModel) return { ok: false, error: 'World model unavailable in this context.' };
    const { watch_kind, watch_target } = candidate;
    if (!watch_kind || !watch_target) return { ok: false, error: 'watch_kind and watch_target are required for action_kind "world_watch".' };
    const preview = await context.worldModel.previewWatch({ kind: watch_kind, target: watch_target });
    return {
      ok: preview.ok,
      actualSummary: preview.ok ? preview.summary : preview.error,
      rawOutputTail: preview.ok ? preview.summary : preview.error,
    };
  }

  async _commitWorldWatch(candidate, context) {
    if (!context?.worldModel) return 'World model unavailable in this context.';
    const { watch_kind, watch_target, watch_label, watch_interval_seconds, watch_heal_project_dir, watch_heal_stack } = candidate;
    const w = await context.worldModel.addWatch({
      kind: watch_kind, target: watch_target, label: watch_label,
      intervalMs: watch_interval_seconds ? watch_interval_seconds * 1000 : undefined,
      heal: watch_heal_project_dir ? { projectDir: watch_heal_project_dir, stack: watch_heal_stack } : undefined,
    });
    return `Now watching [${w.id}] "${w.label}" (${w.kind}) every ${Math.round(w.intervalMs / 1000)}s — already previewed for real before this call.`;
  }

  // ── Adapter: browser_action (generalizes apply_browser_action) ─────────────
  // candidate: { approval_id } — an EXISTING pending irreversible action from
  // a prior browser_act() call. Reuses browser.js's own target-resolution and
  // execute() primitives rather than re-implementing classification/heal.
  async _forkBrowserAction(candidate, context) {
    if (!context?.browser) return { ok: false, error: 'Browser engine unavailable in this context.' };
    const { approval_id } = candidate;
    if (!approval_id) return { ok: false, error: 'approval_id is required for action_kind "browser_action" — get one from a prior browser_act() call.' };
    const pending = context.browser.pendingActions.get(approval_id);
    if (!pending) return { ok: false, error: `No pending browser action with id "${approval_id}". Call browser_act first.` };

    let forkSessionId = null;
    try {
      const live = context.browser._session(pending.sessionId);
      const liveState = await live.context.storageState().catch(() => undefined);
      forkSessionId = await context.browser.openSession(live.url, { storageState: liveState });
      const forkSession = context.browser._session(forkSessionId);

      const { element } = await context.browser._resolveTarget(forkSessionId, {
        role: pending.element.role, name: pending.element.name,
        logicalName: `${pending.element.role} ${pending.element.name}`.trim(),
      });
      const executed = await context.browser._execute(forkSession.page, element, pending.action);
      const after = await context.browser.extract(forkSessionId, { focus: 'confirmation message, error message, or anything indicating the result of the action just taken' }).catch(err => ({ visionSummary: `(could not re-read page: ${err.message})` }));

      // The original pending approval is now moot — the action actually
      // happened, just via the fork rather than the live session.
      context.browser.pendingActions.delete(approval_id);

      return {
        ok: true,
        actualSummary: `Executed for real in an isolated fork session (${forkSessionId}, same login state as the ` +
          `live session): ${executed}. Resulting page: ${truncate(after.visionSummary, 400)}`,
        rawOutputTail: truncate(after.visionSummary, 800),
        forkSessionId,
        note: 'This was the real action, performed once — not a free trial (see HONEST LIMITS). The fork session ' +
          'is left open for further inspection; browser_close_session it when done.',
      };
    } catch (err) {
      return { ok: false, error: err.message, forkSessionId };
    }
  }

  async _commitBrowserAction(record) {
    // alreadyExecuted=true for this kind — see simulate(). Nothing left to
    // do except acknowledge it plainly; there is no un-simulated version of
    // this action still waiting to run for real.
    return 'Nothing further to commit — the browser action already ran for real during simulate_rollout ' +
      `(this kind requires human_approved up front for exactly that reason). Rollout [${record.id}] closed out.`;
  }

  // ── Scoring pass — same shape as swarm.js's _arbitrate, over real outcomes ──
  async _score(label, results) {
    if (!this.genAI) return null;
    const block = results.map(r =>
      `### Candidate ${r.index + 1}${r.ok ? '' : ' [FAILED]'}\n` +
      `${r.description ? `Description: ${r.description}\n` : ''}` +
      `${r.predicted ? `Predicted outcome: ${r.predicted}\n` : ''}` +
      `Actual outcome: ${r.actualSummary || r.error || '(none)'}`
    ).join('\n\n');

    const prompt = `You are scoring ${results.length} candidate approaches to the same action: "${label}". These ` +
      `are NOT proposals or plans — every candidate has ALREADY BEEN EXECUTED FOR REAL, and what follows is what ` +
      `actually happened, not what was predicted.\n\n${block.slice(0, 6000)}\n\n` +
      `Respond ONLY with valid JSON, no markdown fences:\n` +
      `{"ranking":[{"candidate":1,"verdict":"short verdict grounded in what actually happened"}],` +
      `"best_candidate":1,"tradeoffs":["a real tradeoff between candidates, if any — omit array entries if none"],` +
      `"disagreement_notes":["something one candidate's real outcome shows that another's contradicts, if any"]}`;

    try {
      const model = this.genAI.getGenerativeModel({
        model: process.env.PUTER_MODEL || DEFAULT_MODEL,
        generationConfig: { temperature: 0.15, maxOutputTokens: 900 },
      });
      const result = await model.generateContent(prompt);
      const text = (result.response.text() || '').trim().replace(/```json\n?|```/g, '').trim();
      try { return JSON.parse(text); }
      catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        return null;
      }
    } catch {
      return null; // fail open — the report still shows every real outcome, just unranked
    }
  }

  _format(record) {
    const { label, actionKind, results, scoring } = record;
    const lines = [`Rollout "${label}" (${actionKind}) — ran ${results.length} candidate(s) for real:`, ''];
    results.forEach(r => {
      lines.push(`── Candidate ${r.index + 1}${r.description ? `: ${r.description}` : ''} ${r.ok ? '✅ ran clean' : '❌ failed'} ──`);
      if (r.predicted) lines.push(`Predicted: ${r.predicted}`);
      lines.push(`Actual: ${r.actualSummary || r.error || '(no summary)'}`);
      if (r.fileDiffs?.length) {
        lines.push('File diffs (line-count delta, not a full diff):');
        r.fileDiffs.forEach(d => lines.push(`  ${d.path}: ${d.existed ? `${d.linesBefore}→${d.linesAfter} lines (${d.lineDelta >= 0 ? '+' : ''}${d.lineDelta})` : `new file, ${d.linesAfter} lines`}`));
      }
      lines.push('');
    });
    if (scoring) {
      lines.push('── Scoring (real outcomes ranked against each other) ──');
      (scoring.ranking || []).forEach(r => lines.push(`  Candidate ${r.candidate}: ${r.verdict}`));
      if (scoring.best_candidate) lines.push(`Best: Candidate ${scoring.best_candidate}`);
      if (scoring.tradeoffs?.length) { lines.push('', 'Tradeoffs:'); scoring.tradeoffs.forEach(t => lines.push(`  • ${t}`)); }
      if (scoring.disagreement_notes?.length) { lines.push('', '⚠ Disagreement between candidates:'); scoring.disagreement_notes.forEach(d => lines.push(`  • ${d}`)); }
    } else if (results.length > 1) {
      lines.push('(scoring pass unavailable — showing raw per-candidate outcomes above, unranked)');
    }
    lines.push('', record.alreadyExecuted
      ? 'This action already ran for real above — call apply_rollout to close it out, or dismiss_rollout (note: cannot undo an external side effect).'
      : `Nothing was applied to the real target yet. Call apply_rollout(rollout_id="${record.id}", human_approved=true) to commit ` +
        `the winning (or an explicitly chosen) candidate for real, or dismiss_rollout to discard.`);
    return lines.join('\n');
  }

  // ── Human-gated apply / dismiss ─────────────────────────────────────────────

  /** HARD RULE, same pattern as every other apply_* tool in this codebase:
   *  only ever call with human_approved=true after the human has explicitly
   *  agreed to the exact report shown to them. */
  async applyRollout(rolloutId, humanApproved, candidateIndex, context) {
    if (!humanApproved) {
      return 'Refused: human_approved must be true. Show the human the rollout report (every candidate\'s real ' +
        'outcome, and the scoring if there were several) first, and only call this after they explicitly agree.';
    }
    const record = this.pending.get(rolloutId);
    if (!record) return `No pending rollout with id "${rolloutId}".`;

    const idx = Number.isInteger(candidateIndex) ? candidateIndex - 1
      : (record.scoring?.best_candidate ? record.scoring.best_candidate - 1
      : record.results.findIndex(r => r.ok));
    const candidate = record.candidates[idx];
    const chosenResult = record.results[idx];
    if (!candidate || !chosenResult?.ok) {
      return `Can't apply rollout [${rolloutId}] — no successful candidate at that index. Successful candidates: ` +
        `${record.results.map((r, i) => r.ok ? i + 1 : null).filter(Boolean).join(', ') || '(none)'}.`;
    }

    try {
      let outcome;
      switch (record.actionKind) {
        case 'project_action': outcome = await this._commitProjectAction(candidate); break;
        case 'deploy_preview': outcome = await this._commitDeployPreview(candidate, rolloutId, context); break;
        case 'world_watch':    outcome = await this._commitWorldWatch(candidate, context); break;
        case 'browser_action': outcome = await this._commitBrowserAction(record); break;
        default: return `No commit path for action_kind "${record.actionKind}".`;
      }
      this.pending.delete(rolloutId);
      return `Applied rollout [${rolloutId}], candidate ${idx + 1}: ${outcome}`;
    } catch (err) {
      return `Error applying rollout: ${err.message}`;
    }
  }

  dismissRollout(rolloutId) {
    const record = this.pending.get(rolloutId);
    if (!record) return `No pending rollout with id "${rolloutId}".`;
    this.pending.delete(rolloutId);
    if (record.alreadyExecuted) {
      return `Discarded rollout [${rolloutId}]'s report — note: this does NOT undo the real action already taken ` +
        `during simulate_rollout (see HONEST LIMITS on action_kind "browser_action").`;
    }
    return `Discarded rollout [${rolloutId}]. Nothing was ever applied to the real target.`;
  }

  listPending() {
    return [...this.pending.values()];
  }

  getContext() {
    if (!this.pending.size) return '(no pending rollouts)';
    const lines = [`${this.pending.size} rollout(s) awaiting a decision:`];
    for (const r of this.pending.values()) {
      const okCount = r.results.filter(x => x.ok).length;
      lines.push(
        `  - [${r.id}] "${r.label}" (${r.actionKind}) — ${okCount}/${r.results.length} candidate(s) ran clean` +
        `${r.scoring?.best_candidate ? `, best: candidate ${r.scoring.best_candidate}` : ''}. ` +
        `${r.alreadyExecuted ? 'Already executed for real — ' : ''}` +
        `Call apply_rollout(rollout_id="${r.id}", human_approved=true) once approved, or dismiss_rollout to discard.`
      );
    }
    return lines.join('\n');
  }
}

