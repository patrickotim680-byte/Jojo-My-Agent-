// ── Tool Registry ─────────────────────────────────────────────────────────────
// To add a new tool group:
//   1. Create src/tools/my_tools.js  (see bash.js as template)
//   2. Import it below and spread it into ALL_TOOLS

import { BASH_TOOLS        } from './bash.js';
import { CODE_TOOLS        } from './code.js';
import { FILE_TOOLS        } from './files.js';
import { WEB_TOOLS         } from './web.js';
import { MEMORY_TOOLS      } from './memory_tools.js';
import { LEARNING_TOOLS    } from './learning_tools.js';
import { WIDGET_TOOLS      } from './widget.js';
import { MULTIMODAL_TOOLS  } from './multimodal_tools.js';
import { TASK_TOOLS        } from './task_tools.js';
import { NMAP_TOOLS        } from './nmap.js';
import { AIRCRACK_TOOLS   } from './aircrack.js';
import { HOLO_NARRATOR_TOOLS } from './holo_narrator.js';
import { BLENDER_TOOLS       } from './blender_tools.js';
import { BLENDER_VIEWER_TOOLS } from './blender_teacher_viewer.js';
import { UNREAL_TOOLS         } from './unreal_tools.js';
import { SKILL_TOOLS          } from './skill_tools.js';
import { MCP_TOOLS            } from './mcp_tools.js';
import { PLUGIN_TOOLS         } from './plugin_tools.js';
import { BUILD_TOOLS          } from './build_tools.js';
import { SWARM_TOOLS          } from './swarm_tools.js';
import { WORLD_TOOLS          } from './world_tools.js';
import { HEAL_TOOLS            } from './heal_tools.js';
import { SYNTHESIS_TOOLS        } from './synthesis_tools.js';
import { BROWSER_TOOLS          } from './browser_tools.js';
import { COMPUTER_TOOLS          } from './computer_tools.js';
import { REVIEW_TOOLS            } from './review_tools.js';
import { DEPLOY_TOOLS             } from './deploy_tools.js';
import { ORCHESTRATOR_TOOLS       } from './orchestrator_tools.js';
import { MONETIZATION_TOOLS       } from './monetization_tools.js';
import { SELF_MODEL_TOOLS         } from './self_model_tools.js';
import { SECOND_OPINION_TOOLS     } from './second_opinion_tools.js';
import { N8N_TOOLS                } from './n8n_tools.js';
import { ROLLOUT_TOOLS             } from './rollout_tools.js';
import { DISTILLATION_TOOLS        } from './distillation_tools.js';
import { WHATSAPP_TOOLS             } from './whatsapp_tools.js';
import { CONTINUITY_TOOLS            } from './continuity_tools.js';
import { ENVIRONMENT_TOOLS            } from './environment_tools.js';
import { ANDROID_CONTROL_TOOLS         } from './android_control_tools.js';
import { ADB_TOOLS                    } from './adb_tools.js';
import { EXECUTION_TRACE_TOOLS        } from './execution_trace_tools.js';
import { ApprovalGate } from '../core/approval_gate.js';

