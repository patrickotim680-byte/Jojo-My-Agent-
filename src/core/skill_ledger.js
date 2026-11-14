// ── SkillLedger ───────────────────────────────────────────────────────────────
// This is what makes Jojo's skills self-improving instead of static text files
// that only change when a human hand-edits them.
//
// Every time a skill is used to complete a task, the outcome (success /
// failure / correction) gets logged here. On request (or periodically),
// review_skill_performance looks at that history plus the skill's current
// SKILL.md body and asks the model to propose a revision — tightened
// instructions, new edge cases, removed dead steps. That proposal is stored
// as PENDING and never touches disk on its own.
//
// Nothing is applied automatically. apply_skill_update only acts on a
// proposal id that already exists in the ledger, and the agent is instructed
// (see agent.js IDENTITY) to only call it after the human has explicitly
// approved the changelog in chat. Every applied update archives the prior
// SKILL.md first, so any change can be rolled back by hand.

import fs from 'fs/promises';
import path from 'path';

const DIR  = './memory';
const FILE = path.join(DIR, 'skill_ledger.json');
const MAX_ENTRIES_PER_SKILL = 200;

// ── Scoring & Natural Selection thresholds ───────────────────────────────────
// A skill's "score" is a weighted success rate: full credit for a clean
// success, half credit for a correction (it worked, but needed a fix),
// zero for an outright failure. Status is recomputed live from the entry
// log every time — nothing sticky is stored, so a skill that starts
// failing gets demoted immediately and one that recovers (e.g. a human
// fixes it via apply_skill_update) climbs back out on its own.
const MIN_SAMPLES        = 3;    // fewer logged uses than this → still 'probation', not judged yet
const RETIRE_THRESHOLD   = 0.34; // score below this (with enough samples) → 'retired'
const ACTIVE_THRESHOLD   = 0.5;  // score at/above this → 'active'
const CORE_THRESHOLD     = 0.8;  // score at/above this + CORE_MIN_SAMPLES → 'core' (preferred)
const CORE_MIN_SAMPLES   = 5;

const DEFAULT = {
  skills: {}, // name → { entries: [...], proposals: [...], synthesized, protected }
};

function freshSkillRecord() {
  return { entries: [], proposals: [], synthesized: false, protected: false };
}

export class SkillLedger {
  constructor() {
    this.data = structuredClone(DEFAULT);
  }

  async init() {
    await fs.mkdir(DIR, { recursive: true });
    try {
      const raw = await fs.readFile(FILE, 'utf-8');
      this.data = { ...DEFAULT, ...JSON.parse(raw) };
    } catch {
      await this._save();
    }
  }

