// ── World Model ──────────────────────────────────────────────────────────────
//
// Feature: "A live world-model instead of a request-response loop"
//
// Everything else in this codebase is reactive — it acts when spoken to.
// This module is the missing background scheduler + diffing layer that
// treats "state of the world" as a first-class object instead of just
// conversation history:
//
//   - watch()  registers something to keep an eye on: a file, a directory
//     (shallow listing), a shell command's output (CI status, a health-check
//     curl, anything scriptable), a URL, or an MCP resource.
//   - A single interval timer (start()), independent of whether anyone is
//     talking to Jojo right now, re-checks each watch on ITS OWN schedule
//     and diffs the new snapshot against the last one.
//   - A detected diff is a "drift event": recorded to the event log, printed
//     directly to the terminal AS IT HAPPENS (not deferred to the next
//     reply — see _recordEvent below), and surfaced in the next system
//     prompt via getContext() so the model proactively mentions it even if
//     the user's next message is about something unrelated.
//
// Storage mirrors vector_memory.js's pattern: memory/world_model.json,
// gitignored, loaded on init() so watches survive restarts.
//
// HONEST LIMIT: this is a single long-running Node process's in-memory
// timer, not a durable job queue — if the process isn't running, nothing is
// watched during that gap (the next tick after restart just establishes a
// fresh baseline rather than catching up on missed history). Good enough
// for "keep an eye on things while I'm using this," not a replacement for a
// real monitoring system for anything mission-critical.

import fs             from 'fs/promises';
import crypto         from 'crypto';
import chalk          from 'chalk';
import axios          from 'axios';
import { exec }       from 'child_process';
import { promisify }  from 'util';

const execAsync = promisify(exec);

const STATE_FILE               = './memory/world_model.json';
const DEFAULT_TICK_MS               = parseInt(process.env.WORLD_MODEL_TICK_MS               || '20000');  // scheduler cadence
const DEFAULT_WATCH_INTERVAL_MS     = parseInt(process.env.WORLD_MODEL_WATCH_INTERVAL_MS      || '60000'); // default per-watch re-check interval
const DEFAULT_CONSOLIDATE_EVERY_MS  = parseInt(process.env.WORLD_MODEL_CONSOLIDATE_EVERY_MS   || '3600000'); // 1h — self_model.reflect() + skill review cadence, deliberately much slower than the watch tick above since it's a real model call
const MAX_WATCHES              = 50;
const MAX_EVENT_LOG            = 200;

function hashText(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}
function uid(prefix = 'w') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── WorldModel ─────────────────────────────────────────────────────────────

export class WorldModel {
  /** @param {object} opts.mcp - optional McpManager ref, used by kind:'mcp_resource' watches */
  constructor({ mcp } = {}) {
    this.mcp     = mcp;
    this.watches = new Map(); // id -> watch record
    this.events  = [];        // drift event log, oldest first
    this._timer  = null;

    // Optional extension point: set to a function(event) to hook drift into
    // something beyond the built-in stdout narration below (e.g. a plugin
    // that posts to Slack). Not required — _recordEvent() already narrates
    // to the terminal directly regardless of whether this is set.
    this.onDrift = null;

    // Optional extension point, same shape as onDrift: set to an async
    // function() to run a periodic consolidation pass (self_model.reflect()
    // + skill ledger review — see JojoAgent's wiring). Deliberately on its
    // OWN, much slower cadence than the watch-check tick above — reflect()
    // makes a real model call, so running it every DEFAULT_TICK_MS (20s by
    // default) would be wasteful; CONSOLIDATE_EVERY_MS gates how often tick()
    // actually fires this, independent of how often watches themselves are
    // due for a re-check.
    this.onConsolidate = null;
    this._lastConsolidateAt = Date.now(); // first pass waits a full cadence after startup, not ~immediately
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    await fs.mkdir('./memory', { recursive: true }).catch(() => {});
    try {
      const raw  = await fs.readFile(STATE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      this.watches = new Map((data.watches || []).map(w => [w.id, w]));
      this.events  = data.events || [];
    } catch {
      // first run — nothing persisted yet, start empty
    }
  }

  async _save() {
    await fs.writeFile(STATE_FILE, JSON.stringify({
      watches: [...this.watches.values()],
      events:  this.events.slice(-MAX_EVENT_LOG),
    }, null, 2));
  }

  /** Begin the background scheduler. Independent of conversation — runs on
   *  its own interval regardless of whether the user is actively chatting.
   *  unref() so this timer alone never keeps the process alive on its own. */
  start(tickMs = DEFAULT_TICK_MS) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.tick().catch(() => {}); }, tickMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ── Watch management ─────────────────────────────────────────────────────

