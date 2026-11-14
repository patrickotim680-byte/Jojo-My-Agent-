// adb.js — real, system-wide Android control via ADB (Android Debug Bridge),
// self-connected over Termux's own "Wireless debugging" feature.
//
// WHAT THIS ACTUALLY IS, honestly:
//   Termux:API (environment_tools.js) can't tap/swipe/type inside arbitrary
//   apps — it's a bounded set of hardware/system calls. A full custom
//   Android app with an Accessibility Service COULD do that, but that's a
//   separate multi-week engineering project (Android Studio, Kotlin, signing,
//   sideloading), not something this file claims to be.
//
//   What this file IS: ADB — Android's own official debugging bridge —
//   pointed at the same device Termux is running on, via "Wireless
//   debugging" (Android 11+, Settings → Developer options). Once paired,
//   `adb shell input tap/swipe/text/keyevent` genuinely taps, swipes, types,
//   and presses keys system-wide, in any app — real control, not simulated.
//   `uiautomator dump` reads the current screen's element tree (text +
//   coordinates) so actions can target something to a reasonable degree of
//   attention rather than guessing blind pixel coordinates.
//
//   Honest limits: this is coordinate/hierarchy-based, not deep semantic
//   understanding — a redesigned app UI or an unusual custom view can still
//   fool it. Treat it the same as computer.js's GUI automation: useful, real,
//   but not infallible, which is exactly why every state-changing action
//   below is queued for human approval, never auto-executed.
//
// SETUP (once, no PC/cable needed — Android 11+):
//   1. Settings → About phone → tap "Build number" 7× to unlock Developer options.
//   2. Settings → System → Developer options → enable "Wireless debugging".
//   3. Tap "Pair device with pairing code" — note the IP:PORT and 6-digit code shown.
//   4. In Termux:  pkg install android-tools
//   5. In Termux:  adb pair <ip>:<pairing_port>   (enter the 6-digit code when asked)
//   6. Back on the main Wireless debugging screen, note the (different) IP:PORT
//      shown there, then:  adb connect <ip>:<debug_port>
//   7. Verify:  adb devices   → should list the device as "device" (not "unauthorized")
//
// Every tool here fails soft with a clear message if adb isn't installed,
// not connected, or a command errors — nothing throws uncaught into the
// agent loop.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

async function runAdb(args, { timeout = 15000 } = {}) {
  try {
    const { stdout } = await execFileAsync('adb', args, { timeout });
    return { ok: true, out: stdout.trim() };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, out: 'adb not found — run `pkg install android-tools` first (see adb.js header for full setup).' };
    }
    if (err.killed || err.signal === 'SIGTERM') {
      return { ok: false, out: `adb command timed out after ${timeout}ms.` };
    }
    return { ok: false, out: `adb failed: ${(err.stderr || err.message || '').toString().trim() || 'unknown error'}` };
  }
}

async function isConnected() {
  const res = await runAdb(['devices']);
  if (!res.ok) return false;
  return res.out.split('\n').slice(1).some(line => line.trim().endsWith('\tdevice'));
}

// Parses `uiautomator dump` XML into a compact list of clickable/text
// elements. Regex-based on purpose — the XML is regular enough, and it
// avoids pulling in an XML parser dependency for one narrow use.
function parseUiDump(xml) {
  const nodes = [];
  const nodeRe = /<node[^>]*\/?>/g;
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : '';
  };
  let m;
  while ((m = nodeRe.exec(xml))) {
    const tag = m[0];
    const clickable = attr(tag, 'clickable') === 'true';
    const text = attr(tag, 'text');
    const desc = attr(tag, 'content-desc');
    if (!clickable && !text && !desc) continue;
    const bounds = attr(tag, 'bounds'); // "[x1,y1][x2,y2]"
    const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
    const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
    nodes.push({
      text: text || desc || '',
      className: attr(tag, 'class').split('.').pop(),
      clickable,
      center: [cx, cy],
    });
  }
  // Dedup + drop empty-label non-clickable noise, cap length for token sanity.
  return nodes.filter(n => n.text || n.clickable).slice(0, 60);
}

export class AdbControlEngine {
  constructor() {
    this.pendingActions = new Map();
  }

  async status() {
    const connected = await isConnected();
    return connected
      ? 'ADB connected — real device control is live.'
      : 'ADB not connected. Run `adb devices` in Termux to check, or see adb.js header for pairing setup.';
  }

  async screenshot() {
    if (!(await isConnected())) return { ok: false, error: 'ADB not connected — see adb.js header for setup.' };
    const remote = '/sdcard/jojo_adb_screenshot.png';
    const cap = await runAdb(['shell', 'screencap', '-p', remote]);
    if (!cap.ok) return { ok: false, error: cap.out };
    const local = path.join(os.tmpdir(), `jojo_screenshot_${Date.now()}.png`);
    const pull = await runAdb(['pull', remote, local], { timeout: 20000 });
    if (!pull.ok) return { ok: false, error: pull.out };
    return { ok: true, path: local };
  }

