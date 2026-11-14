# Divergent Synthesis (DCAS)

`src/core/synthesis.js` implements **Divergent-Convergent Adversarial Synthesis** — a coding
workflow built entirely from primitives this codebase already has (`SwarmManager`, `builder.js`'s
sandboxed `runVerification`, the human-approval-gated pending pattern from `healer.js`).

## Why this exists

Every existing coding agent — Devin, Cursor, Claude Code, this codebase's own `builder.js` verify
loop — follows some shape of **plan → write → test → fix → repeat**, on one implementation path.
Retries vary how hard it tries, not what kind of solution it tries.

DCAS instead:

1. **Branches**, not retries — N sub-agents each implement the same task under a genuinely
   different architectural constraint (`minimal-diff`, `robust-defensive`, `refactor-clean`,
   `library-leverage` by default), each in its own throwaway copy of the project.
2. **Profiles blast radius** — greps the real project tree for who imports/requires each changed
   file, so a branch that "works" but touches code used in a dozen other places is penalized before
   scoring, not left implicit.
3. **Adversarially hardens** each branch — a `breaker` sub-agent writes new edge-case tests aimed
   at that branch's own diff, a `fixer` sub-agent patches it, repeated until the breaker finds
   nothing new for two rounds straight (or a round cap is hit).
4. **Arbitrates**, never auto-applies — one model call sees every branch's score, blast radius, and
   hardening outcome side by side and proposes a merge, explicitly flagging any file where two
   branches made incompatible changes. The proposal sits behind the exact same human-approval gate
   `apply_verified_fix` uses — nothing touches the real project tree until you call
   `apply_synthesis_proposal(id, human_approved=true)`.

A lightweight ledger (`memory/synthesis_ledger.json`, same idea as `skill_ledger.js`'s score-from-
history approach) tracks each strategy's historical win rate and feeds a confidence score on future
proposals — a strategy that keeps winning on this codebase gets weighted up over time.

## Tools

- `divergent_synthesis(task, source_dir, stack?, strategies?, adversarial_rounds?)` — runs the full
  pipeline, returns a ranked branch comparison + arbitration notes. Nothing is applied.
- `apply_synthesis_proposal(proposal_id, human_approved, strategy?)` — writes the recommended (or
  explicitly chosen) branch's changed files into the real project. Requires explicit approval.
- `dismiss_synthesis_proposal(proposal_id)` — discards a proposal and cleans up its branch
  directories. Safe without approval.
- `list_synthesis_proposals()` — full detail on every pending proposal.

## When to use it

This is expensive: N branches × (one sandboxed build/verify + up to `adversarial_rounds` × 2
sub-agent calls each). Reserve it for changes where correctness or blast radius genuinely matters
— core logic, security-sensitive code, anything with wide call-site exposure — not routine edits.
`agent.js`'s system prompt reflects this: the agent is instructed to reach for it only when a
task's difficulty or risk justifies exploring multiple approaches in parallel.

## Honest limits

- Blast-radius and complexity-delta are cheap static heuristics (regex/grep-based), not a real call
  graph or AST diff. They rank branches relative to each other; don't read them as precise.
- The breaker sub-agent's failure count is parsed from its own natural-language report
  (`_extractFailureCount`), not a structured test-runner integration. Unusual test output formats
  make convergence detection approximate.
- Arbitration is a single model call over a text summary of all branches — it does not itself
  re-run any code, it reasons over the scores/diffs already computed in Phases 2–3.

