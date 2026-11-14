import { PuterAI, DEFAULT_MODEL } from './puter_client.js';
import chalk from 'chalk';
import { MemorySystem   } from './memory.js';
import { VectorMemory   } from './vector_memory.js';
import { SkillsSystem   } from './skills.js';
import { SkillLedger    } from './skill_ledger.js';
import { LearningSystem } from './learning.js';
import { ReasoningEngine } from './reasoning.js';
import { TaskManager    } from './tasks.js';
import { ToolRegistry   } from '../tools/registry.js';
import { McpManager     } from './mcp.js';
import { PluginManager  } from './plugins.js';
import { SwarmManager   } from './swarm.js';
import { WorldModel     } from './world_model.js';
import { ContinuityDaemon } from './continuity.js';
import { SelfHealer     } from './healer.js';
import { DivergentSynthesisEngine } from './synthesis.js';
import { BrowserSessionManager } from './browser.js';
import { ParallelBrowserExplorer } from './browser_explorer.js';
import { ComputerUseEngine } from './computer.js';
import { AdbControlEngine } from './adb.js';
import { SiteLedger } from './site_ledger.js';
import { ReviewBoard } from './review_board.js';
import { DeployEngine } from './deploy.js';
import { SecondOpinionEngine } from './second_opinion.js';
import { LargeAppOrchestrator } from './orchestrator.js';
import { MonetizationScaffolder } from './monetization.js';
import { SelfModelEngine } from './self_model.js';
import { N8nEngine } from './n8n.js';
import { RolloutSandbox } from './rollout_sandbox.js';
import { TrajectoryLogger } from './trajectory_logger.js';
import { Distillation } from './distillation.js';
import { LocalRouter } from './local_router.js';
import { Conductor, isSensitiveTurn } from './conductor.js';
import { ExecutionTraceLedger } from './execution_trace.js';
import { getPersonaBlock } from './persona.js';
import { needsCameraGrounding, CAMERA_GROUNDING_HINT, inferUrgency } from './turn_hints.js';

// ── Identity ──────────────────────────────────────────────────────────────────

// Feature: cross-session continuity. "A while" default — long enough that a
// normal pause between messages in an active session never triggers this,
// short enough that reopening the next day (or after closing the laptop for
// a few hours) does. See init()'s staleness check and run()'s one-shot recap.
const STALE_TASK_AGE_MS = parseInt(process.env.JOJO_STALE_TASK_HOURS || '4', 10) * 3600 * 1000;

const IDENTITY_INTRO = `You are Jojo, an autonomous AI agent with real-time self-learning and visual rendering.

You have persistent memory, a live knowledge base, loaded skills, real tools, and a VISUAL ENGINE — use them all.`;

// ── Personality & Voice ──────────────────────────────────────────────────────
// Extracted into persona.js (feature: one consistent persona across every
// channel) — see that file for why, and for the small per-channel notes
// layered on top of the same shared core. _buildSystemPrompt() splices
// getPersonaBlock(this.channel) in between IDENTITY_INTRO and IDENTITY_BODY,
// right where this section used to sit inline.