  async _save() {
    await fs.writeFile(FILE, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  _record(skillName) {
    if (!this.data.skills[skillName]) this.data.skills[skillName] = freshSkillRecord();
    return this.data.skills[skillName];
  }

  // ── Registration (Capability Synthesis & Natural Selection) ─────────────────
  // Called once per skill whenever the skills folder is (re)loaded — tells the
  // ledger whether a skill is hand-authored (protected: true, immune to
  // auto-retirement) or synthesized by the agent itself (protected: false,
  // starts on probation and is subject to scoring). This is a structural fact
  // about where the file lives, not a performance judgement, so it's safe to
  // just set it fresh every time rather than merge.
  async registerSkill(skillName, { synthesized = false, isProtected = false } = {}) {
    const rec = this._record(skillName);
    rec.synthesized = !!synthesized;
    rec.protected   = !!isProtected;
    await this._save();
    return rec;
  }

  // ── Outcome logging ─────────────────────────────────────────────────────────

  /** outcome: 'success' | 'failure' | 'correction' */
  async logOutcome(skillName, { outcome, task = '', note = '' }) {
    const rec = this._record(skillName);
    rec.entries.push({
      timestamp: new Date().toISOString(),
      outcome,
      task:  String(task).slice(0, 300),
      note:  String(note).slice(0, 500),
    });
    if (rec.entries.length > MAX_ENTRIES_PER_SKILL) {
      rec.entries = rec.entries.slice(-MAX_ENTRIES_PER_SKILL);
    }
    await this._save();
    return rec.entries[rec.entries.length - 1];
  }

  /** Rolling counts + the most recent failure/correction notes (what a revision should target). */
  summarize(skillName, { recentLimit = 12 } = {}) {
    const rec = this.data.skills[skillName];
    if (!rec || !rec.entries.length) {
      return { total: 0, success: 0, failure: 0, correction: 0, recentIssues: [] };
    }
    const counts = { success: 0, failure: 0, correction: 0 };
    for (const e of rec.entries) counts[e.outcome] = (counts[e.outcome] || 0) + 1;

    const recentIssues = rec.entries
      .filter(e => e.outcome === 'failure' || e.outcome === 'correction')
      .slice(-recentLimit)
      .map(e => `[${e.outcome}] task: ${e.task || '(untitled)'} — ${e.note || '(no note)'}`);

    return { total: rec.entries.length, ...counts, recentIssues };
  }

  // ── Scoring & Natural Selection ──────────────────────────────────────────────
  // Live scorecard for one skill. Nothing here is persisted as a sticky
  // "status" field — it's recomputed from the raw entry log every call, so
  // a skill's standing always reflects its current track record.
  getScore(skillName) {
    const rec = this.data.skills[skillName];
    const isProtected = !!rec?.protected;
    const synthesized = !!rec?.synthesized;

    if (!rec || !rec.entries.length) {
      return {
        name: skillName, total: 0, success: 0, failure: 0, correction: 0,
        score: null, status: isProtected ? 'active' : 'probation',
        protected: isProtected, synthesized,
      };
    }

    const counts = { success: 0, failure: 0, correction: 0 };
    for (const e of rec.entries) counts[e.outcome] = (counts[e.outcome] || 0) + 1;
    const total = rec.entries.length;
    // Weighted score: success = 1 point, correction = 0.5 (it worked, but needed
    // a fix), failure = 0 points.
    const score = (counts.success + 0.5 * counts.correction) / total;

    let status;
    if (isProtected) {
      // Hand-authored skills are never hidden or auto-retired — this is the
      // "pinned skill immunity" the natural-selection layer respects. They can
      // still be promoted to 'core' for the badge, but score never demotes them.
      status = (score >= CORE_THRESHOLD && total >= CORE_MIN_SAMPLES) ? 'core' : 'active';
    } else if (total < MIN_SAMPLES) {
      status = 'probation';
    } else if (score < RETIRE_THRESHOLD) {
      status = 'retired';
    } else if (score >= CORE_THRESHOLD && total >= CORE_MIN_SAMPLES) {
      status = 'core';
    } else if (score >= ACTIVE_THRESHOLD) {
      status = 'active';
    } else {
      status = 'probation';
    }

    return { name: skillName, total, ...counts, score, status, protected: isProtected, synthesized };
  }

  /** True only for a non-protected (synthesized) skill that has earned retirement. */
  isRetired(skillName) {
    return this.getScore(skillName).status === 'retired';
  }

  /** Full scoreboard across every skill the ledger knows about, worst→best is
   *  NOT assumed by callers — sorted best-score-first here for convenience. */
  scoreboard() {
    return Object.keys(this.data.skills)
      .map(name => this.getScore(name))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }

  // ── Proposals ────────────────────────────────────────────────────────────────

  async addProposal(skillName, { changelog, new_body, confidence, based_on_entries }) {
    const rec = this._record(skillName);
    const proposal = {
      id: `${skillName}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      changelog,
      new_body,
      confidence,
      based_on_entries,
      status: 'pending', // pending | applied | rejected
    };
    rec.proposals.push(proposal);
    await this._save();
    return proposal;
  }

  getProposal(skillName, proposalId) {
    const rec = this.data.skills[skillName];
    if (!rec) return null;
    return rec.proposals.find(p => p.id === proposalId) || null;
  }

  async setProposalStatus(skillName, proposalId, status) {
    const proposal = this.getProposal(skillName, proposalId);
    if (!proposal) return null;
    proposal.status = status;
    proposal.resolved_at = new Date().toISOString();
    await this._save();
    return proposal;
  }

  pendingProposals(skillName) {
    const rec = this.data.skills[skillName];
    if (!rec) return [];
    return rec.proposals.filter(p => p.status === 'pending');
  }

  // ── System-prompt context (kept short — this is a nudge, not a dump) ────────

  getContext() {
    const names = Object.keys(this.data.skills);
    if (!names.length) return '(no skill usage logged yet)';

    const lines = [];
    for (const name of names) {
      const s = this.summarize(name);
      if (!s.total) continue;
      const pending = this.pendingProposals(name).length;
      let line = `- **${name}**: ${s.total} logged uses (${s.success} ok, ${s.failure} failed, ${s.correction} corrected)`;
      if (pending) line += ` — ${pending} pending revision proposal(s) awaiting your approval`;
      lines.push(line);
    }
    if (!lines.length) return '(no skill usage logged yet)';
    return lines.join('\n');
  }
}

