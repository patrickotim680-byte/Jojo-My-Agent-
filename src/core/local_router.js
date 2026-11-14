// ── LocalRouter ─────────────────────────────────────────────────────────────
// Feature: send routine, well-worn turns to a locally distilled model
// (served via Ollama) instead of the cloud model — instant, free, works
// offline. See distillation.js for how that model gets trained/promoted.
//
// ── THE GATE (why routing is conservative by design) ─────────────────────────
// route() only ever returns a local answer when ALL of the following hold —
// any single miss falls through to the cloud model, same "fail open" posture
// trajectory_logger.js and reasoning.js both already use:
//   1. A model is actually promoted (distillation.getPromotedModel()) and
//      Ollama answers a ping.
//   2. The message keyword-matches ONE of the promoted model's trained
//      skills' descriptions (skills.js's own frontmatter description — the
//      same text already used for the cloud model's own skill routing) —
//      cheap, heuristic, free, same style as reasoning.js's classify(). No
//      match → cloud. This deliberately never tries to route free-form,
//      novel, or ambiguous chat locally; that's exactly the case the feature
//      spec calls out as a cloud-fallback trigger.
//   3. That skill is not in skillExclude (defense in depth — mirrors
//      trajectory_logger.js's / distillation.js's exclusion set).
//   4. The local model itself reports HIGH confidence (see PROTOCOL below).
//      Anything else — medium, low, malformed, missing, timeout — falls back
//      to cloud. A wrong "confident" answer routed silently to the user is
//      worse than one extra cloud call, so the bar is deliberately
//      asymmetric: local only wins when it's cheap AND clearly sure.
//
// ── PROTOCOL (how confidence is read) ─────────────────────────────────────────
// The local model is prompted to prefix its answer with exactly one line —
//   CONFIDENCE: high | medium | low
// — before the real answer. This is a self-report from a small model with
// none of the cloud model's judgement behind it — treat it as a weak signal,
// not a guarantee (see HONEST LIMITS). It's cheap and it's the only signal a
// locally-served text completion can give without a second model call, which
// would defeat the "instant, free" point of routing locally in the first
// place.
//
// ── NO TOOL ACCESS FOR THE LOCAL MODEL (deliberate — see distillation.js) ────
// The local model never receives a tool registry here. It only ever answers
// with text, matching how it was trained (see distillation.js's WHY
// TEXT-ONLY note). This file has no code path that could give it one — that
// boundary lives structurally in _generate() below, not just in a comment.
//
// ── HONEST LIMITS ─────────────────────────────────────────────────────────────
// - Keyword-trigger matching is not intent understanding. It will occasionally
//   miss something it could have handled (falls back to cloud, no harm done)
//   — the confidence gate is what keeps a bad match from mattering.
// - The local model's self-reported confidence has no calibration guarantee.
//   Treat local answers as "probably fine for a routine, previously-seen
//   pattern," never as verified or safety-checked.
// - This never routes anything in skillExclude, full stop, regardless of
//   confidence or keyword-match strength.

import { DEFAULT_SKILL_EXCLUDE } from './trajectory_logger.js';

const OLLAMA_HOST        = process.env.OLLAMA_HOST || 'http://localhost:11434';
const REQUEST_TIMEOUT_MS = parseInt(process.env.LOCAL_ROUTER_TIMEOUT_MS || '15000');
const PING_TIMEOUT_MS    = 2000;
const MIN_KEYWORD_HITS   = 2; // cheap noise filter — see _matchSkill

const CONFIDENCE_RE = /^\s*CONFIDENCE:\s*(high|medium|low)\s*\n?/i;

export class LocalRouter {
  constructor({ distillation, skills, skillExclude = DEFAULT_SKILL_EXCLUDE, ollamaHost = OLLAMA_HOST } = {}) {
    this.distillation = distillation;
    this.skills       = skills; // SkillsSystem — supplies each skill's trigger description
    this.skillExclude = skillExclude;
    this.ollamaHost   = ollamaHost;
    this._lastDecision = null; // last route() outcome, for getContext()/inspection
  }

