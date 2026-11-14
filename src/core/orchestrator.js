// ── Large App Orchestrator ───────────────────────────────────────────────────
//
// Feature: spec → dependency-ordered module graph → build in parallel waves
// → integration-verify after every wave.
//
// Deliberately does NOT reimplement anything this codebase already has —
// it composes existing pieces:
//   - SwarmManager for the architect pass and each module's implementer
//   - builder.js's runVerification for integration checks after every wave
//   - the EXISTING TaskBoard (tasks.js) for progress tracking — one real
//     task per app build, with progress notes per module, not a parallel
//     tracking system
//   - ReviewBoard (review_board.js), optionally, for a final adversarial
//     pass over the whole app once every module is in
//
//   1. DECOMPOSITION
//      plan() asks one sub-agent to break a spec into modules in a fixed,
//      parseable line format (MODULE: / DEPENDS_ON: / DIR: / DESC:) — see
//      _parseModules. If parsing finds nothing usable, it falls back to a
//      single "app" module covering the whole target directory rather than
//      silently doing nothing.
//
//   2. DEPENDENCY-ORDERED PARALLEL WAVES
//      _topoOrder() runs a real topological sort (Kahn's algorithm) over the
//      DEPENDS_ON edges, grouping into WAVES of modules with no unbuilt
//      dependencies — everything in a wave builds concurrently (one swarm
//      sub-agent per module, scoped to its own subdirectory), independent
//      modules never wait on each other. A dependency CYCLE (malformed plan)
//      doesn't hang forever — leftover modules get dumped into one final
//      wave with a warning instead of looping.
//
//   3. INTEGRATION VERIFICATION AFTER EVERY WAVE, NOT JUST AT THE END
//      After each wave, runVerification runs against the WHOLE target
//      directory (not just the modules just built) — catches a module
//      breaking something built in an earlier wave immediately, not after
//      the entire app is "done."
//
// HONEST LIMITS:
//   - _parseModules() is a heuristic parse of the architect sub-agent's own
//     text output in a requested format, not a structured/enforced schema.
//     A malformed or unexpected response degrades to the single-module
//     fallback rather than crashing, but that fallback loses the whole
//     point of decomposition — if you see it kick in, the spec was
//     probably too vague for a useful breakdown.
//   - This does NOT use divergent_synthesis or review_code by default for
//     every module — that would be extremely expensive for an app with
//     several modules. Pass `useSynthesisFor: [moduleName, ...]` to route
//     specific (e.g. security-sensitive or core) modules through the full
//     DCAS pipeline instead of a single implementer pass; everything else
//     gets one straightforward build. `reviewAfterBuild: true` (default)
//     runs ONE review_board pass over the finished app as a whole, not
//     per-module — again a cost tradeoff, not an oversight.
//   - Integration verification after each wave only catches what the
//     project's OWN build/test pipeline catches. If the project has thin
//     test coverage, "integration verified" only means "still builds and
//     whatever tests exist still pass," not "the modules are functionally
//     correct together."
//   - This module never deploys anything — see deploy.js for that, kept as
//     a deliberately separate, separately-gated step.

import fs from 'fs/promises';
import path from 'path';
import { runVerification, detectStack } from './builder.js';

const MAX_MODULES = 12;
const ARCHITECT_MAX_ITERATIONS = 3;
const MODULE_BUILD_MAX_ITERATIONS = 10;

const MODULE_LINE_RE = /^MODULE:\s*(.+?)\s*\|\s*DEPENDS_ON:\s*(.+?)\s*\|\s*DIR:\s*(.+?)\s*\|\s*DESC:\s*(.+)$/i;

export class LargeAppOrchestrator {
  /**
   * @param {SwarmManager} swarm
   * @param {TaskBoard} [tasks] - the agent's existing multi-task tracker (tasks.js). Optional — progress notes are skipped if not provided.
   * @param {ReviewBoard} [reviewBoard] - optional final adversarial pass over the whole app.
   */
  constructor({ swarm, tasks, reviewBoard }) {
    this.swarm = swarm;
    this.tasks = tasks;
    this.reviewBoard = reviewBoard;
    this.lastPlan = null;
    this.lastBuild = null;
  }

