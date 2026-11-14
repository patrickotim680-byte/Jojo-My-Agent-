// ── TrajectoryLogger ─────────────────────────────────────────────────────────
//
// Feature: "JOJO trains a piece of itself, permanently, on you."
//
// learning.js's header draws the contrast: unlike Claude's offline batch
// updates, weeks/months apart, Jojo learns immediately within a session —
// but until now that only ever meant writing JSON to memory/. skill_ledger.js
// scores whether a skill's strategy worked, but only ever keeps a compact
// { outcome, task, note } per entry (see MAX_ENTRIES_PER_SKILL there) — on
// purpose, that file is sized to fit in a system-prompt context block, not to
// be a training corpus. agent.history holds the real thing (full tool-call
// sequences, args and all) but only in RAM for the current process — gone on
// restart. Nothing Jojo does ever gets baked in anywhere.
//
// This module is the first half of closing that gap: it watches the SAME
// turns agent.js already appends to this.history and, for the ones that
// finished a loaded skill with a clean "success" AND that skill currently has
// an earned track record (not a fluke first try — see GATE below), writes the
// full trajectory to disk. distillation.js later turns the accumulated log
// into LoRA training data; this file only ever decides what's worth keeping.
//
// ── GATE (why two thresholds, not one) ──────────────────────────────────────
// "Gated by skill_ledger's score" could mean either "this one instance
// succeeded" or "this skill's overall score is good." We require BOTH, at two
// different bars:
//   - CAPTURE bar (this file):  skillLedger.getScore(name).status is 'active'
//     OR 'core' at logging time, AND this specific turn's own outcome was
//     'success' (not 'correction' — a correction means the raw trajectory
//     needed a fix, which is exactly what we don't want to teach a small
//     model to imitate). This is deliberately the LOWER of the two bars used
//     across this feature, so a corpus already exists by the time a skill
//     earns 'core' — distillation.js's DISTILL bar (score ≥ CORE_THRESHOLD)
//     is stricter, and there'd be nothing to distill from if capture waited
//     for that same bar before ever writing anything.
//   - A skill still on 'probation' or already 'retired' never qualifies here,
//     no matter how clean this one instance looked — one lucky success on a
//     new or struggling skill is not "worked well," it's a sample size of 1.
//
// ── SCOPE (honest limit, not an oversight) ──────────────────────────────────
// Only turns that called log_skill_outcome are ever eligible. Raw chat with
// no loaded skill involved (small talk, one-off questions) is invisible to
// skill_ledger entirely, so it's invisible here too. That's a deliberate
// consequence of anchoring the gate to skill_ledger specifically, as asked
// for — not a bug. A separate "general chat" cluster with its own gating
// would be a reasonable v2, not built here.
//
// ── PRIVACY (defense in depth, not a guarantee) ─────────────────────────────
// Full tool-call trajectories can contain anything a tool touched — file
// contents, shell output, API responses. Two independent safeguards, both
// SKILL_EXCLUDE and redact() below, are deliberately conservative defaults,
// not a promise of clean data: review memory/trajectories/ yourself before
// trusting it as a training corpus for anything you'd mind seeing again.
//   1. SKILL_EXCLUDE — skills that never get captured at all, regardless of
//      score. Seeded from the same tool surface agent.js's own IDENTITY
//      prompt already treats as high-stakes (credential/production/network-
//      exploit-adjacent) — see DISTILLATION.md for the exact correspondence.
//   2. redact() — a best-effort regex scrub for credential-shaped strings
//      (API keys, bearer tokens, JWTs, "password: ..." style assignments)
//      run over every captured tool arg/result before it touches disk. This
//      is pattern matching, not a secret scanner — it will miss things.

import fs from 'fs/promises';
import path from 'path';

export const TRAJECTORIES_DIR = './memory/trajectories';
export const MANIFEST_FILE    = path.join('./memory', 'trajectory_manifest.json');

const MAX_LINES_PER_SKILL = parseInt(process.env.DISTILL_MAX_TRAJECTORIES_PER_SKILL || '4000');
const MAX_FIELD_CHARS     = parseInt(process.env.DISTILL_MAX_FIELD_CHARS || '20000'); // per tool arg/result, pre-redaction truncation