const ALL_TOOLS = [
  ...BASH_TOOLS,
  ...CODE_TOOLS,         // ← real multi-language code execution
  ...FILE_TOOLS,
  ...WEB_TOOLS,
  ...MEMORY_TOOLS,
  ...LEARNING_TOOLS,
  ...WIDGET_TOOLS,
  ...MULTIMODAL_TOOLS,   // ← 8 multimodal tools
  ...TASK_TOOLS,         // ← multi-task tracking controls
  ...NMAP_TOOLS,         // ← nmap network scanner
  ...AIRCRACK_TOOLS,     // ← aircrack-ng wireless security suite
  ...HOLO_NARRATOR_TOOLS, // ← real-time 3D holographic narrator (WebGL + TTS)
  ...BLENDER_TOOLS,       // ← photoreal Cycles renders via local Blender install
  ...BLENDER_VIEWER_TOOLS, // ← narrated playback of Blender-rendered media
  ...UNREAL_TOOLS,         // ← build/package/run local Unreal Engine projects
  ...SKILL_TOOLS,          // ← self-improving skills: log outcomes, propose/apply SKILL.md revisions
  ...MCP_TOOLS,             // ← manage/inspect MCP server connections (the servers' own tools are registered dynamically, see below)
  ...PLUGIN_TOOLS,          // ← manage/inspect plugins (a plugin's own tools are registered dynamically, see below)
  ...BUILD_TOOLS,           // ← project scaffolding + real install/build/test verification pipeline
  ...SWARM_TOOLS,            // ← parallel scoped sub-agents + arbitration pass over a hard task
  ...WORLD_TOOLS,            // ← background-scheduled watches over files/dirs/commands/URLs/MCP resources
  ...HEAL_TOOLS,              // ← human-gated apply/dismiss/inspect for the self-healing loop (see healer.js)
  ...SYNTHESIS_TOOLS,          // ← divergent-branch → adversarial-harden → arbitrate, human-gated (see synthesis.js)
  ...BROWSER_TOOLS,            // ← dual-grounded, self-healing, irreversibility-gated browser automation (see browser.js)
  ...COMPUTER_TOOLS,            // ← real OS-level GUI computer-use, any app — every action human-gated, no sandbox (see computer.js)
  ...REVIEW_TOOLS,              // ← multi-perspective adversarial code review board (see review_board.js)
  ...DEPLOY_TOOLS,               // ← human-gated multi-provider deployment + rollback (see deploy.js)
  ...ORCHESTRATOR_TOOLS,         // ← large-app spec → module graph → dependency-ordered build (see orchestrator.js)
  ...MONETIZATION_TOOLS,         // ← Stripe billing code scaffolding — files only, never a live payment action (see monetization.js)
  ...SELF_MODEL_TOOLS,           // ← grounded self-monitoring over real logged history — NOT a claim of self-awareness (see self_model.js)
  ...SECOND_OPINION_TOOLS,       // ← cross-vendor independent verification, ad hoc use (see second_opinion.js)
  ...N8N_TOOLS,                   // ← self-hosted n8n provisioning + real workflow build/verify/deploy (see n8n.js)
  ...ROLLOUT_TOOLS,                // ← simulate a risky action for real in a throwaway fork before committing (see rollout_sandbox.js)
  ...DISTILLATION_TOOLS,            // ← build/train/export/promote a local LoRA distillation of well-worn skills (see distillation.js)
  ...WHATSAPP_TOOLS,                 // ← proactive WhatsApp text/voice-note push, only live when scripts/whatsapp_channel.js is running (see whatsapp_client.js)
  ...CONTINUITY_TOOLS,                // ← cross-device presence, advisory handoff, and push notifications when nobody's around (see continuity.js)
  ...ENVIRONMENT_TOOLS,                // ← real Android sensing (location/battery/wifi/sensors) + device actions via Termux:API (see environment_tools.js)
  ...ANDROID_CONTROL_TOOLS,             // ← real intent-based control: open apps/URLs, share, volume, wifi, gated SMS/calls (see android_control_tools.js)
  ...ADB_TOOLS,                        // ← real system-wide tap/swipe/type/screenshot via self-connected ADB, human-gated (see adb.js)
  ...EXECUTION_TRACE_TOOLS,             // ← explain what happened + why last turn, spoken-friendly (see execution_trace.js)
];

// ── Lean mode: which groups get pruned from a casual/direct-route turn ──────
// Previously, conductor.js's routing signal was advisory-only — the model
// still saw the full ~33-group registry on every single turn regardless of
// how casual the message was, costing real tokens/latency on a weak
// connection for zero benefit on "hey" or "thanks". This is the actual fix:
// getDeclarations({ lean: true }) drops these groups from what's SENT to the
// model. Nothing is unregistered — execute() still works identically either
// way — only the declarations offered this turn shrink.
//
// Deliberately NOT pruned, even in lean mode:
//   - WEB/MEMORY/ENVIRONMENT/ANDROID_CONTROL/BASH/CODE/FILE — plausibly
//     relevant even mid-casual-chat ("what's my battery", "remember X").
//   - HEAL/DEPLOY/SYNTHESIS/N8N — every one of these now runs through
//     approval_gate.js's propose→confirm pattern, which means a one-word
//     reply ("yes", "go ahead") can be the message that actually needs to
//     call apply_verified_fix/applyDeployment/etc. That reply alone would
//     often misclassify as casual — pruning these specifically would risk
//     breaking the exact approval flow this codebase is most careful about
//     elsewhere. Never worth the token savings.
const LEAN_PRUNABLE_GROUPS = [
  NMAP_TOOLS, AIRCRACK_TOOLS, HOLO_NARRATOR_TOOLS, BLENDER_TOOLS, BLENDER_VIEWER_TOOLS,
  UNREAL_TOOLS, MCP_TOOLS, PLUGIN_TOOLS, BUILD_TOOLS, SWARM_TOOLS, WORLD_TOOLS,
  BROWSER_TOOLS, COMPUTER_TOOLS, REVIEW_TOOLS, ORCHESTRATOR_TOOLS, MONETIZATION_TOOLS,
  SELF_MODEL_TOOLS, SECOND_OPINION_TOOLS, ROLLOUT_TOOLS, DISTILLATION_TOOLS,
  WHATSAPP_TOOLS, CONTINUITY_TOOLS, ADB_TOOLS, LEARNING_TOOLS, MULTIMODAL_TOOLS,
  SKILL_TOOLS, TASK_TOOLS, WIDGET_TOOLS,
];
const LEAN_PRUNABLE_NAMES = new Set(LEAN_PRUNABLE_GROUPS.flat().map(t => t.name));

