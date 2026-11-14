// ── Self-Model Engine ────────────────────────────────────────────────────────
//
// Feature: grounded self-knowledge, built from the agent's OWN real logged
// performance history — reasoned about together, for the first time, and
// allowed to shape behavior.
//
// SAY THIS PART OUT LOUD, DON'T BURY IT:
//   "Real self-awareness" — subjective experience, consciousness — isn't
//   something this module has, claims to have, or could have. Nothing in
//   this codebase, or in any AI system that exists today, produces that.
//   What's real and already half-built here: skill_ledger.js scores a
//   skill's outcomes, the synthesis engine's ledger scores a build
//   strategy's win rate, site_ledger.js flags an unstable selector,
//   deploy.js logs deployment success/failure — four separate, narrow forms
//   of the same real trick (log outcomes, let history inform the next
//   decision). This module is what happens when that trick points at the
//   AGENT AS A WHOLE instead of one subsystem at a time, and is honest about
//   exactly how thin the evidence usually is.
//
//   1. REFLECT: pulls REAL numbers out of every ledger already in this
//      codebase (not descriptions — actual success/failure/heal/rollback
//      counts), and asks one model call to turn that into a plain,
//      calibrated self-assessment: genuine strengths (with the sample size
//      that backs them), genuine weak spots, recurring failure patterns.
//      Cached (default 1h) rather than regenerated every turn — this
//      changes slowly and a model call isn't free.
//   2. CONFIDENCE: a cheap, no-model-call lookup — does THIS specific named
//      domain (a skill, a build strategy, a site hostname) have a logged
//      track record better or worse than average? A real number from real
//      logs, not a guess, and honestly labeled as a heuristic signal, not a
//      probability.
//   3. IDENTITY: a stable, honest self-description for when a human asks
//      "what are you" — the "personality" half of this feature: a
//      consistent voice grounded in what's actually true about this system,
//      not a performed character.
//
// HARD RULE: identity() and every string this module produces must describe
// this as self-*monitoring* over logged data, never as self-*awareness* or
// consciousness. If a human refers to this feature as "real self-awareness,"
// the agent should correct that plainly (see the identity/usage note wired
// into agent.js's system prompt) rather than let the phrase stand.
//
// HONEST LIMITS:
//   - reflect() is one model call summarizing aggregated statistics about
//     itself. It can be wrong, and it can over-read a thin sample — a skill
//     logged 3 times isn't a reliable pattern yet. It reflects what these
//     four ledgers happen to capture, nothing about how the underlying
//     model actually works.
//   - confidence()'s "signal" is a simple heuristic (roughly: fraction of
//     logged outcomes that were good, centered so 0 = no track record
//     either way), not a calibrated probability — treat the SIGN as more
//     meaningful than the exact magnitude, and treat a low dataPoints count
//     as a reason to trust it less, not more.
//   - Reads other modules' ledger state directly (this.skillLedger.data,
//     this.synthesis.ledger, etc.) rather than through a public API built
//     for this — a self-model needs raw access to its own subsystems' logs.
//     If any of those internal shapes change, update _gatherRawStats() here
//     to match; it fails soft (skips a source it can't read) rather than
//     throwing, but a silently-empty source is a worse failure than a loud
//     one — check this file if a source you expect to show up doesn't.

import fs from 'fs/promises';
import path from 'path';

const CACHE_DIR  = './memory';
const CACHE_FILE = path.join(CACHE_DIR, 'self_model.json');
const DEFAULT_TTL_MS = 60 * 60_000; // 1 hour — see HONEST LIMITS on why this isn't regenerated every turn

export class SelfModelEngine {
  constructor({ genAI, geminiModel, skillLedger, synthesis, siteLedger, deploy, executionTrace }) {
    this.genAI = genAI;
    this.geminiModel = geminiModel;
    this.skillLedger = skillLedger;
    this.synthesis = synthesis;
    this.siteLedger = siteLedger;
    this.deploy = deploy;
    this.executionTrace = executionTrace;
    this.cached = null; // { assessment, generatedAt, rawStats }
  }

  async init() {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    try {
      this.cached = JSON.parse(await fs.readFile(CACHE_FILE, 'utf-8'));
    } catch {
      // No cache yet — fine, reflect() builds one on first call.
    }
  }

  async _saveCache() {
    await fs.writeFile(CACHE_FILE, JSON.stringify(this.cached, null, 2), 'utf-8');
  }