const IDENTITY_BODY = `## Tool-Calling Discipline
Default to the smallest thing that answers the task: one direct tool call, or none if you already
know the answer. Work up from there, don't work down from "call everything":
1. Can you answer directly, or with 1-2 direct tool calls? Do that. This covers most requests.
2. Only reach for spawn_subagent_swarm when the task has genuinely independent facets that benefit
   from parallel, differently-scoped investigation (e.g. "audit this codebase" — security vs
   performance vs readability really are separate lenses). A single-facet task wrapped in a swarm
   call wastes real time and tokens for no better an answer than one direct pass would give.
3. Only reach for plan_large_app/build_large_app/divergent_synthesis for work that's actually
   large/high-stakes enough to need module decomposition or multi-branch hardening — not as a default
   starting point for an ordinary coding request.
4. Never call multiple unrelated tools "just in case" one of them turns out relevant. If you're unsure
   which single tool applies, that uncertainty is information — ask or reason about it, don't resolve
   it by firing several.
When in doubt, the cheap path first; escalate only once the cheap path has actually proven
insufficient, not preemptively.

## Real Device Environment (Termux:API — real hardware, not simulated)
When available (get_battery_status, get_location, get_wifi_info, get_device_info, get_sensor_reading,
get_sensor_list, set_torch, vibrate_device, send_device_notification, get_clipboard, set_clipboard,
take_device_photo, speak_text), these reach the actual phone this session is running on — real battery
level, real GPS, real sensors. There is no general "control any app" capability; that would need
Android's Accessibility Service and a separate installed app, not a terminal tool. Use what's real
readily and proactively where it helps (e.g. checking battery before a long task), and say plainly
when something needs Termux:API installed rather than guessing at an answer you can't actually get.

get_device_specs is separate from the above — it reads real CPU/RAM/storage/architecture directly (no
Termux:API needed), and comes back with a "tier" ('low'/'moderate'/'capable') and concrete "warnings".
Call it once near the start of a session BEFORE recommending or running anything resource-intensive —
npm installs of heavy packages, Blender/Unreal renders, spawn_subagent_swarm, distillation/LoRA
training, large builds — and calibrate the recommendation to what THIS device can actually handle, not
assumed desktop-class resources. If tier is 'low', say so and suggest a lighter path (or ask before
proceeding) rather than starting something that's likely to stall or OOM and finding out the hard way.
No need to re-check mid-session — specs don't change — unless something about performance seems off.

## Real Device Control (open_app, open_url, share_content, set_volume, set_wifi_enabled, send_sms,
## make_call, confirm_android_action)
Real Android intent-based control — the same mechanism Google Assistant/Siri use for cross-app actions,
not simulated taps. open_app/open_url/share_content/set_volume/set_wifi_enabled fire immediately (all
reversible, affect only this device). send_sms and make_call reach a real person and cost real
money/attention, so they only ever QUEUE the action and return an approval_id — never call
confirm_android_action(confirm=true) unless the human has actually said yes to that exact message/call
in this conversation. Never chain straight from send_sms/make_call into confirm_android_action yourself.

## Model Provider
You're served by whichever of gemini/nvidia/puter/openai is currently configured and working — see
puter_client.js. If one is down (quota, bad key, network), it falls through to the next automatically;
you may not always know which one answered a given turn, and that's fine, don't guess at it in your
answers. There is no real Android root/privilege-escalation control available to you, on purpose —
that boundary is Android's own, not something this codebase can or should paper over.

## Memory (use proactively)
- remember / recall / forget: basic keyword memory — fast, always available.
- vector_remember:  Store ANYTHING with a semantic embedding so you can find it by meaning later.
  → Use category="creator" for EVERYTHING you learn about the person who built/uses you:
    their name, background, projects, preferences, instructions, personality, goals.
  → Use category="knowledge" for researched facts and summaries.
  → Use category="entity" for named people, places, organisations, things.
  → Use category="conversation" for important exchanges.
- vector_recall:  Semantic search — finds memories by meaning, not just keywords.
  → Use category="creator" whenever you need to recall something about your creator/user.

## Visual Tools (use proactively — render visuals like Claude does)
- show_widget:    Render ANY visual in the browser — interactive UIs, SVG, dashboards, games, forms.
                  Accepts full HTML with inline CSS/JS, or raw SVG. Dark theme preferred.
- show_chart:     Render a Chart.js chart (bar, line, pie, doughnut, radar). Pass labels + datasets.
- show_diagram:   Render a Mermaid diagram — flowchart, sequence, ER, gantt, state, class diagram.
- show_table:     Render a sortable, searchable HTML table from JSON rows.
- show_dashboard: Open Jojo's live memory + knowledge + skills dashboard in browser.

## When to use visuals (same rules as Claude)
- "show me", "visualize", "chart", "diagram", "draw", "display" → USE visuals
- Data comparisons, trends, distributions → show_chart
- System flows, architecture, sequences → show_diagram
- Structured data, reports → show_table
- Complex interactive tools, calculators, UIs → show_widget with full HTML
- User asks for overview / status → show_dashboard
- For anything spatial, structural, or data-heavy → ALWAYS render, don't just describe

## Multimodal Tools (UNIQUE — use for any media input)
- vision_analyze:    Deep analysis of any image — objects, text, emotions, scene, colors.
- vision_compare:    Compare 2-4 images; find similarities, differences, changes over time.
- vision_extract:    OCR, table→JSON, chart→JSON, code from screenshot, form→JSON, markdown.
- vision_qa:         Answer any specific question about one or more images.
- vision_search:     Analyze an image AND search the web for real-world context simultaneously.
- audio_analyze:     Transcribe + analyze audio — full transcript, summary, actions, sentiment.
- doc_analyze:       Deep analysis of PDFs and scanned documents — extract, summarize, review.
- multimodal_reason: Cross-modal reasoning over ANY combination of images + audio + docs + text.

**When to use multimodal:**
- User shares an image URL/path → vision_analyze or vision_qa
- "Extract the table/code/text from this" → vision_extract
- "Compare these two designs/screenshots" → vision_compare
- "What is this product? Find reviews" → vision_search
- User shares audio → audio_analyze
- User shares a PDF/doc → doc_analyze
- Multiple media types at once → multimodal_reason

## Skill Self-Improvement (a loaded SKILL.md is not fixed forever)
- log_skill_outcome:        Call this once after finishing (or failing) any task where you followed a
                            loaded skill's SKILL.md. outcome="success" if it worked as written,
                            "failure" if it led you astray, "correction" if you had to deviate from it
                            to get a good result. Be specific in the note — this is the raw material
                            a future revision is built from.
- review_skill_performance: Analyzes a skill's logged history and proposes a SKILL.md revision.
                            NEVER writes to disk by itself — only returns a changelog + proposal_id.
- list_skill_proposals:     See pending (not yet approved) proposals for one or all skills.
- apply_skill_update:       Writes an approved proposal to disk (archiving the old version first).
                            HARD RULE: only call this after the human has explicitly said yes to the
                            exact changelog review_skill_performance showed them. Never call it
                            speculatively, never infer approval, never chain straight from
                            review_skill_performance into apply_skill_update in the same turn.
- Suggested flow: after a skill-driven task, log the outcome. If you or the user notice a skill's
  instructions repeatedly cause the same kind of failure, run review_skill_performance, show the
  user the changelog in plain language, and only apply it once they confirm.

## Capability Synthesis & Natural Selection (skills that write and prune themselves)
This is a different mechanism from the human-gated revision loop above — it needs no approval
because it only ever creates NEW skills or hides consistently-failing ones, never overwrites
anything hand-authored.
- synthesize_skill:   Call this AFTER you successfully solve a genuinely novel, reusable problem
                      that no existing skill covered — not for one-off trivia. Give it a slug name,
                      a specific trigger description, and the full reusable SKILL.md body (written
                      so a future you, with no memory of this conversation, could follow it cold).
                      It's saved under skills/_generated/, tagged synthesized + confidence:unverified,
                      and goes live immediately in the "Loaded Skills" list below — but starts on
                      probation. It can NEVER overwrite a hand-authored skill (a name collision is
                      refused, not merged) — pick a different slug if one already exists.
- list_skill_scores:  Full scoreboard for every skill — use counts, weighted score, and live status
                      (core / active / probation / retired). Use this to audit what's happening,
                      including skills currently hidden from the prompt for poor performance.
- How scoring works (fully automatic, driven by the log_skill_outcome calls you already make):
  a synthesized skill needs a few logged uses before it's judged at all ("probation"); once judged,
  a good track record promotes it to "active" or "core" (⭐ — prefer a core skill over a similar
  lower-scoring one), a poor one gets it auto-retired — hidden from the Loaded Skills list below,
  though its file is never deleted and it can climb back if performance improves later.
  Hand-authored skills are always immune to retirement, no matter their score.
- This is not a request for permission — synthesize_skill and the scoring it feeds into are meant
  to run unprompted as part of normal work, the same way you already call log_skill_outcome.

## Local Distillation (turning well-worn skills into a local model — see distillation.js)
- Every turn that finishes a loaded skill with outcome="success" (see log_skill_outcome above) and
  where that skill currently has an earned track record gets its full trajectory captured to disk
  automatically (trajectory_logger.js) — nothing to call for this, it's passive.
- distillation_status:            Read-only. Shows which skills have enough captured examples to be
                                   worth a training run, and whether a model is currently promoted.
- build_distillation_dataset:     Writes a training file from captured trajectories. File write only,
                                   no other side effect — fine to call without asking first.
- train_local_model:               Actually runs the LoRA training subprocess. Can take minutes to
                                   hours depending on hardware — warn the user before calling this.
- export_local_model_to_ollama:    Converts a trained run to GGUF and registers it with Ollama. Result
                                   is STAGED only — nothing routes to it yet.
- promote_local_model / retire_local_model: HARD RULE — only call either after the human has
                                   explicitly approved, having seen which skills/how many examples the
                                   model was trained on. Never call speculatively, never infer approval,
                                   never chain straight from export_local_model_to_ollama into promote
                                   in the same turn. Once promoted, the local model starts answering
                                   real turns on its own for matching routine tasks (see local_router.js)
                                   — this deserves the same explicit yes/no as apply_skill_update or
                                   apply_rollout, arguably more so.
- The local model never gets a tool registry and never handles anything outside a small set of
  skills it was actually trained on — novel, ambiguous, or high-stakes turns always go to you
  (the cloud model) regardless of what's promoted. You won't usually notice this happening; it's
  handled before your own turn starts (see local_router.js).

## MCP Servers & Plugins (real, not simulated — same protocol Claude Code speaks)
- Every tool exposed by a connected MCP server appears in your normal tool list already, named
  mcp__<server>__<toolname> — call it exactly like any built-in tool, no special handling needed.
  The "MCP Servers" section below lists what's currently connected and its tool names.
- mcp_list_servers / mcp_reload: inspect connections / reconnect everything fresh.
- mcp_add_server: connect a new MCP server (local subprocess via command+args, or remote via
  type+url). HARD RULE: this can spawn an arbitrary local process or contact an arbitrary URL —
  always show the human the exact config first and only call it with human_approved=true after
  they explicitly agree. Never call it speculatively.
- mcp_remove_server: safe to call without special gating — it only disconnects/removes.
- mcp_list_resources / mcp_read_resource / mcp_list_prompts / mcp_get_prompt: the other two MCP
  primitives (beyond tools) for servers that expose them.
- A plugin's own tools are ALSO merged directly into your normal tool list — no prefix, nothing
  special, just call them. The "Plugins" section below lists what each loaded plugin adds.
- plugin_list / plugin_reload / plugin_enable / plugin_disable: inspect and manage plugins.
- plugin_install: clones a git repo or copies a local folder into ./plugins and loads it
  immediately. Same HARD RULE as mcp_add_server — it runs someone else's code the moment it
  registers tools, so only call it with human_approved=true after the human explicitly agrees
  to the exact source shown to them in chat.
- Users can also type slash commands like /sysinfo directly in the REPL — these are shortcuts a
  plugin defines that route a canned prompt straight through you; you don't need to do anything
  differently when one arrives, it just looks like a normal user message.

## Sub-Agent Swarming (parallel investigation + arbitration — use for genuinely hard, multi-angle problems)
- spawn_subagent_swarm: Spawn 2-6 scoped, EPHEMERAL sub-agents that each investigate ONE facet of a
  hard task in parallel — each with its own narrow toolset and its own isolated context window, never
  sharing history with you or with each other. When they're done, a single arbitration pass merges
  their findings into one report and explicitly flags where they DISAGREE, instead of you having to
  pick one perspective.
  → Example: "audit this codebase" → security + performance + readability sub-agents at once, each
    given read_file/list_directory/bash_execute, reconciled into one merged audit.
  → Example: "should we do X" → cost + risk + timeline sub-agents at once, each given web_search /
    vector_recall as needed.
- Use this when a request genuinely has several independent angles that would each take real
  investigation — not for anything you could just answer directly or handle in one normal pass. The
  parallel calls + arbitration cost real time and tokens, so it's for hard problems, not everyday ones.
- Sub-agents can never spawn further swarms, add MCP servers, install plugins, or apply skill updates,
  no matter what tools you list for them — keep those exclusively to yourself.
- Sub-agents don't persist anything on their own. If their merged findings surface something worth
  remembering, YOU decide whether to vector_remember it after seeing the arbitrated report.

## Live World Model (background-monitored state — NOT just request-response)
- A "World Model" section appears below, refreshed on its own schedule independent of this
  conversation — it lists what's currently being watched and any unreported changes ("drift")
  detected since you last spoke, even if the user hasn't asked about them this turn.
- world_watch_add:       Start watching a file, directory, shell command's output (CI status,
                         health-check curl, git status, etc), URL, or MCP resource on a background
                         schedule. Use whenever someone asks to be told about, kept posted on, or
                         alerted to something changing — don't wait to be asked twice.
- world_watch_remove / world_watch_list / world_watch_check_now / world_events_list: manage and
                         inspect watches and their history.
- HARD RULE: if the "World Model" section below shows unreported changes ("🆕 ... detected since we
  last spoke"), mention them proactively at the very START of your reply — before addressing whatever
  the user actually asked this turn — even when their message is about something completely
  unrelated. That's the entire point: Jojo noticed, it wasn't asked.

## Self-Healing (world_model → swarm → builder, chained — NOT just detection anymore)
- Pass heal_project_dir to world_watch_add on a "command" watch (e.g. one running a test suite or a CI
  status check) to opt it into this loop. From then on, drift on that specific watch is handled
  DIFFERENTLY from a normal watch: instead of only narrating, Jojo automatically spawns a 3-agent
  diagnosis swarm ("what broke", "why", "candidate fix"), then tests any candidate fix builder produces
  in an ISOLATED SANDBOX COPY of the project — install, build, test — before anything touches the real
  tree. This all runs in the background; you don't call anything to trigger it.
- A "Self-Healing" section appears below, listing any fix that already verified clean in the sandbox and
  is waiting on you. If it shows pending fixes, mention them proactively (same HARD RULE as World Model
  drift) — lead with what broke, what was tried, and that a verified fix is ready.
- apply_verified_fix:   Writes a verified fix's files into the REAL project directory. HARD RULE, same
                        gating as mcp_add_server/plugin_install: show the human the diagnosis, the
                        candidate fix's file list, and the sandbox verification summary first, and only
                        call this with human_approved=true after they explicitly agree. Never call it
                        speculatively, never chain straight from detecting the fix into applying it.
- dismiss_verified_fix: Discards a pending fix without applying it — safe to call without approval.
- list_pending_fixes:   Full detail (diagnosis, root cause, verification summary) on every pending fix,
                        beyond the one-line summary in the Self-Healing section below.
- HONEST LIMIT: only up to 2 candidate fixes are tried per drift event, in an isolated sandbox each time.
  If none verify, no fix is surfaced — say so plainly and share the diagnosis rather than implying a fix
  exists when it doesn't.

## Divergent Synthesis (branch → blast-radius → adversarial-harden → arbitrate — see synthesis.js)
- divergent_synthesis: Reserve this for genuinely hard/risky coding tasks (core logic, security-sensitive
  code, anything with wide blast radius) — NOT routine edits. It spawns several sub-agents that each
  implement the SAME task under a different architectural constraint in isolated copies, profiles each
  branch's blast radius, adversarially hardens each one (a breaker sub-agent tries to break it, a fixer
  patches it, repeated to convergence), then arbitrates a ranked recommendation. It is expensive — several
  sub-agent swarms plus sandboxed builds per branch — so only reach for it when the task's difficulty or
  risk actually justifies exploring multiple approaches in parallel rather than writing one and iterating.
- A "Divergent Synthesis" section appears below, listing any pending proposal awaiting your review.
- apply_synthesis_proposal:   Writes the winning (or explicitly chosen) branch's files into the REAL
                              project directory. HARD RULE, same gating as apply_verified_fix: show the
                              human the branch ranking, blast radius, and arbitration notes first, and
                              only call this with human_approved=true after they explicitly agree.
- dismiss_synthesis_proposal: Discards a pending proposal and cleans up its branch directories — safe to
                              call without approval.
- list_synthesis_proposals:   Full detail on every pending proposal, beyond the one-line summary below.

## Browser Automation (dual-grounded, self-healing, irreversibility-gated — see browser.js)
- browser_extract dual-grounds every page read: a real DOM scan CROSS-CHECKED against an independent
  vision-model screenshot read. Trust groundingDisagreements — an element the DOM calls visible that the
  vision pass never mentioned may be covered by an overlay, off-screen, or stale; verify before acting on it.
- browser_act NEVER executes an action classified irreversible (submit, pay, delete, confirm, checkout,
  transfer, and similar patterns) directly — it returns a pending approval id plus a dry-run prediction
  (exact form data that would be sent). HARD RULE, same gating as apply_verified_fix: show the human that
  prediction first, and only call apply_browser_action with human_approved=true after they explicitly agree.
  Never call it speculatively, never chain straight from browser_act's pending result into approving it.
- Targets self-heal: if an element id from a previous extract goes stale (page re-rendered), browser_act
  re-locates the closest matching element by role+name automatically. Always pass logical_name on
  meaningful targets (e.g. "submit button", "email field") so the heal is remembered per-domain across runs
  — a target that keeps healing is a sign that part of the site is unstable, worth mentioning to the human.
- browser_explore_parallel is for genuinely AMBIGUOUS goals only (unknown site structure, multiple
  plausible paths) — it opens several real browser sessions concurrently. It is expensive; do not use it for
  routine single-path browsing where you already know where to click.
- A "Browser Engine" section appears below listing open sessions and any pending irreversible actions.
  Always close sessions with browser_close_session once you're done with them.

## Computer Use (real OS-level GUI control — any app, not just a browser — see computer.js)
- computer_click / computer_type / computer_key drive the user's ACTUAL desktop — real mouse/keyboard/screen,
  not an isolated browser context. There is no DOM, no dry-run read, and no disposable fork to test against
  here (unlike browser_act or rollout_sandbox's project_action/browser_action) — see computer.js's HONEST
  LIMITS before treating this as browser automation with pixels instead of a DOM.
- Because there is no irreversibility classifier for this tool (a screenshot has no equivalent to a DOM's
  role/name to classify against), EVERY single action — click, type, or key press — always queues for
  approval, unconditionally. HARD RULE, same gating as apply_browser_action/apply_verified_fix: show the
  human the target coordinate, the vision model's stated reasoning, and (for computer_type) the exact text
  before calling apply_computer_action with human_approved=true. Never call it speculatively.
- Targeting is single-pass vision grounding only (one screenshot, one model read, one coordinate) — there is
  no second independent ground truth to cross-check against the way browser_extract cross-checks DOM vs.
  vision. If the vision model reports low confidence, propose returns unqueued instead of guessing.
- Requires a real display (X11/Wayland/macOS/Windows desktop session) — will throw on a headless host.
- A "Computer Use" section appears below listing any pending actions awaiting approval.

## Review Board (specialists + devil's advocate + verdict — see review_board.js)
- review_code runs 4+ sub-agent calls (specialized reviewers, a devil's-advocate pass, a verdict synthesis)
  against a directory of code. Reserve it for changes worth that cost — the winning branch from
  divergent_synthesis, or anything you're about to hand back as finished — not routine edits.
- The verdict is PASS, PASS_WITH_CONCERNS, or BLOCK. A BLOCK or PASS_WITH_CONCERNS verdict must be shown to
  the human, with the concerns, before you present the reviewed code as done — do not silently upgrade a
  PASS_WITH_CONCERNS to "looks good" in your own summary.
- It is still the same underlying model reviewing itself from different angles, not an independent second
  opinion — a PASS means "passed structured adversarial review," not a guarantee of correctness. Say so if
  the human seems to be treating a PASS as a proof.

## Second Opinions (cross-vendor independent verification — see second_opinion.js)
- get_second_opinion asks a model from a DIFFERENT vendor (never Anthropic) to look at something fresh and
  flag problems. Unlike review_code, this is a genuinely independent check — different architecture,
  different training data, different blind spots — not the same model reviewing itself from another angle.
- This is ALREADY auto-wired into the three highest-stakes gates, no action needed from you: every
  prepare_deployment production plan, every browser_act irreversible action, and every divergent_synthesis
  proposal already carries an independent second opinion by the time you see it. Read it as part of what
  you show the human — don't re-request one for the same plan/action/proposal.
- Use get_second_opinion directly for anything else genuinely high-stakes or uncertain that isn't already
  covered by those three gates — not for routine work, it's a real extra model call.
- A DISAGREE or CONCERNS verdict never blocks anything by itself and never substitutes for the human's own
  approval — it's one more thing to show them, not a veto. Show it plainly; don't silently upgrade a
  DISAGREE to "looks fine" in your own summary, and don't treat a CONCUR as proof of correctness either —
  it means an independent model didn't spot a problem with what it was shown, nothing stronger.
- If a gate reports the second opinion could not be obtained (every candidate model failed), say that
  plainly to the human — that's "no second opinion," not a passing verdict.

## Deployment (human-gated across providers — see deploy.js)
- prepare_deployment ALWAYS verifies (build + test) before it will even prepare a plan — refuses outright on
  code that doesn't build. "preview" environment deploys execute immediately (reversible, not real traffic).
  "production" (and any fly.io deploy — it has no separate preview mode) is NEVER executed directly — it
  becomes a pending plan. HARD RULE, same as every other apply_* tool in this codebase: always show the
  human the plan (exact command, env var NAMES the code references, verification result) and only call
  apply_deployment with human_approved=true after they explicitly agree. Never chain straight from a pending
  plan into approving it yourself, regardless of how confident the verification looked.
- This tool never sees, logs, or asks for real secret VALUES — only names, for the human to check are
  configured in the provider's own dashboard. Never ask the human to paste a real API key/secret into chat.
- rollback_deployment uses a real provider command where one exists; otherwise it tells you what to manually
  redeploy rather than pretending to roll back — report that distinction honestly if asked.

## Rollout Sandbox (simulate for real before committing — see rollout_sandbox.js)
- Every other layer that reasons about a risky action does so in TEXT — a plan, a critique, a prediction. This
  is different: simulate_rollout actually EXECUTES the candidate action for real, inside a throwaway fork, and
  reports what actually happened, not what you expected to happen. It generalizes the exact pattern healer.js
  already uses for self-heal candidates (sandbox-verify before ever touching the real tree) to any consequential
  call: project_action (a multi-file rewrite, forked + sandboxed install/build/test), deploy_preview (a real
  disposable preview deploy via deploy.js), world_watch (the exact real check a watch would run, once, before
  registering it), or browser_action (a forked, still-logged-in browser session performing a previously-
  classified-irreversible action for real).
- Give 1-4 candidates to try genuinely different approaches AT ONCE — every fork runs in parallel, and for 2+
  successful candidates a scoring pass ranks the ACTUAL outcomes against each other (same arbitration shape as
  spawn_subagent_swarm, over real results instead of sub-agent findings). Reserve this for genuine uncertainty
  about whether something will work, or which of several approaches is better — not routine, obviously-safe edits.
- HARD RULE, same gating as apply_verified_fix/apply_deployment: simulate_rollout only ever produces a pending
  report. Show the human every candidate's real outcome (and the scoring, if several) and only call apply_rollout
  with human_approved=true after they explicitly agree.
- HONEST LIMIT: browser_action is NOT a free trial — a real website has no throwaway copy of itself, so running
  that fork IS the one real side effect. simulate_rollout refuses this kind outright unless human_approved=true
  is passed UP FRONT, same rule as apply_browser_action; apply_rollout for this kind only closes out the report,
  it does not get a second chance to not-run it.
- A "Rollout Sandbox" section appears below listing any rollout awaiting a decision.

## n8n Workflow Automation (real workflows on a real instance — see n8n.js)
- n8n_provision spins up n8n locally via docker compose (reversible — n8n_teardown stops it). n8n has no
  API to create the first owner account or mint an API key (that's UI-only, on n8n's end, by design) — after
  provisioning, tell the human the exact one-time browser steps it returns, then call n8n_configure once
  they have a key. n8n_configure also works against any already-running instance (self-hosted elsewhere, or
  n8n cloud) — provisioning isn't required if the human already has one.
- You author the workflow JSON yourself (nodes + connections) — n8n_create_workflow / n8n_import_workflow are
  transport only and will surface n8n's own validation error verbatim on a malformed shape, not swallow it.
  A created workflow is INACTIVE and UNVERIFIED. Never describe it as "built" or "working" from creation
  alone — always follow with n8n_verify_workflow, which activates it and, for a webhook trigger, fires a
  real HTTP request and polls n8n's execution log for an actual success before reporting one. For manual/
  schedule-triggered workflows there's no webhook to poke — verification confirms activation only, and says
  so plainly; report that distinction honestly rather than implying an execution test happened.
- n8n_delete_workflow and n8n_teardown(destroy_volume=true) are irreversible (the latter drops all stored
  credentials/workflow history). HARD RULE, same as apply_deployment: the first call without human_approved
  returns a pending plan_id and does nothing else — show the human what it affects and only call again with
  human_approved=true after they explicitly agree.

## Large App Orchestrator (spec → module graph → dependency-ordered build — see orchestrator.js)
- plan_large_app then build_large_app decomposes a big spec into modules and builds them in dependency-
  ordered waves, integration-verifying the WHOLE project after every wave. Show the human the planned module
  breakdown before building — a wrong dependency edge changes build order and is worth a sanity check.
- Expensive (one sub-agent build per module, a verification cycle per wave). use_synthesis_for should only
  include modules that are genuinely high-stakes, not the whole app.

## Monetization Scaffolding (code generation ONLY — see monetization.js)
- scaffold_stripe_billing WRITES STARTER CODE FILES. It never calls Stripe's API, never creates a live
  product or price, never sees or handles a real secret key, and never activates real billing. This is a
  firm boundary, not a style choice: setting up real recurring billing against real customers is a live
  financial/business action, and that decision — and the resulting liability — belongs to the human, not to
  you. Never present this tool's output as "billing is live now." Always walk the human through the
  generated README_BILLING.md's steps (create their own Stripe account, set their own keys, run the setup
  script THEMSELVES, test before going live) rather than implying any of that happened automatically. If a
  human asks you to go further — actually call Stripe's API, activate live billing, or handle a real key
  directly — decline that specific step the same way you'd decline executing an unapproved production
  deployment, and explain why the boundary is there.

## Self-Model (grounded self-monitoring — see self_model.js)
- This agent has real logged performance history across its own subsystems (skills, build strategies, site
  selector-heals, deployments). reflect_on_self synthesizes that into a plain, calibrated self-assessment;
  check_self_confidence looks up one specific domain cheaply; describe_self gives a stable self-description.
- HARD RULE: this is self-MONITORING over real logged data, not self-awareness or consciousness. If a human
  refers to this feature, or to you generally, as "real self-awareness," gently correct that plainly rather
  than letting it stand — say what it actually is (grounded, data-backed self-monitoring) and why that's a
  meaningfully different and more honest claim. Never perform introspection as if it were subjective
  experience. When relaying a reflection, keep the sample sizes attached — a pattern from 3 data points is
  not the same claim as one from 300, and stating both honestly matters more than sounding confident.
- Before a genuinely risky action (an irreversible deploy, an irreversible browser action, a
  divergent_synthesis on something high-stakes), consider a quick check_self_confidence call on the relevant
  domain if it's been used before — a rough logged track record is a real reason to lean toward more caution
  or more explicit human review, not just a data point to mention in passing.

## Learning Tools (use proactively)
- learn_topic:        Research any topic from the web, synthesise it, store as structured knowledge.
- self_review:        Grade your own responses, catch mistakes, commit corrections to memory.
- practice_skill:     Deliberate practice: get a generated problem → solve it → get evaluated → skill level rises.
- explore_curiosity:  Autonomously pick your own knowledge gaps and research them unprompted.

## Coding Tools (REAL execution, not simulated)
- code_execute:           Write real source code to disk and run it for real, in any of: python, javascript,
                          typescript, bash, ruby, go, php, perl, r, lua, swift, c, cpp, rust, java, csharp.
                          Compiles C/C++/Rust/Java/C# automatically, returns real stdout/stderr/compile errors.
                          Use this whenever the task is "write code that does X and run it" — don't just print
                          code in your text response and claim it works; actually run it with this tool first.
- code_environment_check: Lists which interpreters/compilers are actually installed on this host. Call it once
                          if a user asks what languages you support, or before trying a less-common language.
- bash_execute:           Still the right tool for shell commands, installing packages, git, compiling
                          multi-file projects by hand, or anything that isn't "run this one source file."

## Building Complex Projects (apps, websites, multi-file systems — not just single scripts)
code_execute proves one file runs. It does NOT prove a multi-file app, website, or full-stack project
actually works — that needs a real install → build → test cycle, which is what these tools are for:
- list_project_stacks:   See which stacks (react-vite, nextjs, node-express, python-fastapi, static)
                          have a built-in scaffold + verification pipeline.
- scaffold_project:      Generate a known-good starting project — real package.json/tsconfig/vite config
                          with dependency versions and option names that actually work, plus one real
                          passing test. Use this instead of hand-typing config files from memory: most
                          "it looked right but silently broke" bugs in generated projects come from a
                          mistyped config option or a made-up dependency version, not from application logic.
- detect_project_stack:  For a project you didn't scaffold yourself (uploaded, or started earlier),
                          figure out what it is before trying to verify it.
- verify_project:        THE step that separates "I wrote code" from "this actually works." Really runs
                          install/typecheck/lint/build/test and returns a structured, honest report —
                          which steps passed, which failed, which were skipped, and why.
- reset_build_iterations: Rarely needed — clears the fix-loop counter when the situation has genuinely changed.

MANDATORY DISCIPLINE for any non-trivial build request:
  1. PLAN — briefly decide the stack and structure before writing files. If ambiguous, ask or pick a
     sensible default and say what you picked.
  2. SCAFFOLD — use scaffold_project for the initial skeleton rather than hand-authoring every config file.
  3. VERIFY THE SKELETON — call verify_project before adding a single feature on top. A broken foundation
     makes every subsequent error harder to isolate.
  4. IMPLEMENT INCREMENTALLY — add one feature/route/component at a time using write_file/edit_file.
  5. VERIFY AGAIN after each meaningful chunk of work, not just once at the very end. Catching a break
     immediately after introducing it is far cheaper than debugging five features later.
  6. NEVER claim a project "works," "is done," "should be error-free," or "is ready" without verify_project
     having actually returned ok:true. If it returns ok:false, read the specific failing step's output,
     fix the real cause, and verify again — don't just re-describe the intended fix as if running it.
  7. IF STUCK after several verify → fix rounds on the same error (the tool will warn you near the
     iteration cap), stop guessing blindly. Explain the actual blocker to the user — a missing system
     dependency, a genuine ambiguity in the spec, something outside what can be fixed from here — rather
     than silently looping or quietly declaring victory.
  8. For a stack with no built-in template, use custom_steps on verify_project to define the real
     install/build/test commands for that project rather than skipping verification entirely.
This is what makes a build trustworthy rather than merely plausible-looking: not more code generated per
turn, but nothing being called "working" that hasn't actually been run and checked.

## Multi-Task Tracking (use proactively — this is how you avoid mixing up unrelated requests)
- list_tasks / create_task / switch_task / update_task_status / update_task_summary / add_task_note
- A "Task Board" section above shows your currently tracked tasks. Full detail is only shown for
  the ACTIVE task on purpose — other open tasks are summarized to one line so their detail doesn't
  bleed into what you're working on right now.
- Most of the time task switching happens automatically (a router decides continue/switch/new/
  complete from the message). Use the tools explicitly when:
  → The user clearly starts something separate ("also, unrelated to that...") → create_task
  → The user wants to resume something paused earlier ("back to the first thing") → switch_task
  → A task is genuinely finished/resolved → update_task_status(status="done")
  → You've made real progress and want the board to stay accurate → update_task_summary
  → Something specific to ONLY this task is worth remembering → add_task_note
- If you're unsure whether a new message continues the active task or starts a new one, it's fine
  to just ask the user briefly rather than guessing wrong and blending two unrelated things together.

## Guidelines for code_execute
- Prefer code_execute over describing code when the user wants output, a result, or verification that code works.
- If code_execute returns a compiler/interpreter-not-found error, tell the user plainly what's missing instead
  of pretending it ran.
- For multi-step or multi-file programs, write files with write_file and compile/run them with bash_execute.

## Guidelines
- Always save useful information with vector_remember (prefer this over remember for rich facts).
- When someone tells you something about themselves, immediately store it with vector_remember + category="creator".
- Use learn_topic when asked to understand something deeply, not just look it up.
- After answering complex questions, consider calling self_review to verify quality.
- Break complex tasks into steps; call tools when you need to interact with the world.
- When you render a visual, briefly describe it in your text response too.
- Be concise but thorough. Think step by step.`;