  async addWatch({ kind, target, label, intervalMs, heal, notifyVoice }) {
    if (this.watches.size >= MAX_WATCHES) {
      throw new Error(`Watch limit reached (${MAX_WATCHES}). Remove one with world_watch_remove first.`);
    }
    if (!['file', 'directory', 'command', 'url', 'mcp_resource'].includes(kind)) {
      throw new Error(`Unknown watch kind "${kind}". Use: file, directory, command, url, mcp_resource.`);
    }
    const watch = {
      id: uid(), kind, target, label: label || target,
      intervalMs: intervalMs || DEFAULT_WATCH_INTERVAL_MS,
      createdAt: new Date().toISOString(),
      lastCheckedAt: null,
      lastChangedAt: null,
      snapshot: null,
      lastError: null,
      // Opt-in only — set when the caller gives a projectDir. When present,
      // JojoAgent's onDrift wiring hands drift on this watch to SelfHealer
      // (healer.js) instead of just narrating it. See addWatch's tool-level
      // docs in world_tools.js for how a caller opts in.
      heal: heal?.projectDir ? { enabled: true, projectDir: heal.projectDir, stack: heal.stack || 'auto' } : null,
      // Feature: ambient task-completion pings. Opt-in only, separate from
      // `heal` above — when true AND a voice session is currently active
      // (see JojoAgent.setVoiceSession()), a drift event on this watch gets
      // spoken aloud, not just printed/narrated in the system prompt. See
      // agent.js's worldModel.onDrift wiring for where this is actually read.
      notifyVoice: !!notifyVoice,
    };
    this.watches.set(watch.id, watch);
    await this._checkOne(watch, { seedOnly: true }); // establish a baseline — no drift event on the first check
    await this._save();
    return watch;
  }

