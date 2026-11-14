<p align="center">
  <img src="./assets/logo.png" alt="JOJO logo" width="180" />
</p>

<h1 align="center">JOJO</h1>
<p align="center">Autonomous AI agent powered by Claude (via Puter.js)</p>

---

## What's here

JOJO is a terminal-based agent with a self-learning engine, a deliberate
reasoning loop (plan → critique → refine), a multi-task ledger, a visual
widget engine, and a multimodal (vision/audio/doc) toolset. It can also run
as an MCP server so any MCP-compatible IDE can talk to it directly — see
`MCP_AND_PLUGINS.md`.

Two additional capabilities go beyond the normal request-response loop:

- **Sub-agent swarming** (`src/core/swarm.js`) — the model can spawn 2-6
  scoped, ephemeral sub-agents in parallel via `spawn_subagent_swarm`, each
  with its own narrow toolset and isolated context window, then reconciles
  their findings with a single arbitration pass that explicitly flags where
  they disagree instead of silently picking one. Good for multi-angle work
  like "audit this codebase" (security + performance + readability at once).
- **Live world model** (`src/core/world_model.js`) — a background scheduler,
  independent of conversation, that watches files/directories/shell
  commands/URLs/MCP resources for drift (`world_watch_add`), narrates a
  change to the terminal the moment it's detected, and surfaces it
  proactively in the next reply even if unasked. Type `watch` in the REPL
  to see what's currently monitored.
- **Self-healing loop** (`src/core/healer.js`) — chains the three pieces
  above together. Opt a "command" watch into it with
  `heal_project_dir`, and drift no longer just gets narrated: a diagnosis
  swarm investigates what broke and why, builder verifies any candidate fix
  end-to-end (install/build/test) in an isolated sandbox copy of the
  project, and only a fix that actually passed gets surfaced — gated behind
  the same human-approval pattern used for `mcp_add_server`
  (`apply_verified_fix`). Type `fixes` in the REPL to see anything pending.
- **Rollout sandbox** (`src/core/rollout_sandbox.js`) — generalizes the
  self-healing loop's "fork it, run it for real, then decide" pattern to any
  consequential call: a multi-file rewrite, a deployment, a new background
  watch, or an outbound browser action. `simulate_rollout` actually executes
  1-4 candidates in a throwaway fork (in parallel), diffs what really
  happened against what was predicted, and — for several candidates — scores
  the real outcomes against each other. Nothing commits until `apply_rollout`
  is called with explicit human approval.
- **Cross-device continuity** (`src/core/continuity.js`) — a background
  daemon, independent of conversation, that heartbeats "this device is here,
  this is what it's on" into a small shared state file and watches for other
  devices doing the same. When something needs you (a self-healing fix, a
  deploy plan, a world-model drift event…) and nobody's device has checked
  in recently, it pushes a notification out — a generic webhook (ntfy.sh,
  Pushover, Slack/Discord, your own endpoint) and/or the WhatsApp channel if
  it's connected — instead of silently waiting for you to come back to that
  one terminal. `devices` in the REPL shows what's known. See
  `CONTINUITY.md` for exactly what does and doesn't sync.
- **Local distillation** (`src/core/distillation.js`, `local_router.js`) —
  well-worn, high-scoring skills get their successful trajectories
  (`trajectory_logger.js`) distilled into a LoRA fine-tune of a small local
  model, served via Ollama. Routine turns route there first — instant, free,
  offline — with anything novel, ambiguous, or unconfident falling back to
  the cloud model. Putting a trained model into real routing requires
  explicit human approval (`promote_local_model`), same as every other
  consequential action in this codebase.

## Getting started

```bash
npm install
npm start
```

On launch, JOJO shows its logo — the real gold mark on terminals that
support inline images (iTerm2, WezTerm, Kitty, VS Code's integrated
terminal), and a gold ASCII wordmark everywhere else.

## Docs

- `BUILD_SYSTEM.md` — how the build/tooling pipeline works
- `MCP_AND_PLUGINS.md` — MCP server support and the plugin system
- `SYNTHESIS_WORKFLOW.md` — divergent-branch → adversarial-harden → arbitrate workflow (`divergent_synthesis`)
- `BROWSER_AUTOMATION.md` — dual-grounded, self-healing, irreversibility-gated browser engine (`browser_*` tools)
- `REVIEW_BOARD.md` — multi-perspective adversarial code review: specialists + devil's advocate + verdict (`review_code`)
- `DEPLOYMENT.md` — human-gated multi-provider deployment + rollback (`prepare_deployment` / `apply_deployment`)
- `LARGE_APP_ORCHESTRATOR.md` — spec → dependency-ordered module graph → build (`plan_large_app` / `build_large_app`)
- `MONETIZATION.md` — Stripe billing code scaffolding — files only, never a live payment action (`scaffold_stripe_billing`)
- `SELF_MODEL.md` — grounded self-monitoring over real logged history, explicitly NOT self-awareness (`reflect_on_self`)
- `N8N.md` — self-hosted n8n provisioning + real workflow build/verify/deploy (`n8n_provision` / `n8n_create_workflow` / `n8n_verify_workflow`)
- `ROLLOUT_SANDBOX.md` — simulate a risky action for real in a throwaway fork before committing (`simulate_rollout` / `apply_rollout`)
- `DISTILLATION.md` — captured trajectories → local LoRA fine-tune → Ollama, confidence-gated routing, human-gated promotion (`build_distillation_dataset` / `train_local_model` / `export_local_model_to_ollama` / `promote_local_model`)
- `CONTINUITY.md` — cross-device presence, advisory handoff, and push notifications when nobody's around (`continuity_status` / `continuity_handoff` / `continuity_push_now`)
- `EMAIL_CHANNEL.md` — talk to JOJO by email
- `WHATSAPP_CHANNEL.md` — talk to JOJO over WhatsApp, with real spoken voice-note replies (`send_whatsapp_message` / `send_whatsapp_voice_note`)
- `plugins/README.md` — writing your own plugins
- `skills/README.md` — the skills the agent loads at startup

