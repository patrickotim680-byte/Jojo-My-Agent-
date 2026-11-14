# n8n Workflow Automation (Real Workflows, Not Simulated)

`src/core/n8n.js` gives JOJO a real n8n instance to build against — provision it locally, or point at
one that already exists — and real workflow CRUD + verification through n8n's own REST API. Same
safety spine as `deploy.js` and `builder.js`: verify first, gate the irreversible path behind human
approval, log everything.

## Why this exists

A workflow-automation agent is only as trustworthy as its claim that a workflow actually runs. This
module treats "created" and "working" as two different, separately-earned claims:

1. **Provisioning is local and reversible.** `n8n_provision` runs `docker compose up -d` on this
   machine — nothing talks to a third-party cloud account. `n8n_teardown` reverses it; the data volume
   (workflows/credentials/execution history) is kept by default.
2. **Verify-first.** `n8n_create_workflow` only creates a workflow — inactive. `n8n_verify_workflow`
   actually activates it, and for a webhook-triggered workflow, fires a real HTTP request at it and
   polls n8n's own execution log until that specific run reports success (or the poll window runs
   out). A workflow that was created but never verified is reported as exactly that.
3. **Nothing destructive without approval.** Deleting a workflow, or tearing down the container WITH
   its volume, requires `human_approved=true` — the first call without it returns a pending `plan_id`
   and changes nothing, same pattern as `apply_deployment`.
4. **Persistent ledger.** Every provision/create/activate/verify/delete is logged to
   `memory/n8n_ledger.json` so both JOJO and the human can see what's actually running and where.

## Tools

- `n8n_provision(port?)` / `n8n_configure(base_url, api_key)` / `n8n_teardown(destroy_volume?, human_approved?)`
- `n8n_create_workflow(workflow)` / `n8n_import_workflow(workflow_json)`
- `n8n_verify_workflow(workflow_id, test_payload?)`
- `n8n_list_workflows()` / `n8n_delete_workflow(workflow_id, human_approved?)`
- `list_pending_n8n_actions()` / `dismiss_n8n_action(plan_id)`

## The one manual step

n8n has no public API to create its first ("owner") account or mint the initial API key — that's
deliberately UI-only, on n8n's end, for security, not a JOJO limitation. After `n8n_provision`, JOJO
prints the exact one-time steps: open the URL, create the owner account, Settings → API → create an
API key. Hand that key to `n8n_configure` and no browser step is needed again.

## Honest limits

- Workflow JSON (nodes/connections) is authored by the model itself — this module's job is transport
  (create/get/activate/delete) and verification (trigger + poll), not authoring. A malformed workflow
  fails at n8n's own validation and that error is surfaced verbatim, not swallowed.
- "Verified" for a webhook-triggered workflow means: activated, a real HTTP request was sent, and
  n8n's execution log shows that specific execution finished with status `success` — not a guarantee
  every branch/node in the workflow was exercised.
- Manual- or schedule-triggered workflows can't be poked via a webhook call — verification falls back
  to confirming clean activation and lists the trigger type, and says so plainly rather than claiming
  an execution test that didn't happen.
- Assumes Docker is installed and the daemon is running; this module does not install Docker itself.
- Never tested against a live n8n instance in the environment this was written in — the REST API
  shape follows n8n's documented `/api/v1` routes, but check the exact response shape if something
  errors as unexpected on your version.

