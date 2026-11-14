// ── Self-Healer ───────────────────────────────────────────────────────────────
//
// Feature: "Close the loop — turn world_model from an observer into an
// autonomous fixer."
//
// world_model.js only ever detects drift and narrates it — perception with
// no action. This module is the missing wiring between three subsystems
// that already exist independently:
//
//   world_model  detects drift on a heal-enabled watch
//        │
//        ▼
//   swarm         auto-triggered with 3 scoped sub-agents: "what broke"
//                 (diagnose), "why" (root_cause), "candidate fix"
//                 (proposes concrete file edits as JSON)
//        │
//        ▼
//   builder       each candidate fix is verified in an ISOLATED SANDBOX
//                 copy of the real project — install, build, test — the
//                 real tree is never written to during this step
//        │
//        ▼
//   human gate    only a fix that actually verified clean is surfaced,
//                 held pending, and requires apply_verified_fix(fix_id,
//                 human_approved=true) — the exact same gating pattern
//                 agent.js already uses for mcp_add_server/plugin_install
//
// The result: instead of "I noticed your build broke" at the next prompt,
// the user opens their laptop to "your tests started failing at 3:14am, I
// diagnosed it as X, tried two fixes, this one passes — apply it?"
//
// HONEST LIMITS:
//   - Only "command" watches that were opted in via heal_project_dir (see
//     world_tools.js) trigger this loop — a plain file/dir/url watch just
//     narrates, same as before. This is deliberate: diagnosis + sandboxed
//     verification is expensive (a full swarm run plus a real install/
//     build/test cycle), so it only runs where a human explicitly asked
//     for it, on a target that's actually a real, buildable project.
//   - Every candidate fix's "files" are FULL replacement content (matching
//     write_file's semantics elsewhere in this codebase), not a diff
//     format — sub-agents don't have a diff tool, and full-content
//     replacement is easier to verify honestly (write it, build it, see
//     if it's green) than to reason about partial patches.
//   - Only MAX_CANDIDATES fixes are tried per drift event, and a per-watch
//     cooldown + "one unresolved pending fix at a time" rule stop a
//     flapping watch from spawning an unbounded pile of expensive swarm
//     runs. If nothing verifies, the diagnosis is still real work done —
//     it's just not surfaced as an applicable fix.

import chalk from 'chalk';
import { verifyCandidateFix, applyFilesToDir } from './builder.js';
import { ApprovalGate } from './approval_gate.js';

const MAX_PENDING_FIXES = 20;
const MAX_CANDIDATES    = 2;
const COOLDOWN_MS       = parseInt(process.env.HEAL_COOLDOWN_MS || '180000'); // 3 min between attempts per watch

function extractJSON(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json\n?|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up below */ } }
  return null;
}

const CANDIDATE_FIX_FOCUS =
  'Based on what the "diagnose" and "root_cause" facets of this investigation find, propose 1-2 concrete ' +
  'candidate fixes. Respond with ONLY a single JSON object — no markdown fences, no prose before or after — ' +
  'in exactly this shape: {"candidates":[{"description":"one-sentence summary of this candidate fix",' +
  '"files":{"relative/path/to/file.ext":"COMPLETE new content of that file"}}]}. Each entry under "files" ' +
  'must be the full replacement content of that file, not a diff fragment — read the file first with ' +
  'read_file so the replacement is complete and correct, not a guess. If genuinely no concrete fix can be ' +
  'formed from the investigation, respond with {"candidates":[]}.';

export class SelfHealer {
  /** @param {object} opts.swarm - the shared SwarmManager instance (src/core/swarm.js) */
  constructor({ swarm } = {}) {
    this.swarm = swarm;
    this.gate         = new ApprovalGate({ idPrefix: 'fix', kind: 'verified fix', maxPending: MAX_PENDING_FIXES });
    this.active       = new Set(); // watchId currently under investigation
    this.lastAttempt  = new Map(); // watchId -> timestamp of last heal attempt

    // Feature: self-healing out loud. Optional extension point, same shape
    // as world_model.js's onDrift/onConsolidate — set by agent.js to a
    // function(fixRecord) that speaks a line if a voice session is active.
    // Fire-and-forget by design (called from inside _run(), itself already
    // fire-and-forget from handleDrift) — a narration failure must never be
    // able to break the actual healing loop.
    this.onFixProposed = null;
  }

  // ── Trigger — wired as WorldModel.onDrift by agent.js ───────────────────────

  /** Fire-and-forget BY DESIGN: WorldModel's _recordEvent calls
   *  `this.onDrift(event)` synchronously inside a try/catch, without
   *  awaiting (see world_model.js) — so this must never throw, and any
   *  async work happens in the background via _run(). */
  handleDrift(event, watch, sharedContext) {
    this._run(event, watch, sharedContext).catch(err => {
      process.stdout.write(chalk.red(`\n  🔧 [healer] internal error investigating "${watch?.label}": ${err.message}\n`));
      if (watch?.id) this.active.delete(watch.id);
    });
  }

