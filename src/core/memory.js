import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

// ── Storage ───────────────────────────────────────────────────────────────────

const DIR  = './memory';
const FILE = path.join(DIR, 'persistent.json');
const MAX_FACTS = 200;

// ── Feature: relationship-aware context ─────────────────────────────────────
// Cheap, honest heuristic — same class as conductor.js's keyword lists: a
// name-shaped fact is one where a relationship word ("sister", "friend", ...)
// is immediately followed by a capitalized token, OR the fact starts with
// "<Capitalized Word> is/likes/works/..." (a direct "X is my ..." / "X likes
// ..." pattern). This will occasionally miss a name or mis-flag a capitalized
// non-name word — same honest-limits posture as everywhere else in this
// codebase's heuristic classification; recall() still falls back to the flat
// fact search below when no person match is found, so a miss here costs
// nothing beyond not getting the shortcut.
const RELATION_WORD_RE =
  /\b(?:sister|brother|mom|mother|dad|father|wife|husband|partner|friend|colleague|coworker|boss|manager|cousin|aunt|uncle|son|daughter|neighbor|roommate|boyfriend|girlfriend|fianc[ée]e?|grandma|grandpa|grandmother|grandfather)\s+([A-Z][a-zA-Z'-]{1,30})\b/;
const LEADING_NAME_RE = /^([A-Z][a-zA-Z'-]{1,30})\s+(?:is|likes|loves|works|lives|has|wants|needs|prefers|hates|enjoys)\b/;

export function extractPersonName(fact) {
  const text = String(fact || '');
  const m = text.match(RELATION_WORD_RE) || text.match(LEADING_NAME_RE);
  return m ? m[1] : null;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT = {
  facts:            [],   // free-form strings the agent explicitly saves
  entities:         {},   // named entities: { "Alice": { notes: "...", type: "person" } }
  // Feature: relationship-aware context. A second, name-indexed view over
  // the SAME facts (nothing is removed from the flat `facts` log above) —
  // { "priya": { name: "Priya", aliases: [], facts: [...] } }. Populated
  // automatically by _indexPerson() whenever a remembered fact looks
  // name-shaped (see extractPersonName below). Deliberately separate from
  // `entities` above (which is caller-populated, arbitrary-type, and never
  // auto-derived) rather than overloading it.
  people:           {},
  preferences:      {},   // user preferences
  knowledge:        {},   // self-learned topics: { topic → { summary, key_facts, confidence, ... } }
  learning_log:     [],   // learning session history
  reasoning_log:    [],   // [ { timestamp, tier, had_plan, has_issues, refined } ] — deliberation history
  tasks:            {},   // { taskId → { id, title, status, summary, notes[], facts[] } } — multi-task ledger
  active_task_id:   null, // currently active task id, or null
  skills_practiced: {},   // skill name → { level 1-5, sessions, history[] }
  self_eval_history:[],   // [ { score, timestamp } ]
  meta: { version: '2.0.0', created: '' },
};

// ── MemorySystem ──────────────────────────────────────────────────────────────

export class MemorySystem {
  constructor() {
    this.data = structuredClone(DEFAULT);
  }

  async init() {
    await fs.mkdir(DIR, { recursive: true });
    try {
      const raw = await fs.readFile(FILE, 'utf-8');
      // Merge: DEFAULT provides new v2 fields; stored data overrides
      this.data = { ...DEFAULT, ...JSON.parse(raw) };
    } catch {
      this.data.meta.created = new Date().toISOString();
      await this._save();
    }
  }

  async _save() {
    this.data.meta.updated = new Date().toISOString();
    await fs.writeFile(FILE, JSON.stringify(this.data, null, 2));
  }

  // ── Context for system prompt ─────────────────────────────────────────────
  // Keep under ~500 tokens — called every turn.

  getContext() {
    const facts    = this.data.facts.slice(-30);
    const entities = Object.keys(this.data.entities);

    let out = '';

    out += `### Facts (${facts.length})\n`;
    out += facts.length
      ? facts.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : '(none yet)';

    if (entities.length) {
      out += '\n\n### Entities\n';
      out += entities.map(k => {
        const e = this.data.entities[k];
        return `- **${k}** (${e.type || 'thing'}): ${e.notes || ''}`;
      }).join('\n');
    }

    const people = Object.values(this.data.people || {});
    if (people.length) {
      out += '\n\n### People (name-linked facts — see recall())\n';
      out += people.map(p =>
        `- **${p.name}**${p.aliases?.length ? ` (aka ${p.aliases.join(', ')})` : ''}: ${p.facts.length} fact(s)`
      ).join('\n');
    }

    return out;
  }

  // ── Tool-facing API (called by memory_tools.js) ───────────────────────────

  async remember(fact) {
    this.data.facts.push(fact);
    if (this.data.facts.length > MAX_FACTS) {
      this.data.facts = this.data.facts.slice(-MAX_FACTS);
    }
    this._indexPerson(fact);
    await this._save();
    return `Remembered: "${fact}"`;
  }

  /** Best-effort — a fact that doesn't look name-shaped just isn't indexed
   *  here; it's still in the flat `facts` log above either way. */
  _indexPerson(fact) {
    const name = extractPersonName(fact);
    if (!name) return;
    if (!this.data.people) this.data.people = {};
    const key = name.toLowerCase();
    if (!this.data.people[key]) this.data.people[key] = { name, aliases: [], facts: [] };
    this.data.people[key].facts.push(fact);
  }

  recall(query) {
    const q = query.toLowerCase();
    const personHit = this._recallPerson(q);
    if (personHit) return personHit;
    const hits = this.data.facts.filter(f => f.toLowerCase().includes(q));
    if (!hits.length) return 'No memories match that query.';
    return hits.map((h, i) => `${i + 1}. ${h}`).join('\n');
  }

  /** Name/alias-first lookup over the people index — tried before the flat
   *  fact search above so "what does Priya like" finds Priya's facts even if
   *  the word "Priya" happens to also appear loosely inside unrelated facts.
   *  Returns null (falls through to the flat search) if there's no person
   *  match OR the matched person has no facts recorded yet. */
  _recallPerson(lowerQuery) {
    if (!this.data.people) return null;
    for (const key of Object.keys(this.data.people)) {
      const p = this.data.people[key];
      const names = [p.name, ...(p.aliases || [])].filter(Boolean).map(n => n.toLowerCase());
      const matched = names.some(n => new RegExp(`\\b${escapeRegex(n)}\\b`).test(lowerQuery));
      if (matched && p.facts.length) {
        return p.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
      }
    }
    return null;
  }

  async forget(index) {
    const i = Number(index) - 1;
    if (i < 0 || i >= this.data.facts.length) {
      return `Index out of range (have ${this.data.facts.length} facts).`;
    }
    const [removed] = this.data.facts.splice(i, 1);
    await this._save();
    return `Forgot: "${removed}"`;
  }

  // ── CLI display ───────────────────────────────────────────────────────────

  show() {
    console.log(chalk.cyan('\n📧  Persistent Memory:\n'));
    const { facts, entities } = this.data;

    if (!facts.length) {
      console.log(chalk.gray('  (empty)\n'));
    } else {
      facts.forEach((f, i) => console.log(chalk.white(`  ${i + 1}. ${f}`)));
    }

    if (Object.keys(entities).length) {
      console.log(chalk.cyan('\n  Entities:'));
      Object.entries(entities).forEach(([k, v]) =>
        console.log(chalk.white(`  · ${k}: ${v.notes || ''}`))
      );
    }
    console.log('');
  }

  showKnowledge() {
    const knowledge = this.data.knowledge || {};
    const topics    = Object.keys(knowledge);
    console.log(chalk.cyan('\n📚  Knowledge Base:\n'));
    if (!topics.length) {
      console.log(chalk.gray('  (empty — use "learn <topic>" or "explore")\n'));
      return;
    }
    topics.forEach(t => {
      const k   = knowledge[t];
      const age = Math.floor((Date.now() - new Date(k.learned_at).getTime()) / 86_400_000);
      console.log(chalk.white(`  📖 ${t}`) + chalk.gray(` [${k.confidence}/${k.skill_level}, ${age}d ago]`));
      console.log(chalk.gray(`     ${(k.summary || '').slice(0, 100)}…`));
    });
    const skills = this.data.skills_practiced || {};
    const skillList = Object.keys(skills);
    if (skillList.length) {
      console.log(chalk.cyan('\n  Practiced Skills:'));
      skillList.forEach(s => {
        const sk = skills[s];
        console.log(chalk.white(`  · ${s}: level ${Number(sk.level || 1).toFixed(1)}/5, ${sk.sessions || 0} sessions`));
      });
    }
    console.log('');
  }
}