// Skills that never get captured, no matter how well they score. Names must
// match the skill folder slug (see skills.js's slugify). Edit freely — this
// is a starting point, not a claim of completeness.
export const DEFAULT_SKILL_EXCLUDE = new Set([
  'aircrack', 'nmap',            // wireless/network security tooling
  'deploy', 'n8n',                // production credentials/infra
  'monetization', 'stripe',      // payment surfaces
  'browser-irreversible',        // if you tag a skill this way — see DISTILLATION.md
]);

// Best-effort credential scrub. Order matters: JWT/bearer/AKIA patterns are
// checked before the generic key=value fallback so they're replaced with a
// more specific placeholder.
const REDACT_PATTERNS = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/\bBearer\s+[A-Za-z0-9\-_.=]{10,}/gi, 'Bearer [REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY_ID]'],
  [/\bsk-[A-Za-z0-9]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/([-_a-zA-Z0-9]*(?:api[_-]?key|secret|password|passwd|token|auth)[-_a-zA-Z0-9]*\s*[:=]\s*)["']?[A-Za-z0-9\-_.+/=]{8,}["']?/gi, '$1[REDACTED]'],
];

/** Apply every pattern in REDACT_PATTERNS to a string. Non-strings pass through unchanged. */
export function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [pattern, replacement] of REDACT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function truncateField(s) {
  s = String(s ?? '');
  return s.length > MAX_FIELD_CHARS
    ? `${s.slice(0, MAX_FIELD_CHARS)}\n…[truncated ${s.length - MAX_FIELD_CHARS} chars]…`
    : s;
}

/** Redact + size-bound every text-bearing part of a captured turn, in place
 *  on a deep-cloned copy (never mutates the caller's history array). */
function sanitizeTurns(newTurns) {
  return newTurns.map(turn => ({
    role: turn.role,
    parts: (turn.parts || []).map(part => {
      if (part.text != null) return { text: redact(truncateField(part.text)) };
      if (part.functionCall) {
        const args = {};
        for (const [k, v] of Object.entries(part.functionCall.args || {})) {
          args[k] = typeof v === 'string' ? redact(truncateField(v)) : v;
        }
        return { functionCall: { name: part.functionCall.name, args } };
      }
      if (part.functionResponse) {
        const res = part.functionResponse.response?.result;
        return {
          functionResponse: {
            name: part.functionResponse.name,
            response: { result: redact(truncateField(res)) },
          },
        };
      }
      return part;
    }),
  }));
}

/** Pull every log_skill_outcome call out of a turn's newTurns, wherever in
 *  the tool-calling loop it happened. A turn can legitimately contain zero
 *  (no skill used), one (the common case), or several (multi-skill turn). */
function findSkillOutcomeCalls(newTurns) {
  const calls = [];
  for (const turn of newTurns) {
    if (turn.role !== 'model') continue;
    for (const part of turn.parts || []) {
      if (part.functionCall?.name === 'log_skill_outcome') {
        calls.push(part.functionCall.args || {});
      }
    }
  }
  return calls;
}

export class TrajectoryLogger {
  constructor({ skillExclude = DEFAULT_SKILL_EXCLUDE } = {}) {
    this.skillExclude = skillExclude;
    this._manifest = null; // lazy-loaded, see _loadManifest
  }

  async init() {
    await fs.mkdir(TRAJECTORIES_DIR, { recursive: true });
    await this._loadManifest();
  }

  async _loadManifest() {
    try {
      const raw = await fs.readFile(MANIFEST_FILE, 'utf-8');
      this._manifest = JSON.parse(raw);
    } catch {
      this._manifest = { skills: {}, meta: { version: '1.0.0' } };
    }
    return this._manifest;
  }

  async _saveManifest() {
    await fs.writeFile(MANIFEST_FILE, JSON.stringify(this._manifest, null, 2), 'utf-8');
  }

  _shardPath(skillName) {
    // Skill names are already filesystem-safe slugs (see skills.js's
    // slugify) but this is cheap insurance against a hand-typed skill_name
    // arg containing something a path shouldn't.
    const safe = String(skillName).replace(/[^a-z0-9_-]+/gi, '-');
    return path.join(TRAJECTORIES_DIR, `${safe}.jsonl`);
  }

  /**
   * Call once per completed agent.run() turn, BEFORE this.history.push(...)
   * trims/mutates newTurns further. Fire-and-forget from the caller's side —
   * every failure mode here is caught and swallowed; a logging bug should
   * never be able to break a live turn. See DISTILLATION.md for the exact
   * one-line wiring call in agent.js.
   *
   * @param {string} userMessage - the turn's original user message (clean,
   *   pre-reasoning-plan text — same string agent.js stores in history).
   * @param {Array}  newTurns    - the turn's own [{role, parts}] slice, in
   *   the same Gemini-style shape agent.js builds it in, BEFORE it's
   *   concatenated onto this.history.
   * @param {object} skillLedger - the live SkillLedger instance (needs
   *   .getScore(name) — see skill_ledger.js).
   * @returns {Promise<{captured: string[]}>} skill names actually written,
   *   for callers that want to log/inspect it — never throws.
   */
  async maybeCapture({ userMessage, newTurns, skillLedger }) {
    try {
      if (!skillLedger || !Array.isArray(newTurns) || !newTurns.length) return { captured: [] };
      const outcomeCalls = findSkillOutcomeCalls(newTurns);
      if (!outcomeCalls.length) return { captured: [] };

      if (!this._manifest) await this._loadManifest();

      const captured = [];
      const sanitized = sanitizeTurns(newTurns); // do this once per turn, not once per qualifying skill

      for (const call of outcomeCalls) {
        const skillName = call.skill_name;
        if (!skillName || call.outcome !== 'success') continue;
        if (this.skillExclude.has(skillName)) continue;

        const scoreInfo = skillLedger.getScore(skillName);
        const qualifies = (scoreInfo.status === 'active' || scoreInfo.status === 'core');
        if (!qualifies) continue;

        const record = {
          ts: new Date().toISOString(),
          skill: skillName,
          task: String(call.task || '').slice(0, 300),
          note: String(call.note || '').slice(0, 500),
          score_at_capture:  scoreInfo.score,
          status_at_capture: scoreInfo.status,
          user_message: redact(truncateField(userMessage)),
          turns: sanitized,
        };

        await fs.appendFile(this._shardPath(skillName), JSON.stringify(record) + '\n', 'utf-8');
        await this._rotateIfNeeded(skillName);
        this._touchManifest(skillName, record.turns.length);
        captured.push(skillName);
      }

      if (captured.length) await this._saveManifest();
      return { captured };
    } catch {
      return { captured: [] }; // fail open — see file header
    }
  }

  _touchManifest(skillName, turnCount) {
    const m = this._manifest.skills[skillName] || {
      count: 0, firstCapturedAt: new Date().toISOString(), avgTurns: 0,
    };
    m.count += 1;
    m.avgTurns = m.avgTurns + (turnCount - m.avgTurns) / m.count; // running mean
    m.lastCapturedAt = new Date().toISOString();
    this._manifest.skills[skillName] = m;
  }

  /** Keep only the newest MAX_LINES_PER_SKILL examples per shard. Rare
   *  enough (thousands of captures between rotations) that a full
   *  read-trim-rewrite is fine — same tradeoff skill_ledger.js makes with
   *  MAX_ENTRIES_PER_SKILL, just at training-corpus scale instead of
   *  context-block scale. */
  async _rotateIfNeeded(skillName) {
    const file = this._shardPath(skillName);
    let lines;
    try {
      lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
    } catch {
      return;
    }
    if (lines.length > MAX_LINES_PER_SKILL) {
      await fs.writeFile(file, lines.slice(-MAX_LINES_PER_SKILL).join('\n') + '\n', 'utf-8');
    }
  }

  /** Cheap aggregate read — distillation.js and distillation_tools.js use
   *  this instead of scanning every shard just to answer "how much do we
   *  have?". Manifest counts can drift slightly ahead of on-disk rotation
   *  (rotation trims OLD examples, it doesn't decrement the running count),
   *  so treat count as "examples ever captured," not "lines in the file
   *  right now" — exportDataset() in distillation.js reads the real file
   *  when it actually needs the data. */
  async summary() {
    if (!this._manifest) await this._loadManifest();
    return structuredClone(this._manifest.skills);
  }

  /** Stream-read one skill's captured examples (newest last). Returns [] for
   *  a skill with no shard yet — never throws. */
  async readShard(skillName) {
    try {
      const raw = await fs.readFile(this._shardPath(skillName), 'utf-8');
      return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async listShards() {
    try {
      const files = await fs.readdir(TRAJECTORIES_DIR);
      return files.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6));
    } catch {
      return [];
    }
  }
}