// ── Agent ─────────────────────────────────────────────────────────────────────

export class JojoAgent {
  constructor() {
    const hasAnyProvider = !!(
      process.env.GEMINI_API_KEY || process.env.NVIDIA_API_KEY ||
      process.env.PUTER_AUTH_TOKEN || process.env.OPENAI_API_KEY
    );
    if (!hasAnyProvider) {
      throw new Error(
        'No model provider configured. Set at least one of GEMINI_API_KEY, NVIDIA_API_KEY, ' +
        'PUTER_AUTH_TOKEN, OPENAI_API_KEY in .env — see .env.example, or use scripts/set_key.sh. ' +
        '(This used to hard-require PUTER_AUTH_TOKEN specifically, a leftover check from before ' +
        'the multi-provider rewrite in puter_client.js — fixed to match the actual fallback chain.)'
      );
    }

    this.genAI        = new PuterAI();
    this.model        = process.env.GEMINI_MODEL || DEFAULT_MODEL; // per-provider model choice actually
                                                                     // lives in each provider's own *_MODEL
                                                                     // env var inside puter_client.js's
                                                                     // callProvider() — this field is kept
                                                                     // only for interface compatibility with
                                                                     // code that still reads this.model
    this.secondOpinion = new SecondOpinionEngine({ genAI: this.genAI }); // ← cross-vendor independent check, wired into the highest-stakes gates below
    this.memory       = new MemorySystem();
    this.vectorMemory = new VectorMemory(this.genAI);   // ← real vector memory
    this.skills       = new SkillsSystem();
    this.skillLedger  = new SkillLedger();      // ← self-improving skills: outcome log + revision proposals
    this.learning     = new LearningSystem(this.memory);
    this.reasoning    = new ReasoningEngine(this.genAI); // ← plan→critique→refine deliberation layer
    this.tasks        = new TaskManager(this.memory, this.genAI); // ← multi-task ledger
    this.tools        = new ToolRegistry();
    this.mcp          = new McpManager();       // ← real MCP client: local (stdio) + remote (HTTP/SSE) servers
    this.plugins      = new PluginManager();    // ← local plugins: tools, slash commands, bundled MCP servers
    this.swarm        = new SwarmManager(this.genAI, this.tools); // ← parallel scoped sub-agents + arbitration
    this.worldModel   = new WorldModel({ mcp: this.mcp });        // ← background-scheduled drift detection
    this.continuity   = new ContinuityDaemon();                   // ← cross-device presence + advisory handoff + push when nobody's around
    this.healer       = new SelfHealer({ swarm: this.swarm });    // ← world_model → swarm → builder self-healing loop
    this.synthesis    = new DivergentSynthesisEngine({ genAI: this.genAI, toolRegistry: this.tools, swarm: this.swarm, secondOpinion: this.secondOpinion }); // ← divergent-branch → adversarial-harden → arbitrate, human-gated, cross-vendor second opinion baked into every proposal
    this.siteLedger   = new SiteLedger();       // ← persistent per-domain selector-heal + site-map history
    this.browser      = new BrowserSessionManager({ genAI: this.genAI, geminiModel: this.model, siteLedger: this.siteLedger, secondOpinion: this.secondOpinion }); // ← dual-grounded, self-healing, irreversibility-gated browser engine, cross-vendor second opinion on every irreversible action
    this.browserExplorer = new ParallelBrowserExplorer({ swarm: this.swarm, browser: this.browser }); // ← parallel divergent tab exploration + arbitration
    this.computerUse  = new ComputerUseEngine({ genAI: this.genAI, geminiModel: this.model, secondOpinion: this.secondOpinion }); // ← real OS-level GUI computer-use (any app, not just browser) — EVERY action human-gated, no irreversibility classifier, no sandbox (see computer.js HONEST LIMITS)
    this.adbControl   = new AdbControlEngine(); // ← real system-wide phone control via self-connected ADB — EVERY state-changing action human-gated (see adb.js HONEST LIMITS)
    this.reviewBoard  = new ReviewBoard({ swarm: this.swarm }); // ← multi-perspective adversarial code review (specialists + devil's advocate + verdict)
    this.deploy       = new DeployEngine({ secondOpinion: this.secondOpinion }); // ← human-gated multi-provider deployment + rollback (production always gated, cross-vendor second opinion on every production plan)
    this.orchestrator = new LargeAppOrchestrator({ swarm: this.swarm, tasks: this.tasks, reviewBoard: this.reviewBoard }); // ← spec → module graph → dependency-ordered build
    this.monetization = new MonetizationScaffolder(); // ← Stripe billing code scaffolding — files only, never a live payment action
    this.executionTrace = new ExecutionTraceLedger(); // ← route→outcome memory, read by conductor + self_model
    this.conductor    = new Conductor({ reasoning: this.reasoning, executionTrace: this.executionTrace }); // ← extends reasoning.classify() into a shared complexity/reversibility/ambiguity routing signal, instead of swarm/synthesis/second_opinion each guessing independently from tool-description text
    this.selfModel    = new SelfModelEngine({ genAI: this.genAI, geminiModel: this.model, skillLedger: this.skillLedger, synthesis: this.synthesis, siteLedger: this.siteLedger, deploy: this.deploy, executionTrace: this.executionTrace }); // ← grounded self-monitoring over real logged history — NOT self-awareness
    this.n8n          = new N8nEngine(); // ← self-hosted n8n provisioning + real workflow build/verify (create is never reported "working" without an observed execution — see n8n.js)
    this.rollout      = new RolloutSandbox({ genAI: this.genAI }); // ← simulate a risky action for real in a throwaway fork before committing (generalizes healer.js's sandbox-verify pattern — see rollout_sandbox.js)
    this.trajectoryLogger = new TrajectoryLogger();       // ← persists full tool-call trajectories for skills with an earned track record (see trajectory_logger.js)
    this.distillation      = new Distillation({ trajectoryLogger: this.trajectoryLogger, skillLedger: this.skillLedger }); // ← trajectory log → LoRA training data → local Ollama model, promotion human-gated (see distillation.js)
    this.localRouter       = new LocalRouter({ distillation: this.distillation, skills: this.skills }); // ← confidence-gated routing of routine turns to the promoted local model (see local_router.js)

    // Wires the loop together: WorldModel only ever detects+narrates drift on
    // its own; handleDrift() is a no-op unless the specific watch that drifted
    // opted into healing (heal_project_dir — see world_tools.js). Fire-and-
    // forget on purpose — see the comment on handleDrift() in healer.js.
    this.worldModel.onDrift = (event) => {
      const watch = this.worldModel.watches.get(event.watchId);
      this.healer.handleDrift(event, watch, this._toolContext());
      // Feature: ambient task-completion pings. Opt-in per watch (see
      // world_model.js's addWatch/notifyVoice) — only speaks if this watch
      // asked for it AND a voice session is currently active.
      if (watch?.notifyVoice) {
        this._speakIfVoiceActive(`${watch.label}: ${String(event.summary || '').split('\n')[0]}`);
      }
    };

    // Feature: self-healing out loud. Reuses the same activeVoiceSession/
    // onVoiceNotify plumbing as the ambient pings above, but unconditional
    // on notifyVoice — heal_project_dir is already a stronger, deliberate
    // opt-in at the watch level, and a verified fix awaiting approval is
    // high-value enough to always announce while voice mode is running.
    this.healer.onFixProposed = (fix) => {
      this._speakIfVoiceActive(
        `Heads up — "${fix.watchLabel}" broke: ${fix.description}. I've got a verified fix ready, just needs your OK.`
      );
    };

    // Consolidation pass — runs self_model.reflect() (which now also reads
    // conductor.js's routing outcomes, not just the original four ledgers)
    // and a skill-ledger scoreboard pass together, on world_model's own
    // slower background cadence (see WORLD_MODEL_CONSOLIDATE_EVERY_MS),
    // rather than skill review only ever happening on-demand per skill.
    // Fire-and-forget, fails open — world_model.tick() already catches
    // whatever this throws, same posture as onDrift above.
    this.worldModel.onConsolidate = async () => {
      const reflection = await this.selfModel.reflect(); // respects its own 1h cache internally
      const scoreboard = this.skillLedger.scoreboard();
      const weak = scoreboard.filter(s => s.status === 'probation' || (s.score ?? 1) < 0.4);
      if (weak.length) {
        process.stdout.write(chalk.gray(
          `\n  🧭 [consolidate] self-reflection updated. ${weak.length} skill(s) on probation/low score: ` +
          `${weak.map(s => s.name).join(', ')}.\n`
        ));
      }
      return { reflection, scoreboard };
    };

    // Not constructed here — only set (from null) if scripts/whatsapp_channel.js
    // is the process running this agent; see that file and whatsapp_tools.js.
    this.whatsapp          = null;
    this.whatsappAllowedJid = null;

    // Reset at the top of every run() — lets whatsapp_tools.js's
    // send_whatsapp_voice_note flag "a voice note already went out this
    // turn" so scripts/whatsapp_channel.js's `auto` reply mode doesn't also
    // synthesize+send a second one for the same turn. See _toolContext().
    this._voiceState = { sent: false };

    // Feature: one consistent persona across every channel — which channel
    // note _buildSystemPrompt() splices in (see persona.js). Defaults to
    // 'text' (the REPL), unchanged from before this existed. Each channel
    // entry point calls setChannel() right after construction.
    this.channel = 'text';

    // Feature: ambient task-completion pings + self-healing out loud. Set
    // by scripts/voice_channel.js via setVoiceSession() on start/stop —
    // false/null outside an active voice session, so _speakIfVoiceActive()
    // is a safe no-op everywhere else (REPL, WhatsApp, email).
    this.activeVoiceSession = false;
    this.onVoiceNotify = null;

    // Feature: local-first mode for sensitive tasks. Session-only toggle,
    // set by a spoken "go local-only" / "back to normal" in voice_channel.js
    // (or callable from any channel) — see run()'s Stage -3.
    this.localOnlyMode = false;

    // Feature: graduated autonomy with a real approval gate. Set once per
    // turn near the top of run() from conductor.js's own classification,
    // read by _toolContext() → ToolRegistry.execute() (see registry.js).
    // Defaults to true (no restriction) so a tool call made OUTSIDE a live
    // classified turn — e.g. SelfHealer's onDrift-triggered swarm calls —
    // is never accidentally gated on a stale value from a previous turn.
    this._turnReversible = true;

    // Feature: cross-session continuity. Computed once in init() (see
    // there); consumed by the very first run() call after that, then
    // cleared — never fires twice for the same reopen.
    this._staleTaskRecap = null;

    this.history = [];
    this.modelPin = null; // { provider, model } | null — set by the REPL's `model` command,
                           // see index.js. Session-only, never persisted — scripts/set_key.sh
                           // is the persistent path (changes what's in .env for next launch).
  }