  /** Run the exact real check a watch of this kind/target would run, ONCE,
   *  without registering anything — no schedule, no persisted state, no
   *  drift event. Reuses _snapshotFor directly (the same kind-specific
   *  fingerprinting a live watch's scheduler tick calls) so "preview" can
   *  never drift out of sync with what addWatch's baseline check / tick()
   *  actually do. Used by rollout_sandbox.js's world_watch adapter to prove
   *  a watch works BEFORE committing to a recurring background schedule. */
  async previewWatch({ kind, target }) {
    if (!['file', 'directory', 'command', 'url', 'mcp_resource'].includes(kind)) {
      return { ok: false, error: `Unknown watch kind "${kind}". Use: file, directory, command, url, mcp_resource.` };
    }
    if (!target) return { ok: false, error: 'target is required.' };
    try {
      const { summary } = await this._snapshotFor({ kind, target });
      return { ok: true, summary: `Check ran clean — ${summary}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async removeWatch(id) {
    const existed = this.watches.delete(id);
    if (existed) await this._save();
    return existed;
  }

  listWatches() {
    return [...this.watches.values()];
  }

  /** Force-check one watch right now, bypassing its own schedule. */
  async checkNow(id) {
    const w = this.watches.get(id);
    if (!w) throw new Error(`No watch with id "${id}".`);
    await this._checkOne(w);
    await this._save();
    return w;
  }

  // ── Scheduler tick ───────────────────────────────────────────────────────

  async tick() {
    const now = Date.now();
    const due = [...this.watches.values()].filter(w =>
      !w.lastCheckedAt || (now - new Date(w.lastCheckedAt).getTime()) >= w.intervalMs
    );
    for (const w of due) {
      await this._checkOne(w).catch(() => { /* _checkOne already records the error on w */ });
    }
    if (due.length) await this._save();

    // Consolidation pass — independent of whether any watch was actually due
    // this tick, on its own much slower cadence (see DEFAULT_CONSOLIDATE_EVERY_MS).
    // Fails open: a consolidation error is logged, never allowed to break the
    // watch-checking loop above, which is the part users actually depend on.
    if (this.onConsolidate && now - this._lastConsolidateAt >= DEFAULT_CONSOLIDATE_EVERY_MS) {
      this._lastConsolidateAt = now;
      try { await this.onConsolidate(); }
      catch (err) { console.error(chalk.gray(`[world_model] consolidation pass failed (non-fatal): ${err.message}`)); }
    }
  }

  async _checkOne(w, { seedOnly = false } = {}) {
    let current;
    try {
      current = await this._snapshotFor(w);
    } catch (err) {
      w.lastError    = err.message;
      w.lastCheckedAt = new Date().toISOString();
      if (!seedOnly && w.snapshot != null) this._recordEvent(w, 'error', `Check failed: ${err.message}`);
      return;
    }

    w.lastError     = null;
    w.lastCheckedAt = new Date().toISOString();
    const prev = w.snapshot;
    w.snapshot = current.snapshot;

    if (!seedOnly && prev != null && prev !== current.snapshot) {
      w.lastChangedAt = w.lastCheckedAt;
      this._recordEvent(w, 'changed', current.summary || 'state changed since last check');
    }
  }

  /** Kind-specific fingerprinting. Returns { snapshot, summary } — snapshot
   *  is a cheap fingerprint used purely to detect drift (hash/mtime/size),
   *  summary is the human-readable line that goes into the event log. */
  async _snapshotFor(w) {
    switch (w.kind) {
      case 'file': {
        const stat = await fs.stat(w.target);
        return {
          snapshot: `${stat.size}:${stat.mtimeMs}`,
          summary:  `file changed (now ${stat.size} bytes, modified ${new Date(stat.mtimeMs).toISOString()})`,
        };
      }
      case 'directory': {
        const entries = await fs.readdir(w.target, { withFileTypes: true });
        const names = entries.map(e => `${e.name}${e.isDirectory() ? '/' : ''}`).sort();
        return {
          snapshot: hashText(names.join('\n')),
          summary:  `directory listing changed (${names.length} entries now)`,
        };
      }
      case 'command': {
        const { stdout, stderr } = await execAsync(w.target, { timeout: 20000, maxBuffer: 1024 * 1024 })
          .catch(err => ({ stdout: err.stdout || '', stderr: (err.stderr || '') + `\n[exit ${err.code}]` }));
        const out = `${stdout || ''}${stderr || ''}`;
        return {
          snapshot: hashText(out),
          summary:  `command output changed:\n${out.trim().slice(0, 300)}`,
        };
      }
      case 'url': {
        const res = await axios.get(w.target, { timeout: 15000, validateStatus: () => true });
        const bodySample = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        return {
          snapshot: hashText(`${res.status}:${(bodySample || '').slice(0, 5000)}`),
          summary:  `HTTP ${res.status} response changed`,
        };
      }
      case 'mcp_resource': {
        if (!this.mcp) throw new Error('No MCP manager available for mcp_resource watches.');
        const [serverName, ...rest] = w.target.split('::');
        const uri  = rest.join('::');
        const text = await this.mcp.readResource(serverName, uri);
        return {
          snapshot: hashText(text),
          summary:  `MCP resource "${uri}" on server "${serverName}" changed`,
        };
      }
      default:
        throw new Error(`Unknown watch kind "${w.kind}".`);
    }
  }

  // ── Drift events ─────────────────────────────────────────────────────────

  _recordEvent(w, type, summary) {
    const event = {
      id: uid('e'), watchId: w.id, label: w.label, kind: w.kind,
      type, summary, timestamp: new Date().toISOString(), seen: false,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENT_LOG) this.events = this.events.slice(-MAX_EVENT_LOG);

    // This is what makes surfacing genuinely proactive rather than just
    // "shown next time you happen to ask": it prints THE MOMENT it's
    // detected, independent of whether a conversation turn is in progress.
    process.stdout.write(
      chalk.cyan(`\n  👁  [world-model] drift detected — ${w.label}: `) +
      chalk.white(summary.split('\n')[0]) + '\n'
    );

    if (typeof this.onDrift === 'function') {
      try { this.onDrift(event); } catch { /* non-critical */ }
    }
  }

  /** Unseen events only — what getContext() surfaces to the model. */
  getContext() {
    if (!this.watches.size) {
      return '(nothing being watched — use world_watch_add to have me monitor a file, directory, command, URL, or MCP resource on a background schedule)';
    }
    const unseen = this.events.filter(e => !e.seen);
    const lines = [`Watching ${this.watches.size} item(s) on independent background schedules.`];
    if (unseen.length) {
      lines.push(`🆕 ${unseen.length} unreported change(s) detected since we last spoke — mention these proactively:`);
      unseen.slice(-10).forEach(e => {
        lines.push(`  - [${e.label}] ${e.summary.split('\n')[0]} (${e.timestamp})`);
      });
    } else {
      lines.push('No changes detected since the last check.');
    }
    return lines.join('\n');
  }

  /** Call once per completed user turn — NOT once per getContext() call,
   *  since _buildSystemPrompt() (which calls getContext()) can legitimately
   *  run more than once inside a single agent.run() (see reasoning's
   *  decompose() pre-call in agent.js). Marking seen here, once, after the
   *  turn's replies have actually been built, guarantees a drift event gets
   *  shown at least once before it ages out of the "🆕 unreported" list. */
  markAllSeen() {
    let changed = false;
    for (const e of this.events) { if (!e.seen) { e.seen = true; changed = true; } }
    if (changed) this._save().catch(() => {});
  }

  getStats() {
    return { watches: this.watches.size, events: this.events.length, unseen: this.events.filter(e => !e.seen).length };
  }

  /** CLI display — mirrors McpManager.list() / TaskManager.print(). */
  print(chalkRef = chalk) {
    console.log(chalkRef.cyan('\n👁  World Model — Watched Items:\n'));
    if (!this.watches.size) {
      console.log(chalkRef.gray('  (nothing watched yet — ask Jojo to watch a file, directory, command, URL, or MCP resource)\n'));
    } else {
      for (const w of this.watches.values()) {
        console.log(
          chalkRef.white(`  · [${w.id}] ${w.label}`) +
          chalkRef.gray(`  (${w.kind}: ${w.target}) — every ${Math.round(w.intervalMs / 1000)}s`) +
          (w.heal?.enabled ? chalkRef.cyan(`  🔧 self-healing → ${w.heal.projectDir}`) : '')
        );
        if (w.lastCheckedAt) {
          console.log(chalkRef.gray(`      last checked: ${w.lastCheckedAt}${w.lastChangedAt ? `, last changed: ${w.lastChangedAt}` : ''}`));
        }
        if (w.lastError) console.log(chalkRef.red(`      ⚠ last error: ${w.lastError}`));
      }
      console.log('');
    }
    const recent = this.events.slice(-5).reverse();
    if (recent.length) {
      console.log(chalkRef.cyan('  Recent events:\n'));
      recent.forEach(e => console.log(chalkRef.gray(`  · [${e.timestamp}] ${e.type === 'error' ? '⚠' : '🆕'} ${e.label} — ${e.summary.split('\n')[0]}`)));
      console.log('');
    }
  }
}