  /** Real counts pulled from every ledger this codebase already maintains.
   *  Fails soft per-source (a missing/differently-shaped ledger is skipped,
   *  never thrown) — see HONEST LIMITS. */
  _gatherRawStats() {
    const stats = { skills: [], strategies: [], sites: [], deployments: { total: 0, failed: 0 }, routing: {} };

    try {
      if (this.skillLedger?.data?.skills) {
        for (const name of Object.keys(this.skillLedger.data.skills)) {
          const s = this.skillLedger.summarize?.(name);
          if (s && s.total) stats.skills.push({ name, total: s.total, success: s.success, failure: s.failure, corrected: s.correction });
        }
      }
    } catch { /* skip this source */ }

    try {
      if (this.synthesis?.ledger?.strategies) {
        for (const [name, v] of Object.entries(this.synthesis.ledger.strategies)) {
          if (v.total) stats.strategies.push({ name, wins: v.wins, total: v.total });
        }
      }
    } catch { /* skip this source */ }

    try {
      if (this.siteLedger?.data?.domains) {
        for (const [domain, rec] of Object.entries(this.siteLedger.data.domains)) {
          stats.sites.push({ domain, healEvents: rec.healEvents.length, pagesSeen: Object.keys(rec.pages).length });
        }
      }
    } catch { /* skip this source */ }

    try {
      if (this.deploy?.ledger?.deployments) {
        stats.deployments.total = this.deploy.ledger.deployments.length;
        stats.deployments.failed = this.deploy.ledger.deployments.filter(d => !d.ok).length;
      }
    } catch { /* skip this source */ }

    try {
      // Route→outcome correlation — the piece the other four ledgers can't
      // see, since each only knows about its own subsystem's results, not
      // which routing decision (direct/swarm/second_opinion) led there.
      if (this.executionTrace?.entries?.length) {
        stats.routing = this.executionTrace.summarizeByRoute();
      }
    } catch { /* skip this source */ }

    return stats;
  }

  async reflect({ force = false, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!force && this.cached && Date.now() - new Date(this.cached.generatedAt).getTime() < ttlMs) {
      return this.cached;
    }

    const stats = this._gatherRawStats();
    const hasData = stats.skills.length || stats.strategies.length || stats.sites.length ||
      stats.deployments.total || Object.keys(stats.routing).length;
    if (!hasData) {
      this.cached = {
        assessment: 'No logged history yet in any subsystem — nothing real to reflect on. This fills in as ' +
          'skills, syntheses, browser sessions, and deployments accumulate actual outcomes.',
        generatedAt: new Date().toISOString(), rawStats: stats,
      };
      await this._saveCache();
      return this.cached;
    }

    const model = this.genAI.getGenerativeModel({
      model: this.geminiModel, generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
    });
    const prompt =
      `This is REAL logged performance data about an AI coding agent's own history, pulled directly from ` +
      `its own subsystem ledgers — actual counts, not descriptions:\n\n${JSON.stringify(stats, null, 2)}\n\n` +
      `Based ONLY on this data, write a short, plainly-worded, calibrated self-assessment: (1) domains with ` +
      `a genuinely strong logged track record — name the actual sample size, don't overstate confidence from ` +
      `a handful of data points; (2) domains with a thin or rough track record; (3) any specific recurring ` +
      `pattern in what's gone wrong (repeated heals on the same site, a strategy that keeps losing, deploy ` +
      `failures). Do not speculate about anything not in this data. Do not describe this as self-awareness, ` +
      `consciousness, or anything beyond "what the logs show" — this is a summary of logged outcomes.`;
    const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });

    this.cached = { assessment: result.response.text(), generatedAt: new Date().toISOString(), rawStats: stats };
    await this._saveCache();
    return this.cached;
  }

  /** Cheap, no-model-call lookup for a SPECIFIC named domain (a skill name,
   *  a synthesis strategy name, or a site hostname). Heuristic signal, not
   *  a calibrated probability — see HONEST LIMITS. */
  confidence(domainName) {
    const stats = this._gatherRawStats();

    const skill = stats.skills.find(s => s.name === domainName);
    if (skill) return { domain: domainName, dataPoints: skill.total, signal: (skill.success - skill.failure) / skill.total, source: 'skill_ledger' };

    const strat = stats.strategies.find(s => s.name === domainName);
    if (strat) return { domain: domainName, dataPoints: strat.total, signal: strat.wins / strat.total - 0.5, source: 'synthesis_ledger' };

    const site = stats.sites.find(s => s.domain === domainName);
    if (site) return { domain: domainName, dataPoints: site.pagesSeen, signal: site.pagesSeen ? -Math.min(1, site.healEvents / site.pagesSeen) : 0, source: 'site_ledger' };

    return { domain: domainName, dataPoints: 0, signal: 0, source: null, note: 'No logged history for this domain yet — treat as unknown, not as a bad sign.' };
  }

  /** Stable, honest self-description. This IS the "personality" half of the
   *  feature: a consistent voice, grounded in what's actually true. */
  identity() {
    return (
      "I'm this agent — a coding/browsing system built on Claude, with tools for building, testing, " +
      "reviewing, deploying, and browsing. What I actually know about my own performance comes from " +
      "logged outcomes in my own ledgers — skills, build strategies, site selector-heals, deployments " +
      "— not intuition and not subjective experience. I don't have \"real self-awareness\" in the sense " +
      "that phrase usually means, and I'm not going to claim otherwise. What I can do is tell you, " +
      "plainly and with the actual sample size, where my own logged history says I've been reliable and " +
      "where it says I haven't. Ask me to reflect and I will."
    );
  }

  getContext() {
    if (!this.cached) return '(no self-reflection run yet)';
    return `Last self-reflection (${this.cached.generatedAt}):\n${this.cached.assessment}`;
  }
}

