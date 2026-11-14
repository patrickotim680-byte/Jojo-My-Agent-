// ── Second Opinion Engine ───────────────────────────────────────────────────
//
// Feature: Cross-Vendor Independent Verification
//
// Every other verification layer in this codebase — review_board.js's
// specialists + devil's advocate, synthesis.js's arbitration, self_model.js's
// confidence checks, every apply_* gate's "show the human first" pattern —
// is still the SAME underlying model checking its own work from a different
// angle. That's genuinely useful (see review_board.js's header), but it
// can't catch something the model is systematically, confidently wrong about
// regardless of which hat it's wearing. Different framing, same blind spots.
//
// puter_client.js already routes every call through puter.ai.chat(), which
// Puter fans out to 500+ models across vendors (OpenAI, Google, xAI,
// Mistral, DeepSeek, and more) behind the exact same call shape. A genuinely
// independent check — different architecture, different training data,
// different failure modes — is a `model:` argument away. This module is
// that: it asks a model from a DIFFERENT vendor than the one doing the work
// (DEFAULT_MODEL in puter_client.js) to look at a plan/diff/action fresh and
// say whether it sees a problem, with no stake in having produced it.
//
// HOW THIS COMPOSES WITH THE REST OF THE CODEBASE:
//   Wired as a mandatory pre-human-review pass into the three highest-stakes
//   gates: deploy.js's prepareDeployment() production path, browser.js's
//   act() irreversible-action path, and synthesis.js's run() before a
//   proposal is queued. In all three, this ADDS an opinion — it never
//   auto-blocks and never replaces the existing human_approved=true gate.
//   A DISAGREE verdict is surfaced to the human alongside everything else
//   they were already going to review; it does not stop the pending
//   plan/action/proposal from being created, because a second model being
//   wrong is also possible and the human should see the disagreement itself,
//   not have it silently filtered.
//
// HONEST LIMITS:
//   - This is not infallibility. It's "two independent failure modes have to
//     both miss it" — much better odds than one model checking itself, but
//     still odds, not a guarantee. A CONCUR verdict means "an independent
//     model didn't spot a problem," not "there is no problem."
//   - Full extra model call on an already-expensive gate (deploy plans,
//     irreversible browser actions, synthesis proposals are already costly
//     to produce). That cost is the point — these are exactly the places
//     where paying for one more independent look is worth it — but it's not
//     free, and this module deliberately does NOT get called on routine
//     work.
//   - Not every model Puter routes to handles tool-calling the same way, so
//     this pass is deliberately kept to a plain judgment call: no tools are
//     given to the second-opinion model (see _ask() — generateContent() is
//     called directly, never startChat() with a tools array). It reads what
//     it's given and reasons over it; it cannot go inspect the codebase
//     itself. Treat its verdict as bounded by exactly the material it was
//     handed, same caveat as review_board.js's specialists.
//   - Vendor diversity depends on what Puter actually routes SECOND_OPINION_MODELS
//     to today — Puter's backing model list can change. _isDifferentVendor()
//     is a simple prefix heuristic (reject anything starting with "claude"),
//     not a live registry check.
//   - If every candidate model in the list fails (rate limit, Puter routing
//     issue, model retired) this returns { ok: false } rather than silently
//     falling back to the same vendor doing the work — see _ask(). A gate
//     that calls this should treat that failure as "no second opinion was
//     obtained," not as a passing verdict, and say so plainly to the human.
//   - _parseVerdict() is a heuristic text parse of the second-opinion
//     model's own reply, not a structured/enforced output format — same
//     approach and same caution as review_board.js's _parseVerdict().

const VERDICT_TOKENS = ['DISAGREE', 'CONCERNS', 'CONCUR']; // check in this order — most specific first

// Puter model strings, deliberately NOT Anthropic — see _isDifferentVendor().
// Ordered as a fallback chain: if the first errors out (rate limit, routing
// hiccup, model retired on Puter's end), the next is tried.
const DEFAULT_SECOND_OPINION_MODELS = [
  'gpt-4o',
  'gemini-1.5-pro',
  'grok-2',
  'mistral-large-latest',
  'deepseek-chat',
];

function candidateModels() {
  const override = process.env.SECOND_OPINION_MODELS;
  if (override) return override.split(',').map(m => m.trim()).filter(Boolean);
  return DEFAULT_SECOND_OPINION_MODELS;
}