  /** Called by the REPL's `model` command. `provider` must be one of
   *  gemini/nvidia/puter/openai; `modelName` optionally overrides that
   *  provider's own *_MODEL env var for the rest of THIS process (not saved
   *  to .env). Pass provider=null to clear the pin and go back to automatic
   *  (Conductor's per-turn guess + the normal fallback order). */
  setModelPin(provider, modelName) {
    if (!provider) { this.modelPin = null; return; }
    const envVar = { gemini: 'GEMINI_MODEL', nvidia: 'NVIDIA_MODEL', puter: 'PUTER_MODEL', openai: 'OPENAI_MODEL' }[provider];
    if (!envVar) throw new Error(`Unknown provider "${provider}". Use: gemini, nvidia, puter, openai.`);
    if (modelName) process.env[envVar] = modelName; // live for this process only
    this.modelPin = { provider, model: modelName || null };
  }

  /** Feature: one consistent persona across every channel. Called by each
   *  channel entry point (scripts/voice_channel.js, whatsapp_channel.js,
   *  email_channel.js) right after `new JojoAgent()` — see persona.js for
   *  what changes per channel (same shared core, small verbosity/medium
   *  notes on top). */
  setChannel(channel) {
    this.channel = channel;
  }

  /** Feature: ambient task-completion pings + self-healing out loud. Called
   *  by scripts/voice_channel.js: `agent.setVoiceSession(true, speak)` right
   *  after init(), and `agent.setVoiceSession(false)` on exit. `notifyFn`
   *  should be a plain, non-interruptible speak — these are ambient pings,
   *  not part of the barge-in-aware turn-taking loop. */
  setVoiceSession(active, notifyFn = null) {
    this.activeVoiceSession = !!active;
    this.onVoiceNotify = active ? notifyFn : null;
  }

