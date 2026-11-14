// conductor.js — a thin routing layer, NOT another tool the model has to
// remember to call. It runs once per turn, before the tool loop, and injects
// one explicit recommendation line into that turn's context.
//
// THE GAP THIS CLOSES:
// reasoning.js's classify() already tiers every message fast/standard/deep,
// for free (no model call), to decide plan→critique→refine depth. But that
// tier never informed whether swarm, divergent_synthesis, or second_opinion
// get invoked — those tools each carry their own "when to use me" text in
// their declaration.description, and the model picks between three
// overlapping "get multiple takes, reconcile" tools from vibes each turn,
// with no shared signal about what KIND of hard this particular task is.
//
// WHAT THIS DOES NOT DO:
//   - It does not call the model. classifyTask() is exactly as heuristic-only
//     as reasoning.js's own classify(), which it wraps rather than duplicates
//     — same "free, zero extra latency" posture, extended with two more axes.
//   - It does not force a tool call. The model keeps final say, same as
//     everywhere else in this codebase's tool-calling design — this only
//     removes the guessing by making the signal explicit instead of
//     implicit-in-description-text. A wrong recommendation costs nothing
//     more than the model choosing not to follow it.
//   - It is not a replacement for reasoning.js — tier still drives
//     plan→critique→refine exactly as before; this only ADDS reversibility/
//     ambiguity on top and turns all three into one routing line.
//
// HONEST LIMITS: the reversibility/ambiguity heuristics below are keyword
// lists, same class of heuristic as reasoning.js's own DEEP_KEYWORDS — they
// will miscategorize novel phrasing. That's an acceptable failure mode
// specifically because this only ever produces a RECOMMENDATION the model
// can override, not a hard gate — the actual safety gates (ApprovalGate,
// human_approved=true) are enforced elsewhere, unconditionally, regardless
// of what this module guesses.

const IRREVERSIBLE_KEYWORDS = [
  'deploy', 'production', 'prod', 'delete', 'drop table', 'destroy', 'teardown',
  'send sms', 'text ', 'make a call', 'call ', 'publish', 'push to main',
  'push to prod', 'rm -rf', 'apply fix', 'apply_fix', 'merge to main', 'ship it',
];

const AMBIGUOUS_KEYWORDS = [
  'not sure', 'which is better', 'which one', 'compare', 'options', 'should i',
  'thoughts on', 'evaluate', 'pros and cons', 'best way', 'what do you think',
  'trade-off', 'tradeoff', 'weigh', 'undecided',
];

// Rough "this needs real code reasoning, not casual chat" signal — reuses the
// same spirit as reasoning.js's own DEEP_KEYWORDS rather than inventing a
// parallel list, extended with a few code-specific terms it doesn't cover.
const CODE_KEYWORDS = [
  'code', 'function', 'refactor', 'debug', 'bug', 'algorithm', 'class ',
  'component', 'api', 'script', 'regex', 'compile', 'error:', 'exception',
  'stack trace', 'unit test', 'write a program',
];

// ── Feature: local-first mode for sensitive tasks ───────────────────────────
// Same class of heuristic as the two lists above — a short, honest keyword
// list, not intent understanding. Deliberately possessive-phrased ("my
// health", "my bank") rather than bare topic words ("health", "bank") to cut
// down on false positives on unrelated general-knowledge questions ("what's
// a healthy breakfast", "bank of a river") — see local_router.js's
// routeForced() for what happens once a turn is flagged.
const SENSITIVE_KEYWORDS = [
  'my messages', 'my texts', 'read my texts', 'my medical', 'my health record', 'my diagnosis',
  'my symptoms', 'my prescription', 'my medication', 'my therapy', 'my therapist', 'my mental health',
  'my bank', 'my account balance', 'my salary', 'my finances', 'my taxes', 'my credit card',
  'my password', 'my ssn', 'social security number',
];

