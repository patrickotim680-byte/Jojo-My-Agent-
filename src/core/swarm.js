// ── Sub-Agent Swarm Manager ─────────────────────────────────────────────────
//
// Feature: "Sub-agent swarming with result arbitration"
//
// The main agentic loop in agent.js runs ONE reasoning thread against the
// FULL tool registry. This module lets that loop spawn several scoped,
// EPHEMERAL sub-agents mid-task — each with a narrow toolset and its own
// isolated context window (its own chat history, never shared with the
// parent or with siblings) — run them in parallel on different facets of
// one hard problem, then reconcile their outputs with a single arbitration
// pass instead of just picking one sub-agent's answer.
//
// This is deliberately built as a generalization of reasoning.js's
// critique/refine pattern: a "sub-agent" is just another call to the same
// genAI client with its own system prompt and a restricted view of
// ToolRegistry, and _arbitrate() below is the same "hidden model call that
// looks for real problems" idea as ReasoningEngine.critique() — except
// instead of critiquing one draft, it reconciles N parallel drafts and
// explicitly reports where they disagree.
//
// Design constraints (read before changing the caps below):
//   - Sub-agents are ephemeral: no shared memory with each other or with the
//     parent beyond the tool CONTEXT object (memory/vectorMemory/etc, same as
//     any normal tool call) — their chat history dies with them. If something
//     they learn should persist, the arbitration report is what the parent
//     agent sees and can then choose to vector_remember.
//   - Sub-agents can NEVER spawn further swarms, add MCP servers, install
//     plugins, or apply skill-ledger updates, no matter what tool_names a
//     caller lists for them — see FORBIDDEN_FOR_SUBAGENTS. Those actions are
//     either human-approval-gated in the main loop or would let a bounded
//     fan-out (MAX_AGENTS) turn into an unbounded one.
//   - Every sub-agent call loop is capped (maxIterations) and wrapped in a
//     per-agent timeout. One sub-agent hanging or erroring never blocks the
//     others (Promise.allSettled) — it just reports the failure as its
//     "finding" and arbitration proceeds with whatever succeeded.

import { DEFAULT_MODEL } from './puter_client.js';
import chalk from 'chalk';

const DEFAULT_MAX_ITERATIONS = 6;
const DEFAULT_TIMEOUT_MS     = 90_000;
const MAX_AGENTS             = 6;

// Tools a sub-agent may never be given, regardless of what the parent
// requests via `tools: [...]`. A sub-agent's individual tool calls are NOT
// watched turn-by-turn the way the parent's are (see the "trace" of a
// normal run() vs. a swarm's collapsed final report) — so anything that
// spawns processes/servers persistently, mutates skills, or could itself
// fan out into another swarm stays exclusively with the parent.
const FORBIDDEN_FOR_SUBAGENTS = new Set([
  'spawn_subagent_swarm',   // no recursive swarms — bounds cost and fork-bombs
  'mcp_add_server',         // side-effecting + human-approval-gated in agent.js
  'plugin_install',         // side-effecting + human-approval-gated in agent.js
  'apply_skill_update',     // ledger mutation gated on explicit human approval
]);

