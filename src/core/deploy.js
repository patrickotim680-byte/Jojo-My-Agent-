// ── Deploy Engine ────────────────────────────────────────────────────────────
//
// Feature: Human-Gated Multi-Provider Deployment
//
// Wraps real provider CLIs (Vercel, Netlify, Fly.io, plain Docker registry
// push) with the SAME safety spine already used everywhere else in this
// codebase: verify before acting, classify risk, gate the irreversible path
// behind human_approved=true, log what happened for rollback.
//
//   1. VERIFY-FIRST
//      prepareDeployment() runs the sandboxed build/test pipeline
//      (builder.js's runVerification) BEFORE anything provider-specific
//      happens. Code that doesn't even build never gets a deployment plan.
//
//   2. ENV-VAR NAME SCAN, NEVER VALUES
//      Every plan lists the env var NAMES the code references
//      (process.env.X / import.meta.env.X, grepped from source) so a human
//      can check they're configured in the provider's dashboard — VALUES
//      are never read, logged, or included in any plan. Secrets stay out of
//      this tool's reach entirely; the provider CLI reads them from the
//      environment or the provider's own dashboard, same as a human running
//      it by hand would.
//
//   3. PRODUCTION = IRREVERSIBLE, ALWAYS GATED
//      environment: 'preview' executes immediately (a throwaway URL, not
//      real traffic — genuinely reversible, same "let reversible actions
//      through" logic as browser.js). environment: 'production' NEVER
//      executes directly, no matter the provider — it becomes a pending
//      proposal requiring applyDeployment(id, human_approved=true), exactly
//      like apply_verified_fix / apply_synthesis_proposal / apply_browser_action.
//
//   4. PERSISTENT DEPLOY LEDGER + ROLLBACK
//      Every executed deployment (preview or production) is logged to
//      memory/deploy_ledger.json with enough to roll back: provider,
//      previous deployment id/url where the provider exposes one. rollback()
//      uses the provider's real rollback command where one exists (Vercel,
//      Fly); where it doesn't (Netlify, Docker) it tells you exactly what to
//      redeploy instead of pretending to roll back.
//
// HARD RULE: this module NEVER handles login/authentication for any
// provider — it assumes the CLI is already authenticated on this machine
// (the same way a human running it by hand would need to be). It never
// reads, logs, or transmits secret VALUES anywhere. A production deploy is
// NEVER executed without an explicit prior human_approved=true call.
//
// HONEST LIMITS:
//   - I could not run an actual deployment against a live provider in the
//     sandbox this was built in — no network, and these CLIs need real
//     authenticated accounts. Every command below is written to match each
//     CLI's real, documented flags, but CLI flags DO change across
//     versions — if a command errors with an "unknown flag"-type message,
//     check `<cli> --help` against what's used here.
//   - The env-var scanner is a regex grep (`process.env.NAME`,
//     `import.meta.env.NAME`), not a real static analyzer — dynamically
//     constructed env var names (`process.env[someVariable]`) won't be
//     caught, so treat the list as a floor, not a guarantee of completeness.
//   - fly.io deploys don't have a distinct "preview" concept the way
//     Vercel/Netlify do (a `flyctl deploy` targets whatever app is defined
//     in fly.toml) — Fly deploys are therefore ALWAYS treated as production
//     here and always gated, regardless of the environment argument passed.
//   - Docker "deployment" here means build + push to a registry, not
//     rolling the new image out anywhere — actually running it on your
//     infrastructure (Fly/ECS/Cloud Run/k8s/etc.) is a separate step outside
//     this module's scope.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { runVerification, detectStack } from './builder.js';
import { ApprovalGate } from './approval_gate.js';

const execFileAsync = promisify(execFile);

const LEDGER_DIR  = './memory';
const LEDGER_FILE = path.join(LEDGER_DIR, 'deploy_ledger.json');
const DEPLOY_TIMEOUT_MS = 5 * 60_000;
const SANDBOX_EXCLUDE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.cache']);