export function isSensitiveTurn(userMessage = '') {
  const lower = (userMessage || '').toLowerCase();
  return SENSITIVE_KEYWORDS.some(k => lower.includes(k));
}

export class Conductor {
  /** @param {object} opts.reasoning - the shared ReasoningEngine instance (reused, not duplicated)
   *  @param {object} [opts.executionTrace] - optional ExecutionTraceLedger to log routed turns into */
  constructor({ reasoning, executionTrace } = {}) {
    this.reasoning = reasoning;
    this.executionTrace = executionTrace;
  }

  /** Zero extra model calls — reuses reasoning.classify()'s existing tier,
   *  adds reversibility + ambiguity as two more free heuristic axes, and
   *  folds all three into one suggested route. */
  classifyTask(userMessage = '', precomputedTier = null) {
    const tier = precomputedTier ?? this.reasoning?.classify?.(userMessage) ?? 'standard';
    const lower = (userMessage || '').toLowerCase();

    const reversible = !IRREVERSIBLE_KEYWORDS.some(k => lower.includes(k));
    const ambiguous = AMBIGUOUS_KEYWORDS.some(k => lower.includes(k)) || tier === 'deep';
    const complexity = tier === 'fast' ? 'low' : tier === 'standard' ? 'medium' : 'high';

    let route = 'direct';
    if (!reversible) {
      // Deliberately NOT gated on tier — reasoning.js's classify() can call a
      // short, casually-phrased message 'fast' even when it names a
      // destructive action (see conductor.js's own test: "Deploy this to
      // production and delete the old workflow" comes back tier='fast', since
      // it's under the length/keyword thresholds classify() uses). Letting
      // tier gate this would mean the exact case that most needs caution —
      // something irreversible said briefly — is the case most likely to
      // slip through as low-stakes. Irreversibility alone is reason enough.
      route = 'second_opinion+review_board';
    } else if (ambiguous && tier !== 'fast') {
      route = 'swarm';
    }

    const codeHeavy = tier !== 'fast' && CODE_KEYWORDS.some(k => lower.includes(k));
    // Best-effort keyword match, same honest limits as everything else in
    // this file. 'puter' specifically because that's this setup's free path
    // to Claude — not a principled "best model for code" ranking, just
    // "prefer Claude for non-trivial code work when it's configured, and let
    // the normal fallback chain in puter_client.js handle it otherwise."
    const preferredProvider = codeHeavy ? 'puter' : null;
    const sensitive = isSensitiveTurn(userMessage);

    return { tier, complexity, reversible, ambiguous, codeHeavy, preferredProvider, sensitive, route };
  }

  /** One line, injected into this turn's system-prompt context — the
   *  explicit shared signal that was previously implicit-or-absent. */
  describeRoute(classification) {
    const { complexity, reversible, ambiguous, route } = classification;
    const base = `complexity=${complexity} reversible=${reversible} ambiguous=${ambiguous} → suggested route: ${route}.`;
    if (route === 'swarm') {
      return `${base} Genuinely multi-faceted/ambiguous — spawn_subagent_swarm is likely worth its cost here, ` +
        `more than guessing which single angle to take.`;
    }
    if (route === 'second_opinion+review_board') {
      return `${base} High-stakes AND looks irreversible — get a second opinion and/or a review_board pass ` +
        `before anything approval-gated, don't rely on a single read of it.`;
    }
    return `${base} Straightforward enough that direct tool calls should suffice — swarm/synthesis would ` +
      `likely just add latency without a better answer here.`;
  }

  /** Call once the turn actually finishes, so self_model.js's reflect() has
   *  real route→outcome data instead of none. Fails soft — a missing ledger
   *  just means this turn isn't recorded, never throws into the main loop. */
  recordOutcome(taskId, classification, { toolsUsed = [], outcome = 'unknown' } = {}) {
    try {
      this.executionTrace?.record({ taskId, ...classification, toolsUsed, outcome });
    } catch { /* logging a trace entry should never break the actual turn */ }
  }
}