function isDifferentVendor(model) {
  return typeof model === 'string' && !model.toLowerCase().startsWith('claude');
}

export class SecondOpinionEngine {
  /** @param {object} genAI - PuterAI instance (same shared client the rest of the agent uses). */
  constructor({ genAI }) {
    this.genAI = genAI;
    this.log = []; // recent opinions, most recent last — for getContext()
  }

  /**
   * Ask an independent, different-vendor model to look at something and
   * flag problems fresh. Never throws — callers get { ok:false, error }
   * instead so a gate can decide how to present "no second opinion obtained"
   * without a try/catch at every call site.
   *
   * @param {string} subject   - short label, e.g. "production deployment plan".
   * @param {string} detail    - the actual material to review (plan, diff, dry-run report).
   * @param {string} [question] - what to specifically ask; defaults to a general safety/correctness prompt.
   * @param {string[]} [models] - override the default cross-vendor fallback chain.
   */
  async getSecondOpinion({ subject, detail, question, models }) {
    if (!subject || !detail) return { ok: false, error: 'subject and detail are required.' };
    const chain = (models && models.length ? models : candidateModels()).filter(isDifferentVendor);
    if (!chain.length) {
      return { ok: false, error: 'No cross-vendor model available to ask — every candidate resolved to the same vendor already doing the work.' };
    }

    const prompt =
      `You are being asked for an INDEPENDENT second opinion on something another AI system just produced. ` +
      `You did not write this and have no stake in it being approved — your job is to look at it fresh and ` +
      `say plainly whether you see a real problem.\n\n` +
      `Subject: ${subject}\n\n${detail}\n\n` +
      `${question || 'Would you approve this as-is? Point out anything concrete that looks wrong, risky, or ' +
        'missing — not style preferences. If you genuinely see nothing wrong after actually considering it, ' +
        'say so plainly rather than inventing a minor objection to seem thorough.'}\n\n` +
      `Start your reply with EXACTLY ONE of these words: DISAGREE, CONCERNS, or CONCUR. DISAGREE means you ` +
      `would not approve this — there's a real problem. CONCERNS means approvable but with specific things ` +
      `the human should double check first. CONCUR means you don't see a significant issue. Then give a ` +
      `short, concrete rationale.`;

    let lastError = null;
    for (const model of chain) {
      try {
        const text = await this._ask(model, prompt);
        const entry = {
          subject, model, verdict: this._parseVerdict(text), rationale: text,
          askedAt: new Date().toISOString(),
        };
        this.log.push(entry);
        if (this.log.length > 20) this.log.shift();
        return { ok: true, ...entry };
      } catch (err) {
        lastError = err;
        continue; // try the next model in the fallback chain
      }
    }
    return { ok: false, error: `Every candidate model failed. Last error: ${lastError?.message || 'unknown'}` };
  }

  /** Single-shot, no-tools call — see HONEST LIMITS on why this never gets a tools array. */
  async _ask(model, prompt) {
    const wrapper = this.genAI.getGenerativeModel({ model });
    const { response } = await wrapper.generateContent(prompt);
    const text = response.text();
    if (!text || !text.trim()) throw new Error(`Model "${model}" returned an empty response.`);
    return text.trim();
  }

  _parseVerdict(text) {
    const head = String(text || '').trim().toUpperCase();
    for (const token of VERDICT_TOKENS) {
      if (head.startsWith(token)) return token;
    }
    for (const token of VERDICT_TOKENS) {
      if (head.includes(token)) return token;
    }
    // Ambiguous output — default to the cautious middle ground rather than
    // guessing CONCUR, same "when unsure, bias toward the gated path"
    // philosophy as browser.js's _classifyReversibility / review_board.js.
    return 'CONCERNS';
  }

  /** Formats a getSecondOpinion() result for inclusion in a plan/proposal
   *  summary a human is about to review. Handles the ok:false case plainly
   *  rather than hiding it. */
  format(result) {
    if (!result) return 'No second opinion was requested.';
    if (!result.ok) return `Second opinion NOT obtained (${result.error}). Treat this as unverified by an independent model, not as a pass.`;
    return `Second opinion (${result.model}): ${result.verdict}\n${result.rationale}`;
  }

  getContext() {
    if (!this.log.length) return '(no second opinions requested yet)';
    return this.log.slice(-5).map(e =>
      `[${e.askedAt}] "${e.subject}" → ${e.verdict} (asked ${e.model})`
    ).join('\n');
  }
}