  async _run(event, watch, sharedContext) {
    if (!watch?.heal?.enabled || !watch.heal.projectDir) return; // not opted into healing
    if (event.type !== 'changed') return;                        // chase real drift only, not watch-check errors
    if (!this.swarm) return;
    if (this.active.has(watch.id)) return;                       // already investigating this watch
    if (this.gate.list().some(f => f.watchId === watch.id)) return; // unresolved fix already waiting
    const last = this.lastAttempt.get(watch.id);
    if (last && Date.now() - last < COOLDOWN_MS) return;          // don't hammer a flapping watch

    this.active.add(watch.id);
    this.lastAttempt.set(watch.id, Date.now());

    try {
      process.stdout.write(chalk.cyan(`\n  🔧 [healer] drift on "${watch.label}" — spawning diagnosis swarm…\n`));

      const task = `Drift detected on watch "${watch.label}" (${watch.kind}: ${watch.target}) in project ` +
        `directory ${watch.heal.projectDir}. What changed: ${event.summary}`;

      await this.swarm.run(task, [
        {
          role: 'diagnose',
          focus: 'Identify exactly what broke — reproduce or inspect the failure directly (re-run the ' +
            'failing command/tests if applicable) and pinpoint the specific error message, file, and location.',
          tools: ['bash_execute', 'read_file', 'list_directory'],
        },
        {
          role: 'root_cause',
          focus: 'Explain WHY this broke — trace it to the actual recent change (git log/diff, a dependency ' +
            'version, a config edit) rather than restating the symptom.',
          tools: ['bash_execute', 'read_file', 'list_directory'],
        },
        {
          role: 'candidate_fix',
          focus: CANDIDATE_FIX_FOCUS,
          tools: ['bash_execute', 'read_file', 'list_directory'],
        },
      ], { sharedContext, maxIterations: 8 });

      const results   = this.swarm.lastRun?.results || [];
      const diagnosis = results.find(r => r.role === 'diagnose');
      const rootCause = results.find(r => r.role === 'root_cause');
      const fixAgent  = results.find(r => r.role === 'candidate_fix');

      const parsed     = extractJSON(fixAgent?.findings);
      const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates.slice(0, MAX_CANDIDATES) : [];

      if (!candidates.length) {
        process.stdout.write(chalk.yellow(
          `  🔧 [healer] investigation finished but produced no concrete candidate fix for "${watch.label}" — diagnosis only.\n`
        ));
        return;
      }

      let verifiedCandidate = null;
      let verifiedReport    = null;
      let tried = 0;

      for (const candidate of candidates) {
        if (!candidate?.files || !Object.keys(candidate.files).length) continue;
        tried++;
        process.stdout.write(chalk.cyan(
          `  🔧 [healer] testing candidate fix ${tried}/${candidates.length} for "${watch.label}" in an isolated sandbox…\n`
        ));
        const report = await verifyCandidateFix({
          sourceDir: watch.heal.projectDir,
          stack: watch.heal.stack,
          files: candidate.files,
        });
        if (report.ok) { verifiedCandidate = candidate; verifiedReport = report; break; }
      }

      if (!verifiedCandidate) {
        process.stdout.write(chalk.yellow(
          `  🔧 [healer] tried ${tried} candidate fix(es) for "${watch.label}" — none verified clean. ` +
          `Diagnosis is available but no fix is being proposed.\n`
        ));
        return;
      }

      const proposed = this.gate.propose({
        watchId: watch.id,
        watchLabel: watch.label,
        projectDir: watch.heal.projectDir,
        description: verifiedCandidate.description || '(no description given)',
        files: verifiedCandidate.files,
        diagnosis: diagnosis?.findings || '',
        rootCause: rootCause?.findings || '',
        verificationSummary: verifiedReport.verification?.summary || '',
        candidatesTried: tried,
      });

      process.stdout.write(
        chalk.green(`\n  ✅ [healer] verified fix ready for "${watch.label}" `) +
        chalk.gray(`(tried ${tried} candidate${tried > 1 ? 's' : ''}) — `) +
        chalk.white(`apply_verified_fix(fix_id="${proposed.id}") once approved, or dismiss_verified_fix to discard.\n`)
      );

      if (typeof this.onFixProposed === 'function') {
        try { this.onFixProposed(proposed); } catch { /* narration must never break the healing loop */ }
      }
    } finally {
      this.active.delete(watch.id);
    }
  }

  // ── Human-gated apply / dismiss ─────────────────────────────────────────────

  /** HARD RULE — same pattern as mcp_add_server/plugin_install in agent.js:
   *  only ever call with human_approved=true after the human has explicitly
   *  agreed to the exact diagnosis + candidate fix shown to them in chat. */
  async applyFix(fixId, humanApproved) {
    const { ok, message, result, record } = await this.gate.apply(fixId, humanApproved, async fix => {
      return applyFilesToDir(fix.projectDir, fix.files);
    });
    if (!ok) return message;
    return `Applied verified fix [${fixId}] to ${result.length} file(s) in ${record.projectDir}: ` +
      `${result.join(', ')}. Recommend running verify_project on the real tree to confirm, then committing.`;
  }

  dismissFix(fixId) {
    return this.gate.dismiss(fixId);
  }

  listPending() {
    return this.gate.list();
  }

  // ── System-prompt context ───────────────────────────────────────────────────

  getContext() {
    return this.gate.getContext(f =>
      `[${f.id}] "${f.watchLabel}": ${f.description} — passed sandbox verification ` +
      `(tried ${f.candidatesTried} candidate${f.candidatesTried > 1 ? 's' : ''}). ` +
      `Files: ${Object.keys(f.files).join(', ')}. ` +
      `Call apply_verified_fix(fix_id="${f.id}", human_approved=true) only once the human explicitly ` +
      `agrees, or dismiss_verified_fix(fix_id="${f.id}") to discard.`
    );
  }
}

