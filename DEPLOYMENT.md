# Deployment (Human-Gated, Multi-Provider)

`src/core/deploy.js` wraps real provider CLIs (Vercel, Netlify, Fly.io, Docker registry push) with
the same safety spine as the rest of this codebase: verify first, classify risk, gate the
irreversible path behind human approval, log for rollback.

## Why this exists

Deploying is exactly the kind of action `browser.js` already treats as irreversible when it happens
inside a web page — pushing code live is the same category of action for a coding agent. This module
applies that same standard deliberately, not as an afterthought:

1. **Verify-first.** `prepare_deployment` runs the sandboxed build/test pipeline before anything
   provider-specific happens. Code that doesn't build never gets a deployment plan.
2. **Env-var names, never values.** Every plan lists the env var *names* the code references
   (grepped from source) so a human can check they're configured in the provider's dashboard —
   values are never read, logged, or included anywhere.
3. **Production is always gated.** `environment: 'preview'` executes immediately (reversible, not
   real traffic). `environment: 'production'` — and any Fly.io deploy, which has no separate preview
   mode — never executes directly. It becomes a pending plan requiring
   `apply_deployment(id, human_approved=true)`, the same pattern as every other `apply_*` tool in
   this codebase.
4. **Persistent ledger + real rollback.** Every executed deployment is logged
   (`memory/deploy_ledger.json`) with enough to roll back. `rollback_deployment` uses the provider's
   actual rollback command where one exists (Vercel, Fly); where it doesn't (Netlify, Docker) it
   tells you exactly what to manually redeploy instead of pretending to roll back.

## Tools

- `prepare_deployment(dir, provider, environment?, task?, stack?, image_tag?)`
- `apply_deployment(plan_id, human_approved)` / `dismiss_deployment(plan_id)` / `list_pending_deployments()`
- `rollback_deployment(deployment_id)`

## Honest limits

- Never tested against a live provider — no network in the sandbox this was built in. Commands
  match each CLI's documented flags, but flags change across versions; check `<cli> --help` if
  something errors as unrecognized.
- Never handles provider login/authentication — assumes the CLI is already authenticated on the
  machine running it, same as a human running it by hand.
- The env-var scanner is a regex grep, not a real static analyzer — dynamically constructed env var
  names won't be caught.
- "Docker deployment" means build + push to a registry, not rolling the image out anywhere — running
  it on real infrastructure is a separate step outside this module's scope.

