// ── Continuity Daemon ─────────────────────────────────────────────────────────
//
// Feature: cross-device continuity (daemon + push).
//
// Every other background piece in this codebase (world_model.js, healer.js,
// distillation.js…) assumes exactly one long-running Node process on exactly
// one machine. That's fine until you close the laptop lid mid-task and open
// JOJO on a desktop an hour later — the task board, world-model watches, and
// any fix/rollout/deploy plan sitting in "awaiting approval" are all still
// only on the laptop, and nothing tells you that from anywhere else.
//
// This module adds two small, honest things on top of that single-machine
// reality instead of pretending to replace it:
//
//   1. PRESENCE — a lightweight per-device heartbeat + "who's active right
//      now" registry (registerDevice/tick), so a second device starting up
//      can see "the laptop was active 40s ago" instead of silently racing
//      it, and a person can explicitly hand off ("I'm switching to my
//      desktop now" → continuity_handoff).
//   2. PUSH — when something needs a human and nobody's device has
//      heartbeated recently (i.e. you've actually stepped away), send a
//      notification out: a generic webhook (ntfy.sh, Pushover, a Slack/
//      Discord incoming webhook, your own endpoint — anything that accepts
//      a POST), and/or the existing WhatsApp channel if it's connected
//      (see whatsapp_client.js). Always narrated to the local terminal too,
//      so this never depends on external config to be useful.
//
// HONEST LIMITS (read this before assuming more than it does):
//   - This is NOT a sync engine. JOJO's other state (memory/persistent.json,
//     world_model.json, the skill ledger, etc.) stays exactly where it's
//     always been: local to whichever machine is running the process. This
//     module does not copy any of that between machines.
//   - The ONE file this module writes, memory/continuity_state.json (or
//     wherever JOJO_CONTINUITY_STATE_FILE points), is the only thing meant
//     to be visible cross-device — and only if YOU put it somewhere shared
//     (a Dropbox/Syncthing/git-synced folder) via that env var. Point it at
//     a local-only path and this degrades gracefully to a single-device
//     presence log — still useful (push still works), just not "cross-
//     device" in the literal sense.
//   - memory/device_id.json (the per-machine identity) is deliberately
//     ALWAYS local and separate from the state file above, specifically so
//     two devices don't collide on one id. If you sync the whole memory/
//     directory (rather than pointing JOJO_CONTINUITY_STATE_FILE at just
//     the one shared file) you WILL cause that collision — don't do that;
//     keep device_id.json out of whatever sync you use.
//   - "Handoff" is advisory, not a lock. Nothing here stops a second device
//     from also running background schedulers (world model ticks, healer,
//     etc.) against locally-synced files at the same time — it surfaces
//     that risk (staleDevicesOverlap in getContext()) rather than silently
//     hiding it, but it can't prevent a real race any more than any other
//     file in memory/ can (see world_model.js's own note on this).
//   - Push is best-effort and non-fatal by design: a broken webhook URL or
//     a disconnected WhatsApp client never throws — it's logged and the
//     turn continues. This is a notify layer, not a guaranteed-delivery one.

import fs             from 'fs/promises';
import os             from 'os';
import crypto         from 'crypto';
import chalk          from 'chalk';
import axios           from 'axios';

const STATE_FILE     = process.env.JOJO_CONTINUITY_STATE_FILE || './memory/continuity_state.json';
const DEVICE_ID_FILE = './memory/device_id.json'; // deliberately NOT configurable — see header

const DEFAULT_TICK_MS      = parseInt(process.env.JOJO_CONTINUITY_TICK_MS           || '30000');  // 30s heartbeat
const STALE_MS              = parseInt(process.env.JOJO_CONTINUITY_STALE_MS          || '180000'); // 3min — "someone's actively watching"
const OFFLINE_MS            = STALE_MS * 4;                                                        // beyond this, a device is shown as offline rather than just idle
const PUSH_DEBOUNCE_MS      = parseInt(process.env.JOJO_CONTINUITY_PUSH_DEBOUNCE_MS  || '900000');  // 15min — don't re-push the same pending source more often than this
const MAX_PUSH_LOG          = 30;