// ── Feature: graduated autonomy with a real approval gate ───────────────────
// heal/deploy/synthesis/n8n/browser's apply_browser_action already gate
// their own irreversible action through approval_gate.js's propose()/apply()
// pair. This is the short, explicit list of tools that are JUST as
// irreversible (a message sent to a real person can't be unsent) but never
// got a gate of their own.
//
// Deliberately NOT "every tool, whenever conductor.js guesses reversible=
// false" — conductor.js's own IRREVERSIBLE_KEYWORDS list matches words as
// common as "delete", "call ", "text " (see its own HONEST LIMITS comment),
// and blanket-gating every tool call on that heuristic would hold up
// ordinary read_file/write_file/bash_execute calls constantly on nothing
// more than the word "delete" appearing in the user's message. This wraps
// the concrete gap that actually exists today, not a blanket policy.
const GATED_IRREVERSIBLE_TOOLS = new Set([
  'send_whatsapp_message',
  'send_whatsapp_voice_note',
]);

// Every tool above is tagged source: 'core' — hand-authored, always present,
// can never be evicted by registerMany() below. MCP servers and plugins are
// connected/loaded *after* ToolRegistry.init() runs (agent.js does this,
// since it needs the fully-initialized registry to merge into), so their
// tools are added afterwards with registerMany(tools, 'mcp' | 'plugin').
// Those two source tags are the ones unregisterBySource() clears before a
// reload — 'core' is never touched.

export class ToolRegistry {
  constructor() {
    this._map = new Map(); // name → { tool, source }
    // Feature: graduated autonomy — reuses the exact propose()/apply()
    // primitive heal.js/deploy.js/synthesis.js/n8n.js already use, rather
    // than inventing a fifth copy of the same mechanism (see
    // approval_gate.js's own header for why that matters).
    this.irreversibleGate = new ApprovalGate({ idPrefix: 'act', kind: 'irreversible tool call', maxPending: 20 });
  }

  async init() {
    for (const tool of ALL_TOOLS) {
      this._map.set(tool.name, { tool, source: 'core' });
    }
  }

  /** Register a batch of dynamically-discovered tools (from MCP servers or
   *  plugins) under a source tag. A hand-authored ('core') tool can never be
   *  shadowed — same "protected" philosophy as skills.js's hand-authored
   *  skills being immune to synthesis overwrites. Returns which names were
   *  actually added vs skipped for a collision, so callers can report it. */
  registerMany(tools, source) {
    const added = [];
    const skipped = [];
    for (const tool of tools) {
      const existing = this._map.get(tool.name);
      if (existing && existing.source === 'core') { skipped.push(tool.name); continue; }
      this._map.set(tool.name, { tool, source });
      added.push(tool.name);
    }
    return { added, skipped };
  }

  /** Remove every tool previously registered under a given source tag —
   *  called before a fresh registerMany() on reload so stale entries (e.g.
   *  a tool from a server that's since been removed) don't linger. */
  unregisterBySource(source) {
    for (const [name, entry] of this._map.entries()) {
      if (entry.source === source) this._map.delete(name);
    }
  }