  async isAvailable() {
    try {
      const res = await fetch(`${this.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Cheap, free, heuristic skill match against the promoted model's own
   *  training skill set — same "heuristic-only" spirit as reasoning.js's
   *  classify(). Returns the matched skill name or null. */
  _matchSkill(userMessage, allowedSkills) {
    if (!this.skills || !allowedSkills?.length) return null;
    const msg = userMessage.toLowerCase();
    let best = null;
    let bestHits = 0;
    for (const name of allowedSkills) {
      const record = this.skills.get(name);
      if (!record) continue;
      const words = new Set(String(record.description || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3));
      let hits = 0;
      for (const w of words) if (msg.includes(w)) hits++;
      if (hits > bestHits) { bestHits = hits; best = name; }
    }
    return bestHits >= MIN_KEYWORD_HITS ? best : null;
  }

  /**
   * Decide whether this turn should go local, and if so, produce the
   * answer. Never throws — every failure mode falls through to
   * { routedLocally: false }, meaning "caller should use the normal cloud
   * path." Callers should treat this as advisory, not authoritative: even
   * routedLocally: true is just a small model's self-reported confidence,
   * not a verified-correct answer.
   */
  async route(userMessage) {
    try {
      const promoted = this.distillation?.getPromotedModel?.();
      if (!promoted) return this._decide({ routedLocally: false, reason: 'no_promoted_model' });

      const allowedSkills = (promoted.skills || []).filter(s => !this.skillExclude.has(s));
      const matchedSkill = this._matchSkill(userMessage, allowedSkills);
      if (!matchedSkill) return this._decide({ routedLocally: false, reason: 'no_skill_match' });

      if (!(await this.isAvailable())) {
        return this._decide({ routedLocally: false, reason: 'ollama_unavailable', matchedSkill });
      }

      const prompt =
        'Prefix your reply with exactly one line — "CONFIDENCE: high", "CONFIDENCE: medium", or ' +
        '"CONFIDENCE: low" — based on how sure you are this matches a pattern you were trained on, ' +
        `then answer.\n\n${userMessage}`;

      const raw = await this._generate(promoted.modelName, prompt);
      if (raw == null) return this._decide({ routedLocally: false, reason: 'local_generate_failed', matchedSkill });

      const confMatch = raw.match(CONFIDENCE_RE);
      const confidence = confMatch ? confMatch[1].toLowerCase() : null;
      if (confidence !== 'high') {
        return this._decide({ routedLocally: false, reason: `confidence_${confidence || 'missing'}`, matchedSkill });
      }

      const answer = raw.replace(CONFIDENCE_RE, '').trim();
      if (!answer) return this._decide({ routedLocally: false, reason: 'empty_answer', matchedSkill });

      return this._decide({ routedLocally: true, matchedSkill, model: promoted.modelName, answer });
    } catch {
      return this._decide({ routedLocally: false, reason: 'error' }); // fail open — always
    }
  }

  _decide(result) {
    this._lastDecision = result;
    return result;
  }

  /**
   * Feature: local-first mode for sensitive tasks. Unlike route() above —
   * which is advisory and always safe to fall through to cloud on any miss —
   * this is called only when the CALLER (agent.js) has already decided the
   * turn must not leave the device at all (isSensitiveTurn() or an explicit
   * "go local-only" toggle). So the skill-match + confidence gate that keeps
   * route() conservative would be the wrong gate here: those exist to protect
   * against a bad LOCAL answer being silently preferred over a fine CLOUD
   * one, not to protect against staying local. Bypassing them is the point —
   * a forced turn accepts "whatever the local model can offer" rather than
   * risking the alternative of leaving the device altogether.
   *
   * Returns { routedLocally: true, answer, model } on success, or
   * { routedLocally: false, blocked: true, reason } when local isn't usable
   * right now — `blocked: true` is the caller's signal to say so honestly
   * instead of falling back to cloud (see agent.js's Stage -3).
   */
  async routeForced(userMessage) {
    try {
      const promoted = this.distillation?.getPromotedModel?.();
      if (!promoted) return this._decide({ routedLocally: false, blocked: true, reason: 'no_promoted_model' });

      if (!(await this.isAvailable())) {
        return this._decide({ routedLocally: false, blocked: true, reason: 'ollama_unavailable' });
      }

      const raw = await this._generate(promoted.modelName, userMessage);
      if (raw == null) return this._decide({ routedLocally: false, blocked: true, reason: 'local_generate_failed' });

      const answer = raw.replace(CONFIDENCE_RE, '').trim();
      if (!answer) return this._decide({ routedLocally: false, blocked: true, reason: 'empty_answer' });

      return this._decide({ routedLocally: true, forced: true, model: promoted.modelName, answer });
    } catch {
      return this._decide({ routedLocally: false, blocked: true, reason: 'error' });
    }
  }

  /** Text-only completion call. No tools, no function declarations — this is
   *  the structural half of the "no tool access" boundary described above. */
  async _generate(model, prompt) {
    try {
      const res = await fetch(`${this.ollamaHost}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.response === 'string' ? data.response : null;
    } catch {
      return null;
    }
  }

  getContext() {
    if (!this._lastDecision) return '- No routing decision made yet this session.';
    const d = this._lastDecision;
    if (d.blocked) {
      return `- Last turn required local-only (sensitive/local-only mode) but no local model was usable ` +
        `(${d.reason}) — answered with a plain refusal rather than falling back to cloud.`;
    }
    if (d.forced) {
      return `- Last turn was forced local-only (sensitive/local-only mode), routed to "${d.model}", no cloud call made.`;
    }
    return d.routedLocally
      ? `- Last turn routed LOCALLY to "${d.model}" (matched skill: ${d.matchedSkill}).`
      : `- Last turn used the cloud model (local routing declined: ${d.reason}${d.matchedSkill ? `, matched skill: ${d.matchedSkill}` : ''}).`;
  }
}

