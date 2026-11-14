import { DEFAULT_MODEL } from './puter_client.js';

// ── TaskManager ────────────────────────────────────────────────────────────────
// A persisted, inspectable task ledger that lets Jojo juggle several distinct
// threads of work in one conversation (or across a whole session) without
// the full detail of unrelated tasks bleeding into the current one.
//
// WHY THIS EXISTS:
// The previous architecture had exactly one structure for "everything going
// on": a flat chat history array. That's fine for a single back-and-forth,
// but the moment a person says "also, separately, can you look at X" and
// later "okay back to the first thing" — there's no structure that knows
// those are two different threads, so the model has to re-infer it from
// raw transcript every time, and unrelated detail from thread B sits in
// context while you're working on thread A.
//
// WHAT THIS ADDS:
//   - Each distinct piece of work becomes a Task: { id, title, status,
//     summary, notes[], facts[] } persisted to memory/persistent.json.
//   - On each non-trivial turn, a small router call decides whether the
//     message continues the active task, switches to an existing one,
//     starts a new one, or closes one out — same pattern as a person
//     managing their own open tabs.
//   - getContext() builds a compact "Task Board": full detail for the
//     ACTIVE task only, one-line summaries for other open tasks, and just
//     a count for done ones. That's the actual fix for "confusion across
//     tasks" — bound what's in the prompt, don't dump everything always.
//
// HONEST LIMITS:
//   - The router is a heuristic + one small hidden LLM call, not magic.
//     It will occasionally misjudge an ambiguous "continue vs new" call,
//     same as a human skimming a thread would. JoJo can always be told
//     directly ("switch to the other task", "this is something new") and
//     the explicit task tools (task_tools.js) let it act on that.
//   - This does not give JoJo a literally larger context window — it makes
//     better use of the one it has by not wasting it on irrelevant detail.

const MAX_NOTES_PER_TASK = 12;
const MAX_FACTS_PER_TASK = 10;
const DONE_TASKS_SHOWN   = 3;

