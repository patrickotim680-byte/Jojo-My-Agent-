# Large App Orchestrator

`src/core/orchestrator.js` takes a big app spec, breaks it into a dependency-ordered module graph,
and builds it in parallel waves — composed entirely out of pieces this codebase already has, rather
than reimplementing them.

## Why this exists

A single implementer pass on a big spec tends to either undersize the result or lose track of
structure. This decomposes first, builds concurrently where nothing depends on anything else in the
same wave, and integration-checks after every wave instead of only at the end:

1. **Decomposition.** `plan_large_app` asks one architect sub-agent to break a spec into modules in a
   fixed, parseable line format. A response that doesn't parse degrades to one "app" module covering
   the whole target directory rather than silently doing nothing.
2. **Dependency-ordered parallel waves.** A real topological sort (Kahn's algorithm) over the
   declared dependencies groups modules into waves — everything in a wave builds concurrently, one
   sub-agent per module, scoped to its own subdirectory. A dependency cycle doesn't hang forever; the
   leftover modules land in one final wave instead.
3. **Integration verification after every wave.** Not just at the end — `runVerification` runs
   against the *whole* target directory after each wave, catching a module breaking something built
   earlier immediately.
4. **Composes with what already exists**, rather than duplicating it: progress is tracked as one real
   task on the existing `tasks.js` task board (not a parallel tracker), and `use_synthesis_for` lets
   specific high-stakes modules route through `divergent_synthesis` instead of a single pass.

## Tools

- `plan_large_app(spec)` — returns the module breakdown for human review before building.
- `build_large_app(spec, target_dir, use_synthesis_for?, review_after_build?)` — builds it.

## Honest limits

- `_parseModules()` is a heuristic parse of the architect's own text in a requested format, not an
  enforced schema. If you see the single-module fallback kick in, the spec was probably too vague
  for a useful breakdown — try again with more structure.
- Does NOT route every module through `divergent_synthesis` or `review_code` by default — that would
  be extremely expensive for a multi-module app. Only `use_synthesis_for`-listed modules get the full
  pipeline; `review_after_build` (default on) runs ONE review pass over the finished app as a whole,
  not per-module.
- "Integration verified" only means the project's own build/test pipeline still passes — thin test
  coverage means thin confidence, not a functional-correctness guarantee.
- Never deploys anything — see `DEPLOYMENT.md` for that, kept as a deliberately separate,
  separately-gated step.

