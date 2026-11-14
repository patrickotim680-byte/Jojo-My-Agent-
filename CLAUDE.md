# JOJO — Project Context

Terminal-based autonomous AI agent (Node.js, ESM). Multi-provider LLM chain with
tool use, MCP client + server, plugins, skills, sub-agent swarms, browser/computer/Android
automation, self-healing, and human-gated deployment. Repo snapshot: `JOJO_gemini_edition_v9_updated`.

## Quick facts

- Runtime: Node >= 18 (verified on v22), `"type": "module"` (ESM only, use `import`).
- Entry: `src/index.js` (readline REPL). Agent class: `src/core/agent.js` (`JojoAgent`, ~85 KB, the center of gravity).
- Tests: `npm test` runs `node --test scripts/*.test.js src/core/*.test.js src/tools/*.test.js`.
  Last verified: **28/28 pass**, all `src/` and `scripts/` files pass `node --check`.
- Scripts: `npm start` | `npm run dev` (watch) | `npm run mcp-server` | `npm run email` | `npm run whatsapp` | `npm run voice` | `npm run email-auth`.
- Deps of note: `@google/genai`, `@heyputer/puter.js`, `@modelcontextprotocol/sdk`, `@whiskeysockets/baileys` (WhatsApp), `playwright`, `googleapis`, `msedge-tts`.

## Architecture

```
src/
  index.js            REPL, built-in commands (memory, tasks, mcp, plugins, watch, fixes, devices, ...)
  mcp-server.js       exposes JOJO itself as an MCP server (see MCP_AND_PLUGINS.md)
  core/               engines (one class per file, all constructed in JojoAgent's constructor)
  tools/              tool definitions; each *_tools.js exports a list registered in tools/registry.js
scripts/              channels: email_channel.js, whatsapp_channel.js, voice_channel.js, train_lora.py, set_key.sh
skills/               skill folders loaded at startup (SKILL.md per skill) — docx, pdf, pptx, xlsx, etc.
plugins/              user plugins (example-plugin/ shows plugin.json + index.js shape)
sandbox/Dockerfile    isolated execution image
memory/               RUNTIME STATE (gitignored): ledgers, vectors, trajectories, self_model, continuity_state
```

Key core modules: `agent.js` (loop, system prompt, tool dispatch) · `puter_client.js` (provider chain) ·
`registry.js` (tool registry + irreversible-action gate) · `approval_gate.js` (shared propose→hold→approve primitive) ·
`swarm.js` · `world_model.js` · `healer.js` · `rollout_sandbox.js` · `synthesis.js` · `review_board.js` ·
`deploy.js` · `browser.js` · `computer.js` · `adb.js` · `n8n.js` · `continuity.js` · `distillation.js` + `local_router.js` ·
`second_opinion.js` · `conductor.js` · `memory.js` / `vector_memory.js` · `skills.js` / `skill_ledger.js`.

### LLM provider chain (`src/core/puter_client.js`)

Order: **gemini → nvidia → puter (Claude) → openai**. Providers without a key are skipped; failures fall
through to the next. Override with `PROVIDER_ORDER`. `DEFAULT_MODEL = 'gemini-2.5-flash'`.
Gemini uses the native SDK; nvidia/puter/openai share one OpenAI-compatible conversion path
(`geminiHistoryToOpenAI`, `toOpenAITools`). The file/class names (`PuterAI`) are legacy and intentionally stable.

### Safety model (important when changing anything)

Consequential actions are never executed directly. They go through `ApprovalGate`
(`propose` → held pending → `apply` only with `human_approved=true` and an `approval_id`).
Used by: self-healing fixes, deployments, synthesis proposals, n8n, rollout apply, MCP server adds,
computer/ADB control, and a set of `GATED_IRREVERSIBLE_TOOLS` in `registry.js` (held only when the turn looks irreversible).
`second_opinion.js` adds a cross-vendor review to the three highest-stakes gates; it only *adds* an opinion,
never auto-blocks or replaces human approval. `{ ok: false }` from it means "no opinion obtained", not "pass".
Do not weaken these gates when fixing bugs.

## Configuration

Keys live in `.env` (loaded via `dotenv`); template in `.env.example`. Use `scripts/set_key.sh` to edit keys.
Main vars: `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `PUTER_AUTH_TOKEN`, `OPENAI_API_KEY`, `PROVIDER_ORDER`, `*_MODEL`,
`BRAVE_API_KEY`/`SERPAPI_KEY` (web search), `STRIPE_*` (billing scaffolds), `N8N_*`, `JOJO_SANDBOX_*`
(Docker runtime/image/cpus/memory/pids), `JOJO_CONTINUITY_*` (push webhook), `JOJO_{EMAIL,WHATSAPP,VOICE}_SAFE_MODE`,
`DISTILL_*`, `WORLD_MODEL_*`, `MCP_CONFIG_PATH` (see `mcp_servers.example.json`).
Several of these are read in code but are **not documented in `.env.example`** (it only lists provider keys, retry and continuity vars).

## Docs map (read the matching one before touching a subsystem)

`BUILD_SYSTEM.md` · `MCP_AND_PLUGINS.md` · `SYNTHESIS_WORKFLOW.md` · `BROWSER_AUTOMATION.md` · `REVIEW_BOARD.md` ·
`DEPLOYMENT.md` · `LARGE_APP_ORCHESTRATOR.md` · `MONETIZATION.md` · `SELF_MODEL.md` · `N8N.md` · `ROLLOUT_SANDBOX.md` ·
`DISTILLATION.md` · `CONTINUITY.md` · `SECOND_OPINION.md` · `EMAIL_CHANNEL.md` · `WHATSAPP_CHANNEL.md` · `plugins/README.md` · `skills/README.md`.

## Known issues / inconsistencies

1. **Secrets shipped in the archive.** The zip contains a populated `.env` (Gemini, NVIDIA, Puter, OpenAI keys).
   `.gitignore` excludes it from git, but the archive itself leaks it. Rotate those keys if the zip was shared/uploaded anywhere,
   and exclude `.env` when packaging.
2. **Stale branding/docs.** `README.md` and the `src/index.js` banner say "Powered by Claude (via Puter)" and "v4.2.0",
   but `package.json` says v1.0.0 and "powered by Google Gemini", and Gemini is the first provider in the chain.
3. **`.env.example` is incomplete** relative to the env vars the code reads (see Configuration).
4. **Test coverage is thin**: only `registry`, `memory`, `turn_hints`, `conductor`, and `voice_barge_in_utils` have tests.
   `agent.js`, `puter_client.js` (provider fallback), and all channel scripts are untested.
5. `skills/` ships large duplicated trees (`docx`, `xlsx`, `pptx` each carry identical `scripts/office/` schemas/validators).

## Conventions for working in this repo

- ESM only. Tool modules export an array/object of `{ declaration, handler }`-style entries registered in `registry.js`; add new tools there.
- One engine class per `core/*.js`; instantiate in `JojoAgent`'s constructor (order matters — e.g. `SecondOpinionEngine` before the engines that take it).
- Runtime state goes under `memory/` and must stay gitignored.
- When adding an irreversible capability, route it through `ApprovalGate`; add a test beside the module (`*.test.js`, `node:test`).
- Not verified here: live provider calls, Docker sandbox, Playwright, WhatsApp/email/voice channels, ADB, n8n (no keys/devices in the test environment).