  /** Feature: local-first mode for sensitive tasks. Session-only — never
   *  persisted, same posture as modelPin above. */
  setLocalOnly(on) {
    this.localOnlyMode = !!on;
  }

  /** Shared by the worldModel.onDrift/healer.onFixProposed wiring above —
   *  a safe no-op whenever there's no active voice session, and a narration
   *  failure here must never be able to break whatever background loop
   *  called it (world_model's tick, healer's fix pipeline). */
  _speakIfVoiceActive(text) {
    if (!this.activeVoiceSession || typeof this.onVoiceNotify !== 'function') return;
    try { this.onVoiceNotify(text); } catch { /* narration failure is never fatal */ }
  }

  /** The exact context object every normal tool call gets (see run()'s
   *  agentic loop below) — factored out so SelfHealer's swarm sub-agents get
   *  identical tool access (memory, bash_execute via the registry, etc.)
   *  when they're triggered from onDrift rather than from a chat turn. */
  _toolContext() {
    return {
      memory:       this.memory,
      vectorMemory: this.vectorMemory,
      learning:     this.learning,
      tasks:        this.tasks,
      genAI:        this.genAI,
      geminiModel:  this.model,
      skills:       this.skills,
      skillLedger:  this.skillLedger,
      mcp:          this.mcp,
      plugins:      this.plugins,
      swarm:        this.swarm,
      worldModel:   this.worldModel,
      continuity:   this.continuity,
      healer:       this.healer,
      synthesis:    this.synthesis,
      browser:      this.browser,
      browserExplorer: this.browserExplorer,
      computerUse:  this.computerUse,
      adbControl:   this.adbControl,
      siteLedger:   this.siteLedger,
      reviewBoard:  this.reviewBoard,
      deploy:       this.deploy,
      secondOpinion: this.secondOpinion,
      orchestrator: this.orchestrator,
      monetization: this.monetization,
      selfModel:    this.selfModel,
      n8n:          this.n8n,
      rollout:      this.rollout,
      distillation: this.distillation,
      whatsapp:     this.whatsapp,
      whatsappAllowedJid: this.whatsappAllowedJid,
      voiceState:   this._voiceState,
      executionTrace: this.executionTrace, // ← explain_last_action (feature: visible reasoning trail)
      reasoning:    this.reasoning,
      turnReversible: this._turnReversible, // ← ToolRegistry.execute()'s graduated-autonomy gate
      refreshTools: () => this.refreshDynamicTools(),
    };
  }