  /** Returns array of FunctionDeclaration objects for Gemini.
   *  @param {boolean} [opts.lean] - drop the groups in LEAN_PRUNABLE_NAMES.
   *  Only ever prunes 'core' entries — MCP/plugin tools the user explicitly
   *  connected are always offered regardless of lean mode, since their very
   *  presence is an explicit signal the user wants them available. */
  getDeclarations({ lean = false } = {}) {
    const entries = Array.from(this._map.values());
    const kept = lean
      ? entries.filter(e => e.source !== 'core' || !LEAN_PRUNABLE_NAMES.has(e.tool.name))
      : entries;
    return kept.map(e => this._declarationFor(e.tool));
  }

  /** Gated tools get two extra OPTIONAL parameters spliced onto their real
   *  declaration (approval_id, human_approved) — see execute() below for the
   *  propose→hold→apply flow these support. Ungated tools pass through
   *  untouched. */
  _declarationFor(tool) {
    if (!GATED_IRREVERSIBLE_TOOLS.has(tool.name)) return tool.declaration;
    const base = tool.declaration;
    return {
      ...base,
      description: `${base.description} ⚠ If this turn looks irreversible, this call is held pending — show ` +
        `the human what it would do, then call this tool again with approval_id + human_approved=true ` +
        `(the id is returned by the first, held call) to actually send it.`,
      parameters: {
        ...base.parameters,
        properties: {
          ...base.parameters.properties,
          approval_id: {
            type: 'string',
            description: 'Only set on the SECOND call, once a human approved — the id returned by the first (held) call.',
          },
          human_approved: {
            type: 'boolean',
            description: 'Only set true on the SECOND call, after the human explicitly approved.',
          },
        },
      },
    };
  }

  /** Format for the system prompt — same shape as every other subsystem's
   *  getContext(), so a held tool call isn't invisible between turns. */
  getIrreversibleGateContext() {
    return this.irreversibleGate.getContext(r =>
      `${r.toolName}(${JSON.stringify(r.args)}) — call ${r.toolName} again with approval_id="${r.id}", ` +
      `human_approved=true once the human explicitly agrees.`
    );
  }

  /** Execute tool by name; context carries { memory, learning, ... } for stateful tools. */
  async execute(name, args, context = {}) {
    const entry = this._map.get(name);
    if (!entry) throw new Error(`Unknown tool: "${name}"`);

    // Feature: graduated autonomy with a real approval gate. Only kicks in
    // for the short GATED_IRREVERSIBLE_TOOLS list above, and only when THIS
    // turn's conductor classification said reversible===false (context.
    // turnReversible — set once per turn by agent.js's run(), see
    // _toolContext()). Everything else executes exactly as before.
    if (GATED_IRREVERSIBLE_TOOLS.has(name) && context.turnReversible === false) {
      const { approval_id, human_approved, ...toolArgs } = args || {};

      if (human_approved === true && approval_id) {
        const { ok, message, result } = await this.irreversibleGate.apply(approval_id, true, () =>
          entry.tool.execute(toolArgs, context)
        );
        return ok ? result : message;
      }

      const proposed = this.irreversibleGate.propose({ toolName: name, args: toolArgs });
      return `Holding "${name}" pending — this turn looks irreversible (conductor: reversible=false) and ` +
        `"${name}" has no gate of its own. Show the human exactly what this would send/do (args: ` +
        `${JSON.stringify(toolArgs)}), then call ${name} again with approval_id="${proposed.id}" and ` +
        `human_approved=true only once they explicitly agree.`;
    }

    return entry.tool.execute(args, context);
  }

  list() {
    return [...this._map.keys()];
  }

  listBySource(source) {
    return [...this._map.entries()].filter(([, e]) => e.source === source).map(([name]) => name);
  }

  /** Temporarily remove a set of tools by name (e.g. for a lower-trust
   *  channel like the email bridge — see scripts/email_channel.js) and
   *  return a snapshot to hand back to restoreTemporary() once the turn
   *  is done. Unlike unregisterBySource(), this works on 'core' tools too,
   *  since it's an explicit, temporary, caller-driven restriction rather
   *  than a reload sweep. Missing names are ignored. */
  disableTemporary(names) {
    const snapshot = [];
    for (const name of names) {
      const entry = this._map.get(name);
      if (entry) {
        snapshot.push([name, entry]);
        this._map.delete(name);
      }
    }
    return snapshot;
  }

  /** Put back everything removed by a prior disableTemporary() call. */
  restoreTemporary(snapshot) {
    for (const [name, entry] of snapshot) this._map.set(name, entry);
  }
}

