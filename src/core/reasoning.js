import { DEFAULT_MODEL } from './puter_client.js';

// ── ReasoningEngine ────────────────────────────────────────────────────────────
// A deliberate "thinking" layer that runs extra hidden model calls around the
// normal agent turn for non-trivial requests:
//
//   1. classify  — free, heuristic-only tiering (fast / standard / deep)
//   2. decompose — restate the goal, surface assumptions, build a short plan
//   3. critique  — a separate hidden pass tries to find real problems in the
//                  draft answer (factual gaps, missed requirements, errors)
//   4. refine    — only if real issues were found, rewrite to fix them
//
// This is the same family of technique behind "Self-Refine" and "Reflexion"
// (Madaan et al. 2023 / Shinn et al. 2023): forcing plan → critique → revise
// instead of one-shot generation reliably improves output quality, because a
// second look catches things a first pass misses — the same reason a human
// editor improves a first draft.
//
// HONEST LIMITS (read this before tuning expectations):
//   - This does NOT change the underlying model's weights or raw capability.
//     A harder problem than the base model can solve in 4 calls, it still
//     can't solve in 4 calls — it can just check its own work more carefully.
//   - Every extra stage costs one more API call (latency + tokens). That's
//     why classify() exists: trivial messages ("hey", "thanks") skip all of
//     this and cost nothing extra.
//   - All stages "fail open": if a stage errors or returns garbage, the
//     pipeline falls back to the normal answer rather than blocking the user.

const FAST_GREETING = /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|nice|lol|bye|good night|good morning)\b/i;

const DEEP_KEYWORDS = [
  'prove', 'design', 'architect', 'debug', 'compare', 'plan', 'strategy',
  'optimi', 'analyz', 'analys', 'why does', 'why is', 'why doesn\'t',
  'in depth', 'step by step', 'think carefully', 'think hard', 'trade-off',
  'tradeoff', 'pros and cons', 'evaluate', 'derive', 'algorithm', 'refactor',
  'review my', 'write a function', 'write code', 'fix this bug', 'root cause',
  'edge case', 'architecture', 'multi-step', 'reasoning',
];

export class ReasoningEngine {
  constructor(genAI) {
    this.genAI = genAI;
    this.lastTrace = null; // { tier, plan, critique, refined } — inspectable via "trace" CLI command
  }

  _getModel(temperature, maxOutputTokens) {
    return this.genAI.getGenerativeModel({
      model: process.env.PUTER_MODEL || DEFAULT_MODEL,
      generationConfig: { temperature, maxOutputTokens },
    });
  }

  async _ask(prompt, { temperature = 0.2, maxOutputTokens = 600, json = false } = {}) {
    const model  = this._getModel(temperature, maxOutputTokens);
    const result = await model.generateContent(prompt);
    const text   = result.response.text().trim();
    if (!json) return text;

    const cleaned = text.replace(/```json\n?|```/g, '').trim();
    try { return JSON.parse(cleaned); }
    catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
      return null;
    }
  }

  // ── 1. Tier classification — heuristic only, ZERO extra API calls ─────────
  classify(userMessage = '') {
    const msg = (userMessage || '').trim();
    if (!msg) return 'fast';
    if (msg.length < 16 && FAST_GREETING.test(msg)) return 'fast';
    if (msg.length < 25 && !/[?]/.test(msg) && !/\d/.test(msg)) return 'fast';

    const lower      = msg.toLowerCase();
    const hasKeyword = DEEP_KEYWORDS.some(k => lower.includes(k));
    const multiPart  = (msg.match(/\?/g) || []).length > 1 || /\b(and also|and then)\b/i.test(msg);
    const hasMath     = msg.length > 15 && /\d/.test(msg) && /[=+\-*/^]/.test(msg);
    const long        = msg.length > 280;

    if (hasKeyword || multiPart || hasMath) return 'deep';
    if (long || msg.length > 60) return 'standard';
    return 'fast';
  }

  // ── 2. Decompose into a short working plan ─────────────────────────────────
  async decompose(userMessage, contextSummary = '') {
    const prompt = `You are the internal planning module of an AI agent named Jojo. Do NOT answer the user yet — only plan.

Relevant context Jojo already has (memory/knowledge, may be empty — ignore if irrelevant):
${(contextSummary || '').slice(0, 1200) || '(none)'}

User request:
"""${userMessage}"""

Respond ONLY with valid JSON, no markdown fences, no extra text:
{
  "restated_goal": "one sentence — what does the user actually need, in your own words",
  "assumptions": ["assumption you're making 1", "assumption 2"],
  "subgoals": ["concrete step 1", "concrete step 2", "concrete step 3"],
  "watch_out_for": ["specific risk, edge case, or common mistake to avoid 1", "..."]
}`;
    try {
      return await this._ask(prompt, { temperature: 0.2, maxOutputTokens: 500, json: true });
    } catch {
      return null; // fail open
    }
  }

  formatPlan(plan) {
    if (!plan) return '';
    return [
      plan.restated_goal ? `Goal: ${plan.restated_goal}` : '',
      plan.assumptions?.length ? `Assumptions: ${plan.assumptions.join('; ')}` : '',
      plan.subgoals?.length ? `Plan:\n${plan.subgoals.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}` : '',
      plan.watch_out_for?.length ? `Watch out for: ${plan.watch_out_for.join('; ')}` : '',
    ].filter(Boolean).join('\n');
  }

  // ── 3. Critique a draft answer — find REAL problems only ──────────────────
  async critique(userMessage, draftAnswer) {
    const prompt = `You are a harsh, expert reviewer. Find REAL problems only — never invent issues just to have something to say. If the answer is genuinely solid, say so.

User request:
"""${userMessage}"""

Draft answer:
"""${(draftAnswer || '').slice(0, 4000)}"""

Respond ONLY with valid JSON, no markdown fences:
{
  "has_issues": true or false,
  "issues": ["specific concrete problem (factual error / logical gap / unjustified claim / missed requirement)", "..."],
  "fix_instructions": "one short paragraph telling the writer exactly what to change — empty string if no issues"
}`;
    try {
      return await this._ask(prompt, { temperature: 0.15, maxOutputTokens: 500, json: true });
    } catch {
      return null; // fail open
    }
  }

  // ── 4. Refine using the critique ───────────────────────────────────────────
  async refine(userMessage, draftAnswer, critique) {
    const prompt = `Rewrite the draft answer to fix ONLY the listed issues. Keep everything that was already correct and keep the same tone/length ballpark. Output ONLY the improved final answer — no preamble, no meta-commentary about the rewrite, no mention that this was revised.

User request:
"""${userMessage}"""

Draft answer:
"""${(draftAnswer || '').slice(0, 4000)}"""

Issues to fix:
${(critique.issues || []).map(i => `- ${i}`).join('\n')}

Fix instructions: ${critique.fix_instructions || ''}`;
    try {
      const improved = await this._ask(prompt, { temperature: 0.4, maxOutputTokens: 2048, json: false });
      return improved && improved.trim().length > 20 ? improved.trim() : null;
    } catch {
      return null; // fail open
    }
  }
}