const PENDING_SOURCES = [
  // [key shown in summaries, human label, context field, method to call]
  ['healer',   'self-healing fixes',      'healer',      'listPending'],
  ['rollout',  'rollout decisions',       'rollout',     'listPending'],
  ['deploy',   'deployment plans',        'deploy',      'listPending'],
  ['n8n',      'n8n workflow approvals',  'n8n',         'listPending'],
  ['computer', 'computer-use actions',    'computerUse', 'listPending'],
  ['browser',  'browser actions',         'browser',     'listPendingActions'],
];

function uid() {
  return crypto.randomBytes(4).toString('hex');
}

function agoLabel(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export class ContinuityDaemon {
  /** @param {object} opts.label - optional human label for this device (defaults to hostname) */
  constructor({ label } = {}) {
    this.label     = label || process.env.JOJO_DEVICE_LABEL || os.hostname() || 'unknown-device';
    this.deviceId  = null; // set in init()
    this.startedAt = new Date().toISOString();
    this.state     = { devices: {}, handoff: null, notified: {}, pushLog: [] };
    this._timer    = null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    await fs.mkdir('./memory', { recursive: true }).catch(() => {});
    this.deviceId = await this._loadOrCreateDeviceId();
    await this._load();
    // Announce presence immediately (don't wait for the first tick) so a
    // second device checking `devices` a second after startup sees us.
    this._heartbeat({});
    await this._save();
  }

  /** Independent background scheduler — same unref() pattern as world_model.js
   *  so this alone never keeps the process alive.
   *  @param {() => object} getContext - called fresh on every tick to get the
   *    current tool-context (agent.js passes () => this._toolContext()) so
   *    the daemon always scans live pending-approval sources, not a stale
   *    snapshot from startup. Omit for a context-free presence-only daemon
   *    (heartbeat + handoff still work; pending-source scanning/push won't
   *    see anything). */
  start(getContext = () => ({}), tickMs = DEFAULT_TICK_MS) {
    if (this._timer) return;
    this._getContext = getContext;
    this._timer = setInterval(() => { this.tick(this._getContext()).catch(() => {}); }, tickMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async _loadOrCreateDeviceId() {
    try {
      const raw = await fs.readFile(DEVICE_ID_FILE, 'utf-8');
      const { id } = JSON.parse(raw);
      if (id) return id;
    } catch { /* first run on this machine */ }
    const id = `dev_${uid()}`;
    await fs.writeFile(DEVICE_ID_FILE, JSON.stringify({ id, createdAt: new Date().toISOString(), hostname: os.hostname() }, null, 2)).catch(() => {});
    return id;
  }

  async _load() {
    try {
      const raw = await fs.readFile(STATE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      this.state = {
        devices:  data.devices  || {},
        handoff:  data.handoff  || null,
        notified: data.notified || {},
        pushLog:  data.pushLog  || [],
      };
    } catch {
      // first run, or the shared file doesn't exist at this path yet
    }
  }

  async _save() {
    await fs.mkdir('./memory', { recursive: true }).catch(() => {});
    await fs.writeFile(STATE_FILE, JSON.stringify(this.state, null, 2));
  }

  // ── Presence ─────────────────────────────────────────────────────────────

  _heartbeat({ tasks }) {
    let activeTaskId = null, activeTaskTitle = null;
    try {
      activeTaskId = tasks?.memory?.data?.active_task_id || null;
      if (activeTaskId) activeTaskTitle = tasks?.memory?.data?.tasks?.[activeTaskId]?.title || null;
    } catch { /* best-effort — never let a task-board read shape change break heartbeat */ }

    this.state.devices[this.deviceId] = {
      label: this.label,
      lastSeenAt: new Date().toISOString(),
      startedAt: this.startedAt,
      pid: process.pid,
      activeTaskId,
      activeTaskTitle,
      locationTag: this.locationTag || null, // e.g. "bedroom", "office" — see setLocationTag()
    };
  }

  /** Human-named, not auto-detected. Deliberately not inferred from wifi
   *  SSID / Bluetooth / audio level: those signals are all real, but
   *  "detected" location is a guess dressed up as fact, and a wrong guess
   *  here is exactly the kind of thing that erodes trust in this whole
   *  system. Ask once, remember it — same posture as continuity_handoff
   *  being explicit rather than automatic. */
  setLocationTag(label) {
    this.locationTag = label || null;
  }

  /** Other devices whose last heartbeat is fresher than STALE_MS — i.e.
   *  plausibly someone's actually looking at that screen right now. */
  _recentlyActiveElsewhere() {
    const now = Date.now();
    return Object.entries(this.state.devices)
      .filter(([id, d]) => id !== this.deviceId && (now - new Date(d.lastSeenAt).getTime()) < STALE_MS)
      .map(([id, d]) => ({ id, ...d }));
  }

  listDevices() {
    const now = Date.now();
    return Object.entries(this.state.devices).map(([id, d]) => {
      const ms = now - new Date(d.lastSeenAt).getTime();
      return {
        id, ...d, self: id === this.deviceId,
        status: ms < STALE_MS ? 'active' : ms < OFFLINE_MS ? 'idle' : 'offline',
      };
    }).sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  }

  /** Advisory only — see HONEST LIMITS in the file header. */
  async handoff(context, { toSelf = true, label } = {}) {
    if (label) this.label = label;
    this._heartbeat(context);
    this.state.handoff = { deviceId: this.deviceId, label: this.label, since: new Date().toISOString() };
    await this._save();
    return `This device ("${this.label}") is now marked as the active one. ` +
      `Other devices reading the shared state file will see this on their next check.`;
  }

  // ── Scheduler tick ───────────────────────────────────────────────────────

  /** @param {object} context - the same tool-context shape agent.js builds
   *  (see JojoAgent._toolContext) — used defensively, every field optional. */
  async tick(context = {}) {
    await this._load();               // pick up any other device's writes since our last read
    this._heartbeat(context);         // then lay our own heartbeat on top
    const pending = await this._scanPending(context);
    await this._maybePush(pending, context);
    await this._save();
    return pending;
  }

  async _scanPending(context) {
    const bySource = {};
    for (const [key, , field, method] of PENDING_SOURCES) {
      try {
        const mod = context[field];
        if (!mod || typeof mod[method] !== 'function') { bySource[key] = null; continue; }
        const list = mod[method]();
        bySource[key] = Array.isArray(list) ? list.length : (list && list !== 'string' ? 1 : 0);
      } catch { bySource[key] = null; }
    }
    let worldModelUnseen = null;
    try {
      worldModelUnseen = context.worldModel ? context.worldModel.events.filter(e => !e.seen).length : null;
    } catch { worldModelUnseen = null; }
    const total = Object.values(bySource).reduce((s, n) => s + (n || 0), 0) + (worldModelUnseen || 0);
    return { bySource, worldModelUnseen, total };
  }

  async _maybePush(pending, context) {
    // Only push when nobody's device has been seen recently — that's the
    // whole point: don't notify a phone when you're sitting right there.
    if (this._recentlyActiveElsewhere().length) return;

    const items = [
      ...PENDING_SOURCES
        .filter(([key]) => pending.bySource[key])
        .map(([key, label]) => ({ key, text: `${pending.bySource[key]} ${label} awaiting your approval` })),
      ...(pending.worldModelUnseen ? [{ key: 'world_model', text: `${pending.worldModelUnseen} background watch event(s) detected` }] : []),
    ];
    if (!items.length) return;

    const now = Date.now();
    const due = items.filter(({ key, text }) => {
      const prior = this.state.notified[key];
      if (!prior) return true;
      if (prior.lastText !== text) return true; // count changed since we last pushed — worth re-notifying
      return (now - new Date(prior.lastPushedAt).getTime()) > PUSH_DEBOUNCE_MS;
    });
    if (!due.length) return;

    const message = `JOJO (${this.label}) — ${due.map(d => d.text).join('; ')}. ` +
      `Nobody's been active on any device for ${Math.round(STALE_MS / 60000)}+ min.`;
    await this.push(message, context);
    for (const { key, text } of due) {
      this.state.notified[key] = { lastText: text, lastPushedAt: new Date().toISOString() };
    }
  }

  // ── Push delivery ────────────────────────────────────────────────────────

  /** Best-effort, never throws. Tries every configured channel and reports
   *  what actually went out. Always narrates locally regardless of config,
   *  same as world_model.js's drift narration. */
  async push(message, context = {}) {
    const delivered = [];
    const failed = [];

    process.stdout.write(chalk.magenta(`\n  📡 [continuity] push — `) + chalk.white(message) + '\n');
    delivered.push('terminal');

    const url = process.env.JOJO_CONTINUITY_PUSH_URL;
    if (url) {
      try {
        let headers = { 'Content-Type': 'text/plain; charset=utf-8' };
        if (process.env.JOJO_CONTINUITY_PUSH_HEADERS_JSON) {
          headers = { ...headers, ...JSON.parse(process.env.JOJO_CONTINUITY_PUSH_HEADERS_JSON) };
        }
        await axios.post(url, message, { headers, timeout: 10000 });
        delivered.push('webhook');
      } catch (err) {
        failed.push(`webhook (${err.message})`);
      }
    }

    if (context.whatsapp && context.whatsappAllowedJid) {
      try {
        await context.whatsapp.sendText(context.whatsappAllowedJid, message);
        delivered.push('whatsapp');
      } catch (err) {
        failed.push(`whatsapp (${err.message})`);
      }
    }

    this.state.pushLog.push({ id: uid(), message, delivered, failed, timestamp: new Date().toISOString() });
    if (this.state.pushLog.length > MAX_PUSH_LOG) this.state.pushLog = this.state.pushLog.slice(-MAX_PUSH_LOG);

    return { delivered, failed };
  }

  // ── System-prompt context ───────────────────────────────────────────────────

  getContext() {
    const devices = this.listDevices();
    const others = devices.filter(d => !d.self);
    const lines = [`This device: "${this.label}" (${this.deviceId}).`];
    if (others.length) {
      lines.push(`${others.length} other known device(s):`);
      others.forEach(d => lines.push(`  - "${d.label}" — ${d.status}, last seen ${agoLabel(d.lastSeenAt)}${d.activeTaskTitle ? `, was on task "${d.activeTaskTitle}"` : ''}`));
    } else {
      lines.push('No other devices have checked in yet (single-device so far, or JOJO_CONTINUITY_STATE_FILE isn\'t pointed at a shared location).');
    }
    if (this.state.handoff && this.state.handoff.deviceId !== this.deviceId) {
      lines.push(`Handoff: "${this.state.handoff.label}" explicitly marked itself active ${agoLabel(this.state.handoff.since)} — prefer not to start new long-running work here without checking with the user first.`);
    }
    const lastPush = this.state.pushLog[this.state.pushLog.length - 1];
    if (lastPush) lines.push(`Last push notification: ${agoLabel(lastPush.timestamp)} — "${lastPush.message.slice(0, 100)}" (delivered via: ${lastPush.delivered.join(', ') || 'none'}${lastPush.failed.length ? `, failed: ${lastPush.failed.join(', ')}` : ''}).`);
    return lines.join('\n');
  }

  getStats() {
    return { deviceId: this.deviceId, label: this.label, knownDevices: Object.keys(this.state.devices).length, pushesSent: this.state.pushLog.length };
  }

  /** CLI display — mirrors WorldModel.print() / TaskManager.print(). */
  print(chalkRef = chalk) {
    console.log(chalkRef.cyan('\n📡  Continuity — Known Devices:\n'));
    const devices = this.listDevices();
    devices.forEach(d => {
      const color = d.self ? chalkRef.green : d.status === 'active' ? chalkRef.yellow : d.status === 'idle' ? chalkRef.white : chalkRef.gray;
      console.log(color(`  · ${d.self ? '→ ' : '  '}${d.label}${d.self ? ' (this device)' : ''}`) +
        chalkRef.gray(`  [${d.status}] last seen ${agoLabel(d.lastSeenAt)}${d.activeTaskTitle ? ` — on "${d.activeTaskTitle}"` : ''}`));
    });
    if (this.state.handoff) {
      console.log(chalkRef.cyan(`\n  Handoff: "${this.state.handoff.label}" marked active ${agoLabel(this.state.handoff.since)}.`));
    }
    const url = process.env.JOJO_CONTINUITY_PUSH_URL;
    console.log(chalkRef.gray(`\n  Push webhook: ${url ? url : '(not configured — set JOJO_CONTINUITY_PUSH_URL)'}`));
    console.log(chalkRef.gray(`  Shared state file: ${STATE_FILE}${STATE_FILE === './memory/continuity_state.json' ? ' (local-only unless you set JOJO_CONTINUITY_STATE_FILE to a synced path)' : ''}`));
    const recent = this.state.pushLog.slice(-5).reverse();
    if (recent.length) {
      console.log(chalkRef.cyan('\n  Recent pushes:\n'));
      recent.forEach(p => console.log(chalkRef.gray(`  · [${p.timestamp}] ${p.message.slice(0, 90)} (via ${p.delivered.join(', ') || 'none'})`)));
    }
    console.log('');
  }
}