const PROVIDERS = new Set(['vercel', 'netlify', 'fly', 'docker']);

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function walkFiles(dir, base = dir, out = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (SANDBOX_EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, base, out);
    else if (entry.isFile() && /\.(js|jsx|ts|tsx|mjs|env\.example|toml|yaml|yml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Env var NAMES only, never values — see class header, mechanism 2. */
async function scanEnvVarNames(dir) {
  const files = await walkFiles(dir);
  const names = new Set();
  const patterns = [/process\.env\.([A-Z][A-Z0-9_]*)/g, /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g];
  for (const file of files) {
    let content;
    try { content = await fs.readFile(file, 'utf-8'); } catch { continue; }
    for (const re of patterns) {
      for (const m of content.matchAll(re)) names.add(m[1]);
    }
  }
  return [...names].sort();
}

async function cliAvailable(bin) {
  try { await execFileAsync(bin, ['--version'], { timeout: 10_000 }); return true; }
  catch { return false; }
}

function extractUrl(text) {
  const m = /https?:\/\/[^\s"'<>]+/.exec(text || '');
  return m ? m[0] : null;
}

export class DeployEngine {
  /** @param {{secondOpinion?: object}} [opts] - optional SecondOpinionEngine
   *  instance. If given, every PRODUCTION plan gets a mandatory cross-vendor
   *  pass (see second_opinion.js) before it's surfaced as pending — the plan
   *  is still queued and gated exactly the same either way; this only adds
   *  an independent opinion to what the human reviews. */
  constructor({ secondOpinion } = {}) {
    this.gate = new ApprovalGate({ idPrefix: 'deploy', kind: 'deployment plan' }); // note: this
      // also adds a bounded (default 20) pending cap — the original `this.pending = new Map()`
      // here had no eviction at all, an unbounded-growth edge case nobody had hit yet
    this.ledger = { deployments: [] };
    this.secondOpinion = secondOpinion || null;
  }

  async init() {
    await fs.mkdir(LEDGER_DIR, { recursive: true });
    try {
      const raw = await fs.readFile(LEDGER_FILE, 'utf-8');
      this.ledger = { deployments: [], ...JSON.parse(raw) };
    } catch {
      await this._saveLedger();
    }
  }

  async _saveLedger() {
    await fs.writeFile(LEDGER_FILE, JSON.stringify(this.ledger, null, 2), 'utf-8');
  }

  _isProductionRisk(provider, environment) {
    if (provider === 'fly') return true; // see HONEST LIMITS — fly has no distinct preview concept here
    return environment === 'production';
  }

  _command(provider, environment, dir, options) {
    switch (provider) {
      case 'vercel':
        return { bin: 'vercel', args: environment === 'production' ? ['--prod', '--yes'] : ['--yes'] };
      case 'netlify':
        return { bin: 'netlify', args: environment === 'production' ? ['deploy', '--prod'] : ['deploy'] };
      case 'fly':
        return { bin: 'flyctl', args: ['deploy'] };
      case 'docker': {
        if (!options.imageTag) throw new Error('docker provider requires options.imageTag (e.g. "myregistry/myapp:1.2.3").');
        return { bin: 'docker', args: ['build', '-t', options.imageTag, '.'], pushArgs: ['push', options.imageTag] };
      }
      default:
        throw new Error(`Unknown provider "${provider}". Known: ${[...PROVIDERS].join(', ')}`);
    }
  }

  /**
   * Verifies the code builds/tests clean, scans for referenced env var
   * NAMES, and either executes immediately (preview — reversible) or
   * returns a pending plan requiring human approval (production/fly —
   * irreversible). Never touches real infrastructure for a production plan.
   */
  async prepareDeployment({ dir, provider, environment = 'preview', task, stack, options = {} }) {
    if (!PROVIDERS.has(provider)) return { ok: false, error: `Unknown provider "${provider}". Known: ${[...PROVIDERS].join(', ')}` };
    try { await fs.access(dir); } catch { return { ok: false, error: `dir "${dir}" does not exist.` }; }

    const bin = provider === 'fly' ? 'flyctl' : provider;
    if (!(await cliAvailable(bin))) {
      return { ok: false, error: `"${bin}" CLI not found/authenticated on this machine. Install and log in to it first — this module never handles provider login itself.` };
    }

    const resolvedStack = stack || await detectStack(dir).catch(() => 'unknown');
    let verification = { ok: null, summary: 'No detected/buildable stack — proceeding without a build/test gate. Confirm this is intentional.' };
    if (resolvedStack !== 'unknown') {
      verification = await runVerification({ targetDir: dir, stack: resolvedStack }).catch(err => ({ ok: false, error: err.message }));
    }
    if (verification.ok === false) {
      return { ok: false, error: 'Build/tests failed — refusing to prepare a deployment on code that does not verify.', verification };
    }

    const envVarsReferenced = await scanEnvVarNames(dir);
    const { bin: cliBin, args, pushArgs } = this._command(provider, environment, dir, options);

    const plan = {
      id: uid('deploy'), dir, provider, environment: this._isProductionRisk(provider, environment) ? 'production' : environment,
      task: task || '(unspecified)', command: [cliBin, ...args], pushCommand: pushArgs ? [cliBin, ...pushArgs] : null,
      envVarsReferenced, verificationSummary: verification.summary || '(build/test passed)',
      createdAt: new Date().toISOString(),
    };

    if (this._isProductionRisk(provider, environment)) {
      // Mandatory cross-vendor pass — a DIFFERENT model looks at this plan
      // fresh before the human does. See second_opinion.js HONEST LIMITS:
      // this never blocks the plan by itself, it only adds an independent
      // opinion to what the human is about to review.
      if (this.secondOpinion) {
        const opinion = await this.secondOpinion.getSecondOpinion({
          subject: `production deployment plan (${provider})`,
          detail:
            `Command: ${[plan.command, ...(plan.pushCommand ? [plan.pushCommand] : [])].map(c => c.join(' ')).join(' && ')}\n` +
            `Environment: ${plan.environment}\n` +
            `Env vars this code references (names only, no values): ${plan.envVarsReferenced.join(', ') || '(none detected)'}\n` +
            `Build/test verification: ${plan.verificationSummary}`,
          question:
            'Is this safe to run against production infrastructure? Flag anything about the command itself, ' +
            'a provider-specific footgun, or a missing safeguard the human should double check before approving.',
        });
        plan.secondOpinion = opinion;
      }
      this.gate.propose(plan);
      return {
        ok: false, pending: true, planId: plan.id, plan,
        summary: `Deployment classified PRODUCTION (provider: ${provider}) — NOT executed. Review the plan ` +
          `(command, env vars this code references, verification result)` +
          `${plan.secondOpinion ? `, and the independent second opinion below,` : ''} and call ` +
          `apply_deployment("${plan.id}", human_approved=true) to proceed, or dismiss_deployment("${plan.id}") to discard.` +
          (plan.secondOpinion ? `\n\n${this.secondOpinion.format(plan.secondOpinion)}` : ''),
      };
    }

    const result = await this._run(plan);
    return { ok: true, pending: false, plan, result };
  }

  async applyDeployment(planId, humanApproved) {
    const { ok, message, result } = await this.gate.apply(planId, humanApproved, plan => this._run(plan));
    if (!ok) {
      // Preserve the two original distinct refusal messages exactly (gate's
      // generic ones differ in wording) so nothing downstream that matches
      // on this string breaks.
      if (message.startsWith('Refused: human_approved must be true')) {
        return 'Refused: applyDeployment requires explicit human_approved=true. Never call this speculatively on a production plan.';
      }
      if (message.startsWith('No pending')) return `No pending deployment plan with id "${planId}".`;
      return `Error executing approved deployment: ${message.replace(/^Error applying deployment plan: /, '')}`;
    }
    return `Deployed: ${JSON.stringify(result)}`;
  }

  dismissDeployment(planId) {
    const msg = this.gate.dismiss(planId);
    return msg.startsWith('No pending')
      ? `No pending deployment plan with id "${planId}".`
      : `Discarded deployment plan ${planId}. Nothing was deployed.`;
  }

  listPending() {
    return this.gate.list();
  }

  async _run(plan) {
    console.log(chalk.magenta(`[deploy] Running: ${plan.command.join(' ')} (cwd: ${plan.dir})`));
    const [cliBin, ...args] = plan.command;
    let stdout = '';
    try {
      const res = await execFileAsync(cliBin, args, { cwd: plan.dir, timeout: DEPLOY_TIMEOUT_MS });
      stdout = `${res.stdout}\n${res.stderr}`;
      if (plan.pushCommand) {
        const [pushBin, ...pushArgs] = plan.pushCommand;
        const pushRes = await execFileAsync(pushBin, pushArgs, { cwd: plan.dir, timeout: DEPLOY_TIMEOUT_MS });
        stdout += `\n${pushRes.stdout}\n${pushRes.stderr}`;
      }
    } catch (err) {
      const record = {
        id: uid('run'), planId: plan.id, provider: plan.provider, environment: plan.environment,
        dir: plan.dir, ok: false, error: err.message, at: new Date().toISOString(),
      };
      this.ledger.deployments.push(record);
      await this._saveLedger();
      throw err;
    }

    const url = extractUrl(stdout);
    const previous = [...this.ledger.deployments].reverse()
      .find(d => d.dir === plan.dir && d.provider === plan.provider && d.ok);
    const record = {
      id: uid('run'), planId: plan.id, provider: plan.provider, environment: plan.environment,
      dir: plan.dir, ok: true, url, rawOutputTail: stdout.slice(-2000),
      previousDeploymentId: previous ? previous.id : null, at: new Date().toISOString(),
    };
    this.ledger.deployments.push(record);
    await this._saveLedger();
    return record;
  }

  /** Real rollback where the provider CLI supports one; otherwise tells you
   *  exactly what to redeploy instead of faking a rollback. */
  async rollback(deploymentId) {
    const record = this.ledger.deployments.find(d => d.id === deploymentId);
    if (!record) return `No deployment record with id "${deploymentId}" in the ledger.`;

    if (record.provider === 'vercel' && record.url) {
      try {
        const res = await execFileAsync('vercel', ['rollback', record.url, '--yes'], { cwd: record.dir, timeout: DEPLOY_TIMEOUT_MS });
        return `Vercel rollback triggered for ${record.url}:\n${res.stdout}${res.stderr}`;
      } catch (err) { return `Vercel rollback command failed: ${err.message}`; }
    }
    if (record.provider === 'fly') {
      try {
        const res = await execFileAsync('flyctl', ['releases', 'rollback'], { cwd: record.dir, timeout: DEPLOY_TIMEOUT_MS });
        return `Fly rollback triggered:\n${res.stdout}${res.stderr}`;
      } catch (err) { return `Fly rollback command failed: ${err.message}`; }
    }
    if (record.previousDeploymentId) {
      return `${record.provider} has no direct rollback command wired here. Previous known-good deployment ` +
        `for this dir/provider: ${record.previousDeploymentId} (${record.dir}). Manually redeploy that ` +
        `directory's state (or that image tag, for docker) to roll back.`;
    }
    return `${record.provider} has no direct rollback command wired here, and no earlier deployment for this ` +
      `dir/provider is in the ledger to redeploy. Manual rollback required.`;
  }

  getContext() {
    const pendingLines = this.listPending().map(p =>
      `  [${p.id}] ${p.provider}/${p.environment} — ${p.dir} — awaiting approval`);
    const recent = this.ledger.deployments.slice(-3).map(d =>
      `  ${d.ok ? '✓' : '✗'} ${d.provider}/${d.environment} — ${d.dir}${d.url ? ` — ${d.url}` : ''} (${d.at})`);
    return [
      pendingLines.length ? `Pending deployment plans (production — need approval):\n${pendingLines.join('\n')}` : 'No pending deployment plans.',
      recent.length ? `Recent deployments:\n${recent.join('\n')}` : 'No deployments logged yet.',
    ].join('\n');
  }
}

