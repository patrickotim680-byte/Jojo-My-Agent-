# Second Opinion Engine (Cross-Vendor Independent Verification)

`src/core/second_opinion.js` asks a model from a **different vendor** than the one doing the work
(`DEFAULT_MODEL` in `puter_client.js`) to independently review a plan, diff, or action.

## Why this exists

Every other verification layer in this codebase — `review_board.js`'s specialists + devil's
advocate, `synthesis.js`'s arbitration, `self_model.js`'s confidence checks — is still the *same*
underlying model checking its own work from a different angle. That's genuinely useful, but it
can't catch something the model is systematically, confidently wrong about regardless of framing.

`puter_client.js` already routes every call through `puter.ai.chat()`, which Puter fans out to
500+ models across vendors (OpenAI, Google, xAI, Mistral, DeepSeek, and more) behind the exact same
call shape. A genuinely independent check is a `model:` argument away — this module is that.

## Where it's wired in

Already installed as a **mandatory** pre-human-review pass in the three highest-stakes gates:

1. `deploy.js` — `prepareDeployment()`'s production path (never the reversible `preview` path).
2. `browser.js` — `act()`'s irreversible-action path, run on the dry-run prediction.
3. `synthesis.js` — `run()`, on the winning branch, before the proposal is even queued.

In all three, this only **adds** an opinion — it never auto-blocks and never replaces the existing
`human_approved=true` gate. A `DISAGREE` verdict is surfaced to the human alongside everything else
they were already going to review, not silently filtered.

## Tool

- `get_second_opinion(subject, detail, question?)` — ad hoc use for anything else genuinely
  high-stakes that isn't already covered by the three auto-wired gates above.

## Wiring

`SecondOpinionEngine` is instantiated once in `agent.js`'s constructor (right after `genAI`, before
anything that needs it) and passed into `DivergentSynthesisEngine`, `BrowserSessionManager`, and
`DeployEngine` as an optional constructor argument. `second_opinion_tools.js` is registered in
`registry.js`. No `init()` call and no persistent ledger — `secondOpinion.getContext()` in the
system prompt reports the last few opinions from an in-memory log.

## Honest limits

- Not infallibility — "two independent failure modes have to both miss it," not a guarantee. A
  `CONCUR` verdict means an independent model didn't spot a problem with what it was shown, nothing
  stronger.
- A full extra model call on an already-expensive gate. Deliberately not called on routine work.
- Not every model Puter routes to handles tool-calling the same way, so this pass never gives the
  second-opinion model tools — `generateContent()` only, never `startChat()` with a tools array. It
  reasons over exactly what it's handed and cannot go inspect the codebase itself.
- Vendor diversity depends on what Puter actually routes `SECOND_OPINION_MODELS` to today.
  `_isDifferentVendor()` is a simple prefix heuristic (reject anything starting with `"claude"`),
  not a live registry check.
- If every candidate model in the fallback chain fails, `getSecondOpinion()` returns `{ ok: false }`
  rather than silently passing — callers must treat that as "no second opinion obtained," not as a
  pass. All three wired-in gates already do this correctly; say so plainly if you see `ok: false`.
- `_parseVerdict()` is a heuristic text parse of the second-opinion model's own reply, same caution
  as `review_board.js`'s `_parseVerdict()`.