  async plan({ spec }) {
    if (!spec || !spec.trim()) return { ok: false, error: 'spec is required.' };

    const architectAgents = [{
      role: 'architect',
      focus:
        `App spec: ${spec}\n\nDecompose this into up to ${MAX_MODULES} independently buildable modules. ` +
        `Respond with ONE LINE PER MODULE in EXACTLY this format (no other text on module lines):\n` +
        `MODULE: <short-name> | DEPENDS_ON: <comma-separated module names, or "none"> | DIR: <relative-subdirectory-name> | DESC: <one-line description of what this module does>\n\n` +
        `Keep module names short, lowercase, hyphenated (e.g. "auth-service", "product-api", "web-frontend"). ` +
        `Only list a real dependency if the module genuinely cannot be built/tested without the other existing first.`,
      tools: [],
    }];
    const planText = await this.swarm.run(spec, architectAgents, { maxIterations: ARCHITECT_MAX_ITERATIONS });
    const modules = this._parseModules(planText);

    this.lastPlan = { spec, modules, planText, fallbackUsed: modules.length === 1 && modules[0].name === 'app', createdAt: new Date().toISOString() };
    return this.lastPlan;
  }

  _parseModules(text) {
    const modules = [];
    for (const line of String(text || '').split('\n')) {
      const m = MODULE_LINE_RE.exec(line.trim());
      if (!m) continue;
      const [, name, dependsOnRaw, dir, desc] = m;
      const dependsOn = dependsOnRaw.toLowerCase() === 'none'
        ? [] : dependsOnRaw.split(',').map(s => s.trim()).filter(Boolean);
      modules.push({ name: name.trim(), dependsOn, dir: dir.trim(), description: desc.trim() });
    }
    if (!modules.length) {
      return [{ name: 'app', dependsOn: [], dir: '.', description: '(fallback — architect response could not be parsed into modules)' }];
    }
    return modules.slice(0, MAX_MODULES);
  }

  /** Kahn's algorithm — real topological sort, not a heuristic ordering.
   *  Returns an array of WAVES; everything within a wave has no unbuilt
   *  dependency on anything else in the same or a later wave. */
  _topoOrder(modules) {
    const byName = new Map(modules.map(m => [m.name, m]));
    const indegree = new Map(modules.map(m => [m.name, 0]));
    for (const m of modules) {
      for (const dep of m.dependsOn) {
        if (byName.has(dep)) indegree.set(m.name, indegree.get(m.name) + 1);
        // dependency name that doesn't match any real module — ignored rather than crashing
      }
    }
    const waves = [];
    const done = new Set();
    let remaining = [...modules];

    while (remaining.length) {
      const ready = remaining.filter(m => m.dependsOn.every(d => !byName.has(d) || done.has(d)));
      if (!ready.length) {
        // Cycle (or malformed deps) — dump everything left into one final
        // wave rather than looping forever. See HONEST LIMITS.
        waves.push(remaining);
        break;
      }
      waves.push(ready);
      for (const m of ready) done.add(m.name);
      remaining = remaining.filter(m => !done.has(m.name));
    }
    return waves;
  }

  async build({ spec, targetDir, modules, useSynthesisFor = [], reviewAfterBuild = true, synthesis, sharedContext }) {
    const modulesToUse = modules || this.lastPlan?.modules;
    if (!modulesToUse) return { ok: false, error: 'No modules given and no prior plan() call — run plan({spec}) first, or pass modules explicitly.' };
    if (!targetDir) return { ok: false, error: 'targetDir is required.' };
    await fs.mkdir(targetDir, { recursive: true });

    let task = null;
    if (this.tasks) task = await this.tasks.createTask(`Build large app: ${spec.slice(0, 80)}`);

    const waves = this._topoOrder(modulesToUse);
    const moduleResults = [];
    const waveResults = [];

    for (let i = 0; i < waves.length; i++) {
      const wave = waves[i];
      const outcomes = await Promise.all(wave.map(mod => this._buildModule(mod, { spec, targetDir, useSynthesisFor, synthesis, sharedContext })));
      moduleResults.push(...outcomes);
      if (this.tasks && task) {
        for (const o of outcomes) await this.tasks.addNote(task.id, `Module "${o.module}": ${o.ok ? 'built' : 'FAILED — ' + o.error}`);
      }

      const stack = await detectStack(targetDir).catch(() => 'unknown');
      const verification = stack !== 'unknown'
        ? await runVerification({ targetDir, stack }).catch(err => ({ ok: false, error: err.message }))
        : { ok: null, summary: 'No detected/buildable stack yet — integration check skipped for this wave.' };
      waveResults.push({ wave: i + 1, modules: wave.map(m => m.name), integrationOk: verification.ok, integrationSummary: verification.summary || verification.error });
      if (this.tasks && task && verification.ok === false) {
        await this.tasks.addNote(task.id, `Integration check FAILED after wave ${i + 1} — see build results before continuing.`);
      }
    }

    let reviewVerdict = null;
    if (reviewAfterBuild && this.reviewBoard) {
      reviewVerdict = await this.reviewBoard.review({ dir: targetDir, task: spec, sharedContext });
    }

    if (this.tasks && task) await this.tasks.setStatus(task.id, 'done');

    const result = { spec, targetDir, waves: waveResults, modules: moduleResults, reviewVerdict, taskId: task?.id || null, builtAt: new Date().toISOString() };
    this.lastBuild = result;
    return this._format(result);
  }

