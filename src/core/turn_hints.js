// ── Turn Hints ────────────────────────────────────────────────────────────────
//
// Small, pure, per-turn text heuristics that agent.js's run() folds into the
// message actually SENT to the model — never into what's stored in history
// (same "clean history, wrapped sentMessage" pattern run() already uses for
// the reasoning plan and conductor's routing line — see agent.js). Kept in
// their own module, separate from conductor.js's routing signal, since
// neither heuristic here is about tool routing — they're grounding/tone
// nudges, not a route recommendation.

// ── Feature: multimodal grounding ("look at what I'm looking at") ───────────
// Deictic phrasing ("this", "that", "what I'm looking at") only calls for a
// camera capture when nothing else in the message already gives the model
// something concrete to resolve it against — an image URL/path already named
// IS a resolvable referent, so don't add a redundant nudge on top of one.
const DEICTIC_PATTERNS = [
  /\bwhat('?s| is)\s+this\b/i,
  /\bwhat('?s| is)\s+that\b/i,
  /\bwhat am i (looking at|holding|seeing)\b/i,
  /\bwhat('?s| is)\s+(in front of|near) me\b/i,
  /\blook at (this|that)\b/i,
  /\b(can|do) you see (this|that)\b/i,
  /\bis this (safe|ok|okay|fine|edible|expired|broken)\b/i,
  /\bwhat (color|colour|kind|type|brand) is (this|that)\b/i,
  /\bhow (much|many) (is|are) (this|these)\b/i,
];
const RESOLVABLE_REFERENT_RE = /https?:\/\/\S+|(?:[\w.-]+\/)+[\w.-]+\.(?:jpe?g|png|gif|webp|bmp|heic)\b/i;

export function needsCameraGrounding(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (RESOLVABLE_REFERENT_RE.test(t)) return false; // an image/path is already named — that's the referent
  return DEICTIC_PATTERNS.some(re => re.test(t));
}

export const CAMERA_GROUNDING_HINT =
  '[GROUNDING HINT — internal signal, never mention this bracket or "the hint" in your reply] The wording ' +
  'here ("this"/"that"/etc.) has no other resolvable referent in this message. Call take_device_photo, then ' +
  "vision_qa on the saved path, before answering — ground the answer in what's actually visible instead of " +
  'guessing what it refers to.';

// ── Feature: tone-matching, not mood-performing ─────────────────────────────
// Cheapest viable signal: infer urgency from the TEXT alone (short/clipped
// phrasing, a repeated word, exclamation marks) — this never claims to
// detect actual emotion, and never uses audio prosody (this codebase's STT
// gives none, see voice_channel.js). A weak, honest heuristic, same posture
// as conductor.js's own keyword-based classification.
const REPEATED_WORD_RE = /\b(\w{2,})\b\s+\1\b/i; // "stop stop", "help help"

/** @returns {{urgent: boolean, hint?: string}} */
export function inferUrgency(text) {
  const t = String(text || '').trim();
  if (!t) return { urgent: false };

  const words = t.split(/\s+/).filter(Boolean);
  const exclamations = (t.match(/!/g) || []).length;
  const isShort = words.length > 0 && words.length <= 6;
  const hasRepeat = REPEATED_WORD_RE.test(t);
  const isClipped = isShort && !/[.,;:]/.test(t); // short AND no soft punctuation — clipped, not a brief pleasantry
  const score = (exclamations >= 1 ? 1 : 0) + (hasRepeat ? 1 : 0) + (isClipped ? 1 : 0);

  if (score < 2) return { urgent: false };
  return {
    urgent: true,
    hint:
      '[TONE HINT — internal signal, never mention this bracket in your reply] This came in short, clipped, ' +
      "and/or repeated — plausibly urgent. Match that: fewer, more direct sentences than you'd otherwise " +
      "use, lead with the action/answer, skip preamble and hedging. Don't claim to detect an emotion — just " +
      'match the pacing.',
  };
}