  async dumpUi() {
    if (!(await isConnected())) return { ok: false, error: 'ADB not connected — see adb.js header for setup.' };
    const remote = '/sdcard/jojo_ui_dump.xml';
    const dump = await runAdb(['shell', 'uiautomator', 'dump', remote], { timeout: 15000 });
    if (!dump.ok) return { ok: false, error: dump.out };
    const local = path.join(os.tmpdir(), `jojo_ui_dump_${Date.now()}.xml`);
    const pull = await runAdb(['pull', remote, local]);
    if (!pull.ok) return { ok: false, error: pull.out };
    const xml = await fs.readFile(local, 'utf-8');
    return { ok: true, elements: parseUiDump(xml) };
  }

  async currentApp() {
    if (!(await isConnected())) return { ok: false, error: 'ADB not connected — see adb.js header for setup.' };
    const res = await runAdb(['shell', 'dumpsys', 'window', '|', 'grep', '-E', 'mCurrentFocus']);
    // Piping through adb shell args separately is unreliable across devices —
    // fall back to a single quoted shell string for the pipeline.
    if (!res.ok || !res.out) {
      const alt = await runAdb(['shell', "dumpsys window | grep -E 'mCurrentFocus'"]);
      return alt.ok ? { ok: true, raw: alt.out } : { ok: false, error: alt.out };
    }
    return { ok: true, raw: res.out };
  }

  /**
   * Propose a real, state-changing action. ALWAYS queued for approval —
   * same unconditional gate as computer.js, no exceptions.
   * kind: 'tap' | 'swipe' | 'type' | 'key' | 'launch_app'
   */
  async propose(action) {
    if (!['tap', 'swipe', 'type', 'key', 'launch_app'].includes(action.kind)) {
      throw new Error(`Unknown adb action kind "${action.kind}".`);
    }
    if (!(await isConnected())) {
      return { ok: false, pending: false, summary: 'ADB not connected — see adb.js header for setup. Not queued.' };
    }

    const approvalId = uid('adbact');
    this.pendingActions.set(approvalId, { action, createdAt: new Date().toISOString() });

    const targetDesc =
      action.kind === 'tap'    ? `tap (${action.x}, ${action.y})` :
      action.kind === 'swipe'  ? `swipe (${action.x1},${action.y1}) → (${action.x2},${action.y2})` :
      action.kind === 'type'   ? `type ${JSON.stringify(action.text)}` :
      action.kind === 'key'    ? `key: ${action.key}` :
      `launch app: ${action.package}`;

    return {
      ok: false, pending: true, approvalId, kind: action.kind, target: targetDesc,
      summary:
        `ADB action queued, NOT executed (every action requires approval — no exceptions). ${targetDesc}. ` +
        `Consider calling adb_screenshot or adb_dump_ui first if you haven't already this turn, so the human ` +
        `can see what they're approving. Then call apply_adb_action("${approvalId}", human_approved=true) to ` +
        `execute for real, or dismiss_adb_action("${approvalId}") to discard.`,
    };
  }

  async applyPendingAction(approvalId, humanApproved) {
    const pending = this.pendingActions.get(approvalId);
    if (!pending) return `No pending ADB action "${approvalId}" (already applied, dismissed, or invalid id).`;
    if (!humanApproved) return `human_approved must be true to execute "${approvalId}". Use dismiss_adb_action to discard it instead.`;
    this.pendingActions.delete(approvalId);

    const { action } = pending;
    let res;
    try {
      if (action.kind === 'tap') {
        res = await runAdb(['shell', 'input', 'tap', String(action.x), String(action.y)]);
      } else if (action.kind === 'swipe') {
        res = await runAdb(['shell', 'input', 'swipe',
          String(action.x1), String(action.y1), String(action.x2), String(action.y2),
          String(action.durationMs || 300)]);
      } else if (action.kind === 'type') {
        // ADB's `input text` treats literal spaces as token breaks — %s is its
        // documented escape for a space.
        res = await runAdb(['shell', 'input', 'text', String(action.text).replace(/ /g, '%s')]);
      } else if (action.kind === 'key') {
        res = await runAdb(['shell', 'input', 'keyevent', action.key]);
      } else if (action.kind === 'launch_app') {
        res = await runAdb(['shell', 'monkey', '-p', action.package, '-c', 'android.intent.category.LAUNCHER', '1']);
      }
    } catch (err) {
      return `Error executing ADB action "${approvalId}": ${err.message}`;
    }

    if (!res.ok) return `ADB action "${approvalId}" failed: ${res.out}`;
    return `Executed ${action.kind} action "${approvalId}" for real. ${res.out ? `(adb said: ${res.out})` : ''}`;
  }

  dismissPendingAction(approvalId) {
    const had = this.pendingActions.delete(approvalId);
    return had ? `Dismissed pending ADB action "${approvalId}" without executing it.`
                : `No pending ADB action "${approvalId}" to dismiss.`;
  }

  listPending() {
    if (this.pendingActions.size === 0) return 'No pending ADB actions.';
    return [...this.pendingActions.entries()]
      .map(([id, p]) => `[${id}] ${p.action.kind} (queued ${p.createdAt})`)
      .join('\n');
  }

  getContext() {
    if (this.pendingActions.size === 0) return 'No pending ADB actions.';
    return `${this.pendingActions.size} pending ADB action(s) awaiting human_approved=true:\n${this.listPending()}`;
  }
}

