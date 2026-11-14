# Rollout Sandbox (Simulate For Real Before Committing)

`src/core/rollout_sandbox.js` runs a candidate action for real, inside a throwaway fork, and
reports what actually happened — instead of one more round of text reasoning about what might.

## Why this exists

Every other layer in this codebase that reasons about a risky action does so in TEXT:
`reasoning.js`'s plan → critique → refine is three hidden model calls, never an execution.
`browser.js`'s dry-run reads a form's current field values without submitting it. `deploy.js`'s
`prepareDeployment()` runs a generic build/test pass, not the actual deploy command. That's real
diligence, but it's still a guess dressed up as a check — "think, then act, then hope."

`healer.js` already does better than that, for exactly one call site: a self-heal candidate is
copied into a throwaway directory, actually installed/built/tested inside a Docker sandbox (see
`builder.js`'s `verifyCandidateFix` + `core/sandbox.js`), and only a fix that genuinely passed is
ever surfaced. This module generalizes that one pattern — snapshot → real execution in a
throwaway fork → diff predicted vs actual → (for several candidates) parallel forks scored against
each other — into a first-class layer any risky call can go through, not just self-heal fixes.

## The four `action_kind`s

- **`project_action`** — generalizes healer.js/builder.js's own pattern to any file-rewrite-
  and/or-verify action. Copies the real project dir into a throwaway temp dir, applies the
  candidate's file edits there (if any), and runs the real install/build/test pipeline (or a
  custom command) inside a Docker sandbox against the copy — never the real tree.
- **`deploy_preview`** — generalizes `apply_deployment`. Runs `deploy.js`'s own
  `prepareDeployment()` with the environment forced to `preview` — a real, disposable deploy
  against a throwaway URL — and hands back what actually happened. Committing chains into
  `deploy.js`'s own, unmodified production gate; this never bypasses `apply_deployment`.
- **`world_watch`** — generalizes `world_watch_add`. Runs the exact real check (file stat / dir
  listing / shell command / URL fetch / MCP resource read) a live watch would run, once, before
  ever registering the recurring watch — see `WorldModel.previewWatch()`.
- **`browser_action`** — generalizes `apply_browser_action`. Forks a new, isolated browser session
  carrying the same storage state (cookies/login) as the live one, and actually performs the
  classified-irreversible action there — the real click/fill/select, not a dry-run field read —
  then dual-ground-reads the real resulting page.

For N>1 candidates, every fork runs in parallel (`Promise.allSettled` — one hanging/erroring
candidate never blocks the rest, same shape as `swarm.js`'s `_runSubAgent`), and once every real
outcome is in, a single hidden model call scores the ACTUAL results against each other and ranks
them — the same arbitration shape as `swarm.js`'s `_arbitrate`, except this scores what really
happened, not what several sub-agents said.

Nothing here auto-commits, with one disclosed exception. `simulate()` only ever produces a pending
rollout record — same human-approval-gated pattern as `apply_verified_fix` / `apply_deployment` /
`apply_browser_action`. `apply_rollout` is what actually commits the winning (or explicitly
chosen) candidate for real against the live target.

## Honest limits

- This is a layer OVER the existing gates, not a replacement for them. Committing a
  `project_action` rollout still just calls `applyFilesToDir` against the real tree; committing a
  `deploy_preview` rollout still funnels into `deploy.js`'s own gated production plan.
- Forking is only genuinely free/reversible for `project_action`, `world_watch`, and (per
  `deploy.js`'s own classification) most `deploy_preview` candidates. It is **not** free for
  `browser_action` — a real website has no throwaway copy of itself, so "forking" only isolates
  Jojo's own session/process boundary, not the target server's view of what happened. Executing
  that fork IS the real, one-time side effect — `simulate_rollout` refuses this kind outright
  unless `human_approved=true` is passed up front, same rule as `apply_browser_action`.
- fly.io deploys have no distinct preview mode (see `deploy.js`) — a `deploy_preview` candidate
  targeting provider `fly` cannot be forked for free either; this is reported plainly
  (`pending: true`, nothing executed) rather than silently treated as a successful trial.
- Scoring parallel candidates is one hidden model call over structured real outcomes
  (verification reports, deploy records, page reads) — much less room to hallucinate than judging
  prose plans, but still a model call, not a proof. Treat the ranking as a strong recommendation,
  not a guarantee, same caveat as `swarm.js`'s arbitration.
- `fileDiffs()` is a plain line-count delta per file, not a real unified diff — good enough to see
  the shape of a change at a glance, not a substitute for reading the actual candidate content.

## Tools

- `simulate_rollout(label, action_kind, candidates, human_approved?)` — runs 1-4 candidates for
  real in parallel and returns a pending report.
- `apply_rollout(rollout_id, human_approved, candidate_index?)` — commits the winning (or chosen)
  candidate for real. HARD RULE: only ever call with `human_approved=true` after the human has
  explicitly agreed to the exact report shown to them.
- `dismiss_rollout(rollout_id)` — discards a pending rollout. Safe without approval, except that
  for `browser_action` it cannot undo the real action already taken during `simulate_rollout`.
- `list_pending_rollouts()` — every rollout currently awaiting a decision.

## Wiring

`RolloutSandbox` is instantiated once in `agent.js`'s constructor (`genAI` only — everything else
it touches, `deploy`/`worldModel`/`browser`, is reached per-call via the shared tool context
forwarded through `simulate_rollout`, same reasoning as `SwarmManager` taking `sharedContext`
per-call rather than holding every collaborator itself). `rollout_tools.js` is registered in
`registry.js`. No `init()` call and no persisted ledger — pending rollouts are in-memory only,
same as `browser.js`'s `pendingActions`, capped at `MAX_PENDING_ROLLOUTS` (oldest evicted first).