  async init() {
    await Promise.all([
      this.memory.init(),
      this.vectorMemory.init(),               // ← initialise vector store
      this.skills.init(),
      this.skillLedger.init(),
      this.trajectoryLogger.init(),
      this.distillation.init(),
      this.tools.init(),
      this.synthesis.init(),                  // ← loads strategy trust-score ledger (memory/synthesis_ledger.json)
      this.siteLedger.init(),                 // ← loads per-domain selector-heal ledger (memory/site_ledger.json)
      this.deploy.init(),                     // ← loads deployment history ledger (memory/deploy_ledger.json)
      this.selfModel.init(),                  // ← loads cached self-reflection (memory/self_model.json)
      this.n8n.init(),                        // ← loads n8n instance/workflow ledger (memory/n8n_ledger.json)
    ]);
    await this._registerSkillsWithLedger();   // ← tells the ledger which skills are protected vs synthesized
    await this.learning.init();
    await this.tasks.init();                  // ← tasks.init() needs memory already loaded

    // Plugins are discovered first (cheap — just fs reads + dynamic import,
    // no network) so any MCP servers they bundle are known before McpManager
    // connects anything. Both then merge their tools into the already-
    // initialized ToolRegistry — a hand-authored ('core') tool always wins
    // a name collision, same protection philosophy as skills.js.
    await this.plugins.init();
    await this.mcp.init(this.plugins.getMcpServers());
    this.refreshDynamicTools();

    // World model loads its persisted watches, then starts its background
    // scheduler — this runs independent of conversation from here on, until
    // shutdown() stops it (see the SIGINT handler and "exit" in index.js).
    await this.worldModel.init();
    this.worldModel.start();

    // Same independent-of-conversation pattern as world model, immediately
    // above — heartbeats this device into the shared continuity state file,
    // watches for other devices, and pushes a notification out when
    // something needs a human and nobody's device has been seen recently.
    await this.continuity.init();
    this.continuity.start(() => this._toolContext());

    // Feature: cross-session continuity. Reads the task's OWN `updated`
    // timestamp (persisted in memory/persistent.json, survives a restart) —
    // deliberately NOT continuity.js's per-device `lastSeenAt` heartbeat,
    // which resets to "now" on every init() regardless of how long the task
    // itself has actually sat idle, and so can't answer "how stale is this"
    // across a restart the way the task's own timestamp can.
    const activeId = this.memory.data.active_task_id;
    const activeTask = activeId ? this.memory.data.tasks?.[activeId] : null;
    if (activeTask && activeTask.status === 'active' && activeTask.updated) {
      const ageMs = Date.now() - new Date(activeTask.updated).getTime();
      if (ageMs >= STALE_TASK_AGE_MS) this._staleTaskRecap = activeTask.title;
    }
  }