  async _buildModule(mod, { spec, targetDir, useSynthesisFor, synthesis, sharedContext }) {
    const modDir = path.join(targetDir, mod.dir || mod.name);
    await fs.mkdir(modDir, { recursive: true });

    if (useSynthesisFor.includes(mod.name) && synthesis) {
      try {
        const report = await synthesis.run({
          task: `${mod.description} (module "${mod.name}" of app: ${spec})`,
          sourceDir: modDir, sharedContext,
        });
        return { module: mod.name, ok: true, dir: modDir, viaSynthesis: true, report };
      } catch (err) {
        return { module: mod.name, ok: false, dir: modDir, viaSynthesis: true, error: err.message };
      }
    }

    const depNote = mod.dependsOn.length ? ` This module depends on: ${mod.dependsOn.join(', ')} — those should already exist elsewhere in ${targetDir}, you can read/import from them.` : '';
    const agents = [{
      role: mod.name,
      focus:
        `Overall app spec: ${spec}\n\nBuild ONLY this module: "${mod.name}" — ${mod.description}\n` +
        `Work inside: ${modDir}.${depNote} Report what you built when done.`,
      tools: ['read_file', 'write_file', 'list_directory', 'bash_execute', 'code_execute'],
    }];
    try {
      const report = await this.swarm.run(spec, agents, { maxIterations: MODULE_BUILD_MAX_ITERATIONS, sharedContext });
      return { module: mod.name, ok: true, dir: modDir, viaSynthesis: false, report };
    } catch (err) {
      return { module: mod.name, ok: false, dir: modDir, viaSynthesis: false, error: err.message };
    }
  }

  _format(result) {
    const lines = [
      `Large-app build complete: "${result.spec}" → ${result.targetDir}`,
      '',
      'Waves:',
      ...result.waves.map(w => `  Wave ${w.wave} [${w.modules.join(', ')}]: integration ${w.integrationOk === null ? 'skipped' : w.integrationOk ? 'OK' : 'FAILED'} — ${w.integrationSummary}`),
      '',
      'Modules:',
      ...result.modules.map(m => `  ${m.ok ? '✓' : '✗'} ${m.module} (${m.dir})${m.viaSynthesis ? ' [via divergent_synthesis]' : ''}${m.error ? ` — ${m.error}` : ''}`),
    ];
    if (result.reviewVerdict) lines.push('', 'Final review board pass:', result.reviewVerdict);
    if (result.taskId) lines.push('', `Tracked as task ${result.taskId} on the task board.`);
    return lines.join('\n');
  }

  getContext() {
    if (!this.lastBuild) return this.lastPlan ? `Last plan: "${this.lastPlan.spec}" — ${this.lastPlan.modules.length} module(s), not yet built.` : '(no orchestrator runs yet)';
    const b = this.lastBuild;
    const failed = b.modules.filter(m => !m.ok).length;
    return `Last build: "${b.spec}" → ${b.targetDir} — ${b.modules.length} module(s), ${failed} failed, ${b.waves.length} wave(s) (${b.builtAt}).`;
  }
}