function shortId() {
  return 't_' + Math.random().toString(36).slice(2, 8);
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function agoLabel(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export class TaskManager {
  constructor(memory, genAI) {
    this.memory = memory;
    this.genAI  = genAI;
    this.lastRoute = null; // inspectable via "tasks" CLI command
  }

  async init() {
    const d = this.memory.data;
    if (!d.tasks) d.tasks = {};            // { id: Task }
    if (!('active_task_id' in d)) d.active_task_id = null;
  }

  // ── internal helpers ────────────────────────────────────────────────────

  _model(temperature = 0.1, maxOutputTokens = 250) {
    return this.genAI.getGenerativeModel({
      model: process.env.PUTER_MODEL || DEFAULT_MODEL,
      generationConfig: { temperature, maxOutputTokens },
    });
  }

  async _askJson(prompt) {
    const result = await this._model().generateContent(prompt);
    const text   = result.response.text().replace(/```json\n?|```/g, '').trim();
    try { return JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
      return null;
    }
  }

  get tasks() { return this.memory.data.tasks; }

  _openTasks() {
    return Object.values(this.tasks).filter(t => t.status !== 'done');
  }

  _get(id) { return this.tasks[id] || null; }

  async _save() { await this.memory._save(); }

  // ── mutations ───────────────────────────────────────────────────────────

  async createTask(title) {
    // Auto-pause whatever was active — only one task is "active" at a time.
    const prevActiveId = this.memory.data.active_task_id;
    if (prevActiveId && this._get(prevActiveId) && this._get(prevActiveId).status === 'active') {
      this._get(prevActiveId).status = 'paused';
    }
    const id = shortId();
    const now = new Date().toISOString();
    this.tasks[id] = {
      id, title: truncate(title, 90), status: 'active',
      summary: '', notes: [], facts: [],
      created: now, updated: now,
    };
    this.memory.data.active_task_id = id;
    await this._save();
    return this.tasks[id];
  }

  async switchTo(id) {
    const t = this._get(id);
    if (!t) return null;
    const prevActiveId = this.memory.data.active_task_id;
    if (prevActiveId && prevActiveId !== id && this._get(prevActiveId)?.status === 'active') {
      this._get(prevActiveId).status = 'paused';
    }
    t.status = 'active';
    t.updated = new Date().toISOString();
    this.memory.data.active_task_id = id;
    await this._save();
    return t;
  }

  async setStatus(id, status) {
    const t = this._get(id);
    if (!t) return null;
    t.status = status;
    t.updated = new Date().toISOString();
    if (status === 'done' && this.memory.data.active_task_id === id) {
      // Hand "active" to the most recently touched remaining open task, if any.
      const next = this._openTasks().sort((a, b) => new Date(b.updated) - new Date(a.updated))[0];
      this.memory.data.active_task_id = next ? next.id : null;
      if (next) next.status = 'active';
    }
    await this._save();
    return t;
  }

  async addNote(id, note) {
    const t = this._get(id);
    if (!t) return null;
    t.notes.push(truncate(note, 240));
    if (t.notes.length > MAX_NOTES_PER_TASK) t.notes = t.notes.slice(-MAX_NOTES_PER_TASK);
    t.updated = new Date().toISOString();
    await this._save();
    return t;
  }

  async addFact(id, fact) {
    const t = this._get(id);
    if (!t) return null;
    t.facts.push(truncate(fact, 200));
    if (t.facts.length > MAX_FACTS_PER_TASK) t.facts = t.facts.slice(-MAX_FACTS_PER_TASK);
    await this._save();
    return t;
  }

  // ── the router: continue / switch / new / complete ─────────────────────
  // Called once per non-trivial turn. Fails open to "continue" on any error
  // so a flaky router call never blocks the conversation.

  async route(userMessage) {
    const open = this._openTasks();
    const activeId = this.memory.data.active_task_id;

    // No tasks yet at all → always a new one, no LLM call needed.
    if (open.length === 0) {
      const task = await this.createTask(truncate(userMessage, 70));
      this.lastRoute = { action: 'new', task_id: task.id, reason: 'first task in session' };
      return this.lastRoute;
    }

    // Exactly one open task and it's already active → cheap heuristic only.
    // Strong "this is something different" signals still trigger a real check.
    const switchSignal = /\b(separately|different question|another thing|new question|by the way|unrelated|switch(?:ing)? to|on a different note|forget that for now|pause that|new task)\b/i.test(userMessage);
    if (open.length === 1 && open[0].id === activeId && !switchSignal) {
      this.lastRoute = { action: 'continue', task_id: activeId, reason: 'only one open task, no switch signal' };
      return this.lastRoute;
    }

    // Otherwise: ask a small hidden call to decide, given the open task list.
    const taskList = open.map(t =>
      `- id="${t.id}" title="${t.title}" status=${t.status}${t.id === activeId ? ' (currently ACTIVE)' : ''} summary="${truncate(t.summary, 100)}"`
    ).join('\n');

    const prompt = `You are the task-routing module of an AI agent juggling multiple open tasks in one conversation.
Decide what this new message means for task tracking. Do not answer the user — only route.

Open tasks:
${taskList}

New user message:
"""${userMessage}"""

Respond ONLY with valid JSON, no markdown fences:
{
  "action": "continue" | "switch" | "new" | "complete",
  "task_id": "id of the task to switch to or mark complete (required for switch/complete, omit for continue/new)",
  "new_task_title": "short title, only if action is new",
  "reason": "one short phrase"
}`;

    let decision;
    try {
      decision = await this._askJson(prompt);
    } catch {
      decision = null;
    }

    if (!decision || !decision.action) {
      this.lastRoute = { action: 'continue', task_id: activeId, reason: 'router failed — fail open' };
      return this.lastRoute;
    }

    if (decision.action === 'switch' && decision.task_id && this._get(decision.task_id)) {
      await this.switchTo(decision.task_id);
      this.lastRoute = decision;
      return decision;
    }
    if (decision.action === 'new') {
      const task = await this.createTask(decision.new_task_title || truncate(userMessage, 70));
      decision.task_id = task.id;
      this.lastRoute = decision;
      return decision;
    }
    if (decision.action === 'complete' && decision.task_id && this._get(decision.task_id)) {
      await this.setStatus(decision.task_id, 'done');
      this.lastRoute = decision;
      return decision;
    }

    // 'continue' or any unrecognized task_id → stay on the active task.
    this.lastRoute = { action: 'continue', task_id: activeId, reason: decision.reason || 'default' };
    return this.lastRoute;
  }

  // ── context block injected into the system prompt every turn ──────────
  // Bound and partitioned on purpose: full detail for the ACTIVE task only.

  getContext() {
    const all = Object.values(this.tasks);
    if (!all.length) return '(no tasks tracked yet — the first message will open one automatically)';

    const activeId = this.memory.data.active_task_id;
    const active   = activeId ? this._get(activeId) : null;
    const others   = this._openTasks().filter(t => t.id !== activeId);
    const done     = all.filter(t => t.status === 'done')
                         .sort((a, b) => new Date(b.updated) - new Date(a.updated));

    let out = `You are tracking ${all.length} task(s) in this conversation. `;
    out += `Use this board to stay oriented — don't mix detail from one task into another.\n\n`;

    if (active) {
      out += `▶ ACTIVE — "${active.title}" [${active.id}] (updated ${agoLabel(active.updated)})\n`;
      if (active.summary) out += `  Summary: ${active.summary}\n`;
      if (active.notes.length) out += `  Recent notes:\n${active.notes.slice(-4).map(n => `    • ${n}`).join('\n')}\n`;
      if (active.facts.length) out += `  Key facts: ${active.facts.slice(-5).join(' | ')}\n`;
    } else {
      out += `(no active task currently)\n`;
    }

    if (others.length) {
      out += `\nOther open tasks (paused/blocked — full detail hidden until you switch back):\n`;
      out += others.map(t => `  - [${t.id}] "${t.title}" (${t.status}, ${agoLabel(t.updated)})`).join('\n') + '\n';
    }

    if (done.length) {
      out += `\nDone (${done.length} total, most recent ${Math.min(DONE_TASKS_SHOWN, done.length)}): `;
      out += done.slice(0, DONE_TASKS_SHOWN).map(t => `"${t.title}"`).join(', ') + '\n';
    }

    return out.trim();
  }

  // ── CLI display ─────────────────────────────────────────────────────────

  print(chalk) {
    const all = Object.values(this.tasks);
    console.log(chalk.cyan('\n🗂️  Task Board:\n'));
    if (!all.length) { console.log(chalk.gray('  (empty)\n')); return; }
    const activeId = this.memory.data.active_task_id;
    all.sort((a, b) => new Date(b.updated) - new Date(a.updated)).forEach(t => {
      const marker = t.id === activeId ? '▶' : ' ';
      const color  = t.status === 'done' ? chalk.gray : t.status === 'active' ? chalk.green : chalk.yellow;
      console.log(color(`  ${marker} [${t.id}] ${t.title} — ${t.status} (${agoLabel(t.updated)})`));
      if (t.summary) console.log(chalk.gray(`      ${t.summary}`));
    });
    console.log('');
  }
}