function uid() {
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Sub-agent "${label}" timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class SwarmManager {
  /**
   * @param {object} genAI        - Same PuterAI-shaped client agent.js uses.
   * @param {ToolRegistry} toolRegistry - The PARENT's full registry. Sub-agents
   *   only ever get a name-filtered read of it — see _restrictedTools().
   */
  constructor(genAI, toolRegistry) {
    this.genAI = genAI;
    this.toolRegistry = toolRegistry;
    this.lastRun = null; // { task, agents, results, arbitration } — inspectable, mirrors reasoning.js's lastTrace
  }

  // ── Restricted tool view ──────────────────────────────────────────────────

  /** A read-only, name-filtered view of the parent's ToolRegistry. Forbidden
   *  names are dropped even if explicitly requested. Unknown names are
   *  silently dropped too (not an error) — the sub-agent just won't have
   *  a tool that doesn't exist, same as omitting it. */
  _restrictedTools(names = []) {
    const requested = new Set(names || []);
    const allDeclarations = this.toolRegistry.getDeclarations();
    const allowed = allDeclarations.filter(d => requested.has(d.name) && !FORBIDDEN_FOR_SUBAGENTS.has(d.name));
    return {
      declarations: allowed,
      names: allowed.map(d => d.name),
      execute: (name, args, ctx) => this.toolRegistry.execute(name, args, ctx),
    };
  }

  // ── One ephemeral sub-agent ────────────────────────────────────────────────

  async _runSubAgent({ role, focus, task, toolNames, sharedContext, maxIterations }) {
    const restricted = this._restrictedTools(toolNames);
    const trace = [];

    const systemPrompt = `You are an ephemeral, narrowly-scoped sub-agent spawned as one facet of a larger \
parallel investigation. Stay strictly inside your lane — other sub-agents are covering their own \
facets of the same task right now; do not try to cover their ground too.

Your role / facet: ${role}
Your specific focus: ${focus}
Shared task context (what the overall investigation is about): ${task}

Investigate using only the tools you've been given — they were deliberately chosen for this facet. \
When you're done, respond with a concise, CONCRETE report of your findings for THIS facet only: \
specific issues, observations, or conclusions — not generic advice. If you genuinely find nothing \
notable, say so plainly rather than padding the response. Do not answer on behalf of other facets.`;

    const model = this.genAI.getGenerativeModel({
      model: process.env.PUTER_MODEL || DEFAULT_MODEL,
      systemInstruction: systemPrompt,
      tools: restricted.names.length ? [{ functionDeclarations: restricted.declarations }] : undefined,
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048,
      },
    });

    const chat = model.startChat({ history: [] });
    let result   = await chat.sendMessage(`Begin investigating: ${focus}`);
    let response = result.response;
    let iterations = 0;

    while (response.functionCalls?.()?.length && iterations < maxIterations) {
      iterations++;
      const calls = response.functionCalls();
      const funcResponses = [];
      for (const call of calls) {
        let toolResult;
        try {
          toolResult = await restricted.execute(call.name, call.args, sharedContext);
        } catch (err) {
          toolResult = `Error: ${err.message}`;
        }
        trace.push({ tool: call.name, args: call.args });
        funcResponses.push({
          functionResponse: { name: call.name, response: { result: String(toolResult) } },
        });
      }
      result   = await chat.sendMessage(funcResponses);
      response = result.response;
    }

    return {
      id: uid(),
      role,
      focus,
      findings: (response.text() && response.text().trim()) || '(no findings returned)',
      tool_calls: trace.length,
      hit_iteration_cap: iterations >= maxIterations && !!response.functionCalls?.()?.length,
    };
  }

  // ── Arbitration pass ──────────────────────────────────────────────────────

  /** Single hidden model call: reconcile N parallel findings into one report.
   *  Same "fail open" philosophy as reasoning.js's critique/refine — if this
   *  call itself errors, run() falls back to the raw, unmerged per-agent
   *  findings rather than losing the sub-agents' work. */
  async _arbitrate(task, results) {
    const findingsBlock = results
      .map(r => `### ${r.role}${r.focus ? ` (focus: ${r.focus})` : ''}${r.error ? ' [FAILED]' : ''}\n${r.findings}`)
      .join('\n\n');

    const prompt = `You are the arbitration pass over several sub-agents that just investigated the same \
task in parallel, each from a different angle. Your job is to MERGE their findings — not to pick one \
sub-agent's report and discard the rest, and not to just concatenate them either.

Task: """${task}"""

Sub-agent findings:
${findingsBlock.slice(0, 6000)}

Respond ONLY with valid JSON, no markdown fences:
{
  "summary": "2-4 sentence overall synthesis across all sub-agents",
  "merged_findings": ["consolidated, deduplicated finding (note which role(s) raised it)", "..."],
  "conflicts": ["a specific point where sub-agents disagreed or gave contradictory guidance, and what the disagreement actually is — omit this field's array entries entirely if there are none, do not invent conflicts"],
  "priority_action": "the single most important next step given everything found, or empty string if genuinely nothing actionable came up"
}`;

    const model = this.genAI.getGenerativeModel({
      model: process.env.PUTER_MODEL || DEFAULT_MODEL,
      generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
    });

    try {
      const result = await model.generateContent(prompt);
      const text = (result.response.text() || '').trim().replace(/```json\n?|```/g, '').trim();
      try { return JSON.parse(text); }
      catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        return null;
      }
    } catch {
      return null; // fail open — run() falls back to raw per-agent findings
    }
  }

  // ── Public entry point ─────────────────────────────────────────────────────

  /**
   * @param {string} task   - Shared task/target every sub-agent investigates its own facet of.
   * @param {Array<{role:string, focus:string, tools?:string[]}>} agents
   * @param {object} opts
   * @param {number} [opts.maxIterations] - Per-sub-agent tool-call round cap.
   * @param {number} [opts.timeoutMs]     - Per-sub-agent wall-clock cap.
   * @param {object} [opts.sharedContext] - The normal tool-execute context (memory, vectorMemory, ...).
   */
  async run(task, agents = [], { maxIterations = DEFAULT_MAX_ITERATIONS, timeoutMs = DEFAULT_TIMEOUT_MS, sharedContext = {} } = {}) {
    if (!task || !String(task).trim()) return 'Error: swarm needs a non-empty task description.';
    if (!Array.isArray(agents) || !agents.length) return 'Error: provide at least one sub-agent as { role, focus, tools }.';

    const bounded = agents.slice(0, MAX_AGENTS);
    if (agents.length > MAX_AGENTS) {
      process.stdout.write(chalk.yellow(`  [swarm] capped at ${MAX_AGENTS} sub-agents (${agents.length} requested)\n`));
    }

    process.stdout.write(chalk.magenta(`\n  🐝 [swarm] spawning ${bounded.length} sub-agent(s) in parallel: ${bounded.map(a => a.role || '?').join(', ')}\n`));

    const settled = await Promise.allSettled(
      bounded.map(a => withTimeout(
        this._runSubAgent({
          role: a.role || 'unnamed',
          focus: a.focus || task,
          task,
          toolNames: a.tools || [],
          sharedContext,
          maxIterations,
        }),
        timeoutMs,
        a.role || 'unnamed',
      ))
    );

    const results = settled.map((s, i) => {
      const fallbackRole = bounded[i].role || `agent_${i + 1}`;
      if (s.status === 'fulfilled') return s.value;
      return {
        id: uid(), role: fallbackRole, focus: bounded[i].focus,
        findings: `(sub-agent failed: ${s.reason?.message || s.reason})`,
        tool_calls: 0, error: true,
      };
    });

    results.forEach(r => {
      const preview = String(r.findings).replace(/\n/g, ' ').slice(0, 90);
      process.stdout.write(chalk.magenta(`  🐝 [swarm:${r.role}] `) + chalk.gray(`${r.tool_calls} tool call(s) — ${preview}${String(r.findings).length > 90 ? '…' : ''}\n`));
    });

    const arbitration = await this._arbitrate(task, results);
    this.lastRun = { task, agents: bounded, results, arbitration };
    return this._format(task, results, arbitration);
  }

  _format(task, results, arbitration) {
    const lines = [`Swarm investigation of: ${task}`, ''];
    results.forEach(r => {
      lines.push(`── ${r.role}${r.error ? ' [FAILED]' : ''}${r.hit_iteration_cap ? ' [hit iteration cap — may be incomplete]' : ''} ──`);
      lines.push(r.findings);
      lines.push('');
    });
    if (arbitration) {
      lines.push('── Arbitration (merged across all sub-agents) ──');
      if (arbitration.summary) lines.push(arbitration.summary);
      if (arbitration.merged_findings?.length) {
        lines.push('', 'Merged findings:');
        arbitration.merged_findings.forEach(f => lines.push(`  • ${f}`));
      }
      if (arbitration.conflicts?.length) {
        lines.push('', '⚠ Where sub-agents disagreed:');
        arbitration.conflicts.forEach(c => lines.push(`  • ${c}`));
      } else {
        lines.push('', '(no disagreements between sub-agents)');
      }
      if (arbitration.priority_action) lines.push('', `Priority action: ${arbitration.priority_action}`);
    } else {
      lines.push('── Arbitration pass failed — raw per-agent findings above are unmerged ──');
    }
    return lines.join('\n');
  }
}