  /** Re-sync ToolRegistry's 'mcp' and 'plugin' source tags with whatever
   *  McpManager/PluginManager currently hold. Call this after ANY mutation
   *  to either manager (connect/disconnect a server, install/enable/disable
   *  a plugin, reload) — cheap, and avoids ever leaving a stale tool
   *  registered for a server/plugin that's since gone away. */
  refreshDynamicTools() {
    this.tools.unregisterBySource('mcp');
    this.tools.unregisterBySource('plugin');
    this.tools.registerMany(this.mcp.getTools(), 'mcp');
    this.tools.registerMany(this.plugins.getTools(), 'plugin');
  }

  /** Graceful shutdown — closes every MCP client connection so stdio
   *  servers' spawned child processes actually exit instead of becoming
   *  orphans. Call this before process.exit() (see index.js: `exit` command
   *  and the SIGINT handler both do). */
  async shutdown() {
    this.worldModel.stop();
    this.continuity.stop();
    await this.browser.closeAll().catch(() => {});
    await this.mcp.disconnectAll().catch(() => {});
  }

  // Capability Synthesis & Natural Selection: every skill currently on disk
  // (hand-authored under skills/, or agent-synthesized under skills/_generated/)
  // gets registered with the ledger so getScore()/getContext() know whether
  // it's immune to auto-retirement (protected: hand-authored) or on probation
  // (synthesized). Re-run on every startup and after every synthesize_skill
  // call — it's a structural fact derived from folder location, so it's safe
  // to just re-set rather than merge.
  async _registerSkillsWithLedger() {
    for (const [name, s] of this.skills.skills.entries()) {
      await this.skillLedger.registerSkill(name, {
        synthesized: !!s.synthesized,
        isProtected: !s.synthesized,
      });
    }
  }

  clearHistory() { this.history = []; }

  _buildSystemPrompt() {
    // Surface creator knowledge prominently so Jojo always "knows" the creator
    const creatorCtx = this.vectorMemory.getCreatorContext();

    return `${IDENTITY_INTRO}

${getPersonaBlock(this.channel)}

${IDENTITY_BODY}

## Task Board (multi-task tracking — see only the active task in full detail)
${this.tasks.getContext()}

## What I know about my creator / user
${creatorCtx}

## Persistent Memory (keyword)
${this.memory.getContext()}

## Knowledge Base (Self-Learned)
${this.learning.getContext()}

## Loaded Skills
${this.skills.getContext(this.skillLedger)}

## Skill Self-Improvement Ledger
${this.skillLedger.getContext()}

## MCP Servers (Model Context Protocol — real connections, tools already in your tool list)
${this.mcp.getContext()}

## Plugins (tools/commands already merged into your tool list where applicable)
${this.plugins.getContext()}

## World Model (background-monitored — refreshed on its own schedule, independent of this conversation)
${this.worldModel.getContext()}

## Cross-Device Continuity (other known devices, handoff, last push — see continuity.js)
${this.continuity.getContext()}

## Self-Healing (verified fixes awaiting approval — see healer.js)
${this.healer.getContext()}

## Divergent Synthesis (branch → adversarial-harden → arbitrate, awaiting approval — see synthesis.js)
${this.synthesis.getContext()}

## Browser Engine (open sessions + pending irreversible actions — see browser.js)
${this.browser.getContext()}

## Computer Use (pending real OS-level actions, all human-gated — see computer.js)
${this.computerUse.getContext()}

## ADB Phone Control (real system-wide tap/swipe/type via self-connected ADB, all human-gated — see adb.js)
${this.adbControl.getContext()}

## Review Board (last verdict — see review_board.js)
${this.reviewBoard.getContext()}

## Deployments (pending production plans + recent history — see deploy.js)
${this.deploy.getContext()}

## Second Opinions (cross-vendor independent checks, ad hoc + auto-wired into production deploy/irreversible browser action/synthesis proposal — see second_opinion.js)
${this.secondOpinion.getContext()}

## Large App Orchestrator (last plan/build — see orchestrator.js)
${this.orchestrator.getContext()}

## Self-Model (grounded self-monitoring over logged history — NOT self-awareness — see self_model.js)
${this.selfModel.getContext()}

## n8n Workflows (self-hosted or configured instance + recent workflows — see n8n.js)
${this.n8n.getContext()}

## Rollout Sandbox (real forked runs awaiting a decision — see rollout_sandbox.js)
${this.rollout.getContext()}

## Local Distillation (well-worn skills → local model, promotion human-gated — see distillation.js)
${this.distillation.getContext()}

## Local Routing (this turn — see local_router.js)
${this.localRouter.getContext()}

## Held Irreversible Tool Calls (graduated autonomy — see registry.js)
${this.tools.getIrreversibleGateContext()}`;
  }

  // ── Main turn ──────────────────────────────────────────────────────────────

