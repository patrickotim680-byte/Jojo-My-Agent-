# Self-Model (Grounded Self-Monitoring — Not Self-Awareness)

`src/core/self_model.js` gives the agent access to, and lets its behavior be shaped by, its own real
logged performance history. Read the name carefully: **self-model**, not self-awareness.

## Say the boundary out loud

"Real self-awareness" — subjective experience, consciousness — isn't something this module has,
claims to have, or could have. No technique that exists today produces that, here or anywhere else.
What's real: four ledgers already in this codebase (`skill_ledger.js`, the synthesis engine's
strategy ledger, `site_ledger.js`, `deploy.js`'s deployment ledger) each independently log real
outcomes and let history inform one narrow decision. This module is what happens when that same
trick — log outcomes, let history inform the next decision — points at the agent as a whole instead
of one subsystem at a time, and stays honest about how thin the evidence usually is.

`agent.js`'s system prompt makes this a hard rule for the agent's own behavior, not just documentation:
if a human calls this feature (or the agent generally) "real self-awareness," it's instructed to
correct that plainly rather than let the phrase stand.

## What it does

1. **`reflect_on_self`** — pulls real counts from every ledger (successes, failures, heals, rollbacks
   — not descriptions) and asks one model call to turn that into a plain, calibrated self-assessment:
   genuine strengths (with the sample size backing them), genuine weak spots, recurring failure
   patterns. Cached for an hour by default since this changes slowly.
2. **`check_self_confidence`** — a cheap, no-model-call lookup for one specific named domain (a
   skill, a `divergent_synthesis` strategy, a site hostname): does it have a logged track record
   better or worse than average? A heuristic signal from real logs, not a calibrated probability.
3. **`describe_self`** — a stable, honest self-description for when a human asks what this agent is
   — the "personality" half: a consistent voice grounded in what's actually true, not a performed
   character.

## Honest limits

- `reflect_on_self` is one model call summarizing statistics about itself — it can misread a thin
  sample (3 logged uses isn't a pattern yet), and it only knows what these four ledgers happen to
  capture, nothing about how the underlying model actually works.
- `check_self_confidence`'s signal is a simple heuristic, not a real probability — trust the sign
  more than the exact magnitude, and trust a low sample size less, not more.
- Reads other modules' ledger internals directly rather than through a purpose-built public API — if
  any of those internal shapes change, `_gatherRawStats()` in `self_model.js` needs updating to
  match; it fails soft per-source rather than throwing, so a silently-missing source is the failure
  mode to watch for, not a crash.