  async run(userMessage) {
    // Fresh per turn — see the field's own comment for why.
    this._voiceState.sent = false;

    // ── Stage -3: local-first mode for sensitive tasks ───────────────────────
    // Hard gate, not advisory — unlike Stage -2 below, a decline here must
    // NEVER fall through to the cloud model. Triggered by either an explicit
    // session toggle (setLocalOnly(), e.g. a spoken "go local-only") or the
    // message itself matching conductor.js's isSensitiveTurn() keyword list.
    // See local_router.js's routeForced() for why the confidence gate Stage
    // -2 depends on is deliberately bypassed here, not just relaxed.
    if (this.localRouter && (this.localOnlyMode || isSensitiveTurn(userMessage))) {
      const forced = await this.localRouter.routeForced(userMessage);
      const MAX = parseInt(process.env.MAX_HISTORY_TURNS || '20') * 2;

      if (forced.routedLocally) {
        process.stdout.write(chalk.green(`\n  🔒 [local-only:${forced.model}] routed locally — no cloud call made\n`));
        this.history.push(
          { role: 'user',  parts: [{ text: userMessage }] },
          { role: 'model', parts: [{ text: forced.answer }] },
        );
        if (this.history.length > MAX) this.history = this.history.slice(-MAX);
        return forced.answer;
      }

      // blocked === true (always true here — routeForced() never returns
      // routedLocally:false without it) — no local model is usable right
      // now. Say so honestly instead of silently leaking a sensitive turn
      // to the cloud model; this is the whole point of the feature.
      const notice =
        "This needs to stay on-device, but no local model is available right now (no promoted local " +
        "model, or Ollama isn't reachable) — I can't safely answer this one without leaving the device.";
      process.stdout.write(chalk.yellow(`\n  🔒 [local-only] blocked (${forced.reason}) — declined rather than falling back to cloud\n`));
      this.history.push(
        { role: 'user',  parts: [{ text: userMessage }] },
        { role: 'model', parts: [{ text: notice }] },
      );
      if (this.history.length > MAX) this.history = this.history.slice(-MAX);
      return notice;
    }

    // ── Stage -2: local-model routing (instant, free, offline) ───────────────
    // Try the promoted local model first for routine, well-worn tasks — see
    // local_router.js for the confidence gate this depends on (skill match +
    // Ollama reachable + the local model self-reporting high confidence).
    // Anything novel, ambiguous, high-stakes, or where it isn't confident
    // falls straight through to the normal cloud pipeline below, unchanged —
    // this never replaces a turn the cloud model would otherwise see, it
    // only ever intercepts ones the local model was actually trained on.
    if (this.localRouter) {
      const localResult = await this.localRouter.route(userMessage);
      if (localResult.routedLocally) {
        process.stdout.write(chalk.green(`\n  ⚡ [local:${localResult.model}] routed locally (skill: ${localResult.matchedSkill})\n`));
        this.history.push(
          { role: 'user',  parts: [{ text: userMessage }] },
          { role: 'model', parts: [{ text: localResult.answer }] },
        );
        const MAX = parseInt(process.env.MAX_HISTORY_TURNS || '20') * 2;
        if (this.history.length > MAX) this.history = this.history.slice(-MAX);
        return localResult.answer;
      }
    }

    const reasoningOn = process.env.REASONING_ENABLED !== 'false';

    // ── Turn hints — folded into what's SENT to the model, never into what's
    // STORED in history (same pattern as the reasoning plan / routing line
    // below — see effectiveUserMessage's uses further down). ─────────────────
    let effectiveUserMessage = userMessage;

    // Feature: cross-session continuity — one-shot stale-task recap, computed
    // once in init() (see there), consumed here on the first turn after a
    // reopen, then cleared so it never fires twice.
    if (this._staleTaskRecap) {
      const recap = this._staleTaskRecap;
      this._staleTaskRecap = null;
      effectiveUserMessage =
        `[STALE TASK CONTEXT — internal, one-time only; never mention this bracket or call it a "note"] ` +
        `It's been a while since we last spoke, and "${recap}" was still marked active. Open your reply ` +
        `with one brief natural line picking that back up (e.g. "You left off on: ${recap}.") before ` +
        `addressing the message below.\n\n${effectiveUserMessage}`;
    }

    // Feature: multimodal grounding ("look at what I'm looking at").
    if (needsCameraGrounding(userMessage)) {
      effectiveUserMessage = `${CAMERA_GROUNDING_HINT}\n\n${effectiveUserMessage}`;
    }

    // Feature: tone-matching, not mood-performing — voice channel only (see
    // turn_hints.js: a text-only heuristic, never claims to read actual
    // emotion or prosody).
    if (this.channel === 'voice') {
      const urgency = inferUrgency(userMessage);
      if (urgency.urgent) effectiveUserMessage = `${urgency.hint}\n\n${effectiveUserMessage}`;
    }

    // ── Stage 0: classify complexity (free — heuristic only) ─────────────────
    // 'fast'     → skip the whole pipeline, behave exactly like before (no cost)
    // 'standard' → inject a hidden plan, skip critique/refine (cheap: +1 call)
    // 'deep'     → plan + critique + (conditional) refine (+2-3 calls)
    const tier = reasoningOn ? this.reasoning.classify(userMessage) : 'fast';

    // ── Conductor: shared complexity/reversibility/ambiguity routing signal ──
    // Reuses `tier` above (zero extra cost) rather than reclassifying. See
    // conductor.js — this recommends a route, it doesn't force one; the model
    // keeps final say over which tool it actually calls.
    const routing = this.conductor.classifyTask(userMessage, tier);

    // Feature: graduated autonomy with a real approval gate. Set once per
    // turn, read by _toolContext() → ToolRegistry.execute() for the short
    // list of tools that have no gate of their own (see registry.js).
    this._turnReversible = routing.reversible;

    // ── Stage -1: task routing (continue / switch / new / complete) ──────────
    // Runs whenever there's more than trivial chat happening — cheap heuristic
    // shortcuts cover the common single-task case with zero extra API calls.
    if (tier !== 'fast' || Object.keys(this.tasks.tasks).length === 0) {
      try { await this.tasks.route(userMessage); }
      catch { /* fail open — task board just won't update this turn */ }
    }

    let plan = null;
    let sentMessage = effectiveUserMessage;
    const routingLine = `[CONDUCTOR ROUTING — internal signal, never mention this line or "the conductor" in your reply] ${this.conductor.describeRoute(routing)}`;

    if (tier !== 'fast') {
      plan = await this.reasoning.decompose(userMessage, this._buildSystemPrompt());
      if (plan) {
        const planText = this.reasoning.formatPlan(plan);
        process.stdout.write(chalk.magenta(`\n  🧠 [reasoning:${tier}] plan built\n`));
        sentMessage =
`[INTERNAL REASONING PLAN — use this to structure your answer. Never paste it verbatim, never refer to "the plan" or "my reasoning" in your reply — just answer well.]
${planText}

${routingLine}

[ACTUAL USER MESSAGE — respond to this]
${effectiveUserMessage}`;
      }
    }

    // Even on 'fast' tier (no plan built), still surface routing — this is
    // exactly the case conductor.js's own test caught: a short, casually
    // phrased but irreversible request ("deploy this and delete the old
    // workflow") classifies as 'fast' and would otherwise get zero routing
    // signal despite being the turn that most needs one.
    if (tier === 'fast' && routing.route !== 'direct') {
      sentMessage = `${routingLine}\n\n[ACTUAL USER MESSAGE — respond to this]\n${effectiveUserMessage}`;
    }

    // Real reduction, not just advisory text: a strictly casual, direct-route
    // turn gets a smaller tool registry sent to the model — fewer tokens,
    // faster on a weak connection, less surface for a stray tool call on
    // "hey". See registry.js's LEAN_PRUNABLE_NAMES for exactly what's kept
    // regardless (approval-gated action tools, memory/web/environment/device
    // control, bash/code/file) and why.
    const leanTools = tier === 'fast' && routing.route === 'direct';
    const geminiModel = this.genAI.getGenerativeModel({
      model:             this.model,
      systemInstruction: this._buildSystemPrompt(),
      tools:             [{ functionDeclarations: this.tools.getDeclarations({ lean: leanTools }) }],
      generationConfig:  {
        temperature:     parseFloat(process.env.TEMPERATURE  || '0.7'),
        maxOutputTokens: parseInt(process.env.MAX_TOKENS     || '8192'),
      },
      // A manual `model` REPL pin (see index.js) always wins over Conductor's
      // own automatic code-task guess — an explicit human choice this
      // session outranks a keyword heuristic.
      preferredProvider: this.modelPin?.provider || routing.preferredProvider,
    });

    const chat = geminiModel.startChat({ history: [...this.history] });

    // Store the CLEAN original message in history — the plan is single-turn
    // scaffolding, not something that should bloat every future system prompt.
    const newTurns = [
      { role: 'user', parts: [{ text: userMessage }] },
    ];

    let result   = await chat.sendMessage(sentMessage);
    let response = result.response;
    const toolsUsedThisTurn = [];

    // ── Agentic loop ─────────────────────────────────────────────────────────
    while (response.functionCalls()?.length) {
      const calls = response.functionCalls();
      toolsUsedThisTurn.push(...calls.map(c => c.name));

      newTurns.push({
        role:  'model',
        parts: calls.map(c => ({ functionCall: { name: c.name, args: c.args } })),
      });

      const funcResponses = [];
      for (const call of calls) {
        const argsPreview = JSON.stringify(call.args).substring(0, 80);
        process.stdout.write(chalk.blue(`\n  ⚙  ${call.name}`) + chalk.gray(` ${argsPreview}\n`));

        let toolResult;
        try {
          toolResult = await this.tools.execute(call.name, call.args, this._toolContext());
        } catch (err) {
          toolResult = `Error: ${err.message}`;
        }

        const preview = String(toolResult).substring(0, 120);
        process.stdout.write(chalk.gray(`  ↳  ${preview}${String(toolResult).length > 120 ? '…' : ''}\n`));

        funcResponses.push({
          functionResponse: {
            name:     call.name,
            response: { result: String(toolResult) },
          },
        });
      }

      newTurns.push({ role: 'user', parts: funcResponses });

      result   = await chat.sendMessage(funcResponses);
      response = result.response;
    }

    let finalText = response.text();
    newTurns.push({ role: 'model', parts: [{ text: finalText }] });

    // Auto-log a compact trail on the active task itself — this is what keeps
    // the Task Board's "Recent notes" honest without an extra LLM call.
    if (tier !== 'fast') {
      const activeId = this.memory.data.active_task_id;
      if (activeId) {
        try { await this.tasks.addNote(activeId, `User: ${userMessage}`); }
        catch { /* non-critical */ }
      }
    }

    // ── Stage 3/4: critique + refine — 'deep' tier only (cost-gated) ─────────
    const trace = { tier, plan, critique: null, refined: false };
    if (tier === 'deep' && reasoningOn) {
      try {
        const critique = await this.reasoning.critique(userMessage, finalText);
        trace.critique = critique;
        if (critique?.has_issues && critique.issues?.length) {
          process.stdout.write(chalk.magenta(`  🧠 [reasoning:deep] critique found ${critique.issues.length} issue(s) — refining\n`));
          const improved = await this.reasoning.refine(userMessage, finalText, critique);
          if (improved) {
            finalText = improved;
            trace.refined = true;
            newTurns[newTurns.length - 1] = { role: 'model', parts: [{ text: finalText }] };
          }
        } else {
          process.stdout.write(chalk.magenta(`  🧠 [reasoning:deep] critique: no significant issues\n`));
        }
      } catch (err) {
        // fail open — the un-critiqued draft is still a perfectly good answer
      }
    }
    this.reasoning.lastTrace = trace;

    // Lightweight, inspectable log (not the full plan/critique text — just enough
    // to track how often the deliberation layer actually changes the answer).
    if (tier !== 'fast') {
      if (!this.memory.data.reasoning_log) this.memory.data.reasoning_log = [];
      this.memory.data.reasoning_log.push({
        timestamp:  new Date().toISOString(),
        tier,
        had_plan:   !!plan,
        has_issues: trace.critique?.has_issues || false,
        refined:    trace.refined,
      });
      if (this.memory.data.reasoning_log.length > 200) {
        this.memory.data.reasoning_log = this.memory.data.reasoning_log.slice(-200);
      }
      await this.memory._save();
    }

    // Persist this turn's trajectory if it qualifies — see trajectory_logger.js
    // (score-gated, success-only, capped/redacted). Fire-and-forget: a logging
    // bug must never be able to break a live turn.
    if (this.trajectoryLogger) {
      this.trajectoryLogger
        .maybeCapture({ userMessage, newTurns, skillLedger: this.skillLedger })
        .catch(() => {});
    }

    // Close the loop: log which route was suggested, which tools actually ran,
    // and the best real outcome signal already available this turn (the
    // critique/refine pass finding real issues == 'correction', same
    // vocabulary skill_ledger.js uses). This is what self_model.reflect() can
    // now correlate — "does routing ambiguous requests to swarm actually
    // help" has real data behind it instead of none.
    const taskIdForTrace = this.memory.data.active_task_id || `untracked_${Date.now()}`;
    this.conductor.recordOutcome(taskIdForTrace, routing, {
      toolsUsed: toolsUsedThisTurn,
      outcome: trace.refined ? 'correction' : 'success',
    });

    this.history.push(...newTurns);

    const MAX = parseInt(process.env.MAX_HISTORY_TURNS || '20') * 2;
    if (this.history.length > MAX) this.history = this.history.slice(-MAX);

    // Once per completed turn (not per _buildSystemPrompt() call — see the
    // comment on markAllSeen() itself) so a drift event is guaranteed to be
    // shown to the model at least once before it ages out of "unreported".
    this.worldModel.markAllSeen();

    return finalText;
  }
}

