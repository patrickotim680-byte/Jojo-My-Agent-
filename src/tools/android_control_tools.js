// android_control_tools.js — real Android-level control via Termux:API + `am`
// (Android's own activity-manager intents), NOT simulated touches.
//
// WHY THIS APPROACH, READ BEFORE EXPECTING SOMETHING ELSE:
//   This is genuinely how Google Assistant / Siri / Bixby do cross-app actions
//   too — structured OS intents ("open this app", "open this URL", "send this
//   text"), not simulated finger-tapping inside whatever app happens to be on
//   screen. Full "tap any button in any app" control needs Android's
//   Accessibility Service plus a real installed Android app (a separate,
//   much bigger project — a terminal script can't grant itself that
//   permission; Android deliberately requires a human to enable it by hand
//   in Settings, specifically to stop exactly this kind of silent unattended
//   automation). What's below is real, unsimulated device control, just
//   bounded to actions the OS exposes as intents rather than raw taps.
//
// SAFETY: opening an app/URL or adjusting volume only affects this device and
// is trivially reversible, so those fire immediately. Sending an SMS or
// placing a call reaches another real person and costs real money/attention
// — those go through the same propose → human-confirms pattern as
// computer.js's OS-level actions, rather than firing autonomously.
//
// SETUP: same as environment_tools.js — `pkg install termux-api` + the
// Termux:API app (same install source as Termux itself).

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function run(cmd, args = [], { timeout = 10000 } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout });
    return stdout.trim() || '(done)';
  } catch (err) {
    if (err.code === 'ENOENT') {
      return `${cmd} not found — this needs Termux:API installed ` +
        `(\`pkg install termux-api\` + the Termux:API app, same source as Termux itself).`;
    }
    if (err.killed) return `${cmd} timed out after ${timeout}ms.`;
    return `${cmd} failed: ${(err.stderr || err.message || '').toString().trim() || 'unknown error'}`;
  }
}

// Small, deliberately non-exhaustive lookup for common apps by friendly name.
// Unknown names fall through to "tell the user the exact package is needed" —
// better an honest miss than a wrong guess launching the wrong app.
const APP_PACKAGES = {
  whatsapp: 'com.whatsapp',
  chrome: 'com.android.chrome',
  camera: 'com.android.camera',
  settings: 'com.android.settings',
  gmail: 'com.google.android.gm',
  maps: 'com.google.android.apps.maps',
  youtube: 'com.google.android.youtube',
  spotify: 'com.spotify.music',
  phone: 'com.android.dialer',
  messages: 'com.google.android.apps.messaging',
  playstore: 'com.android.vending',
  instagram: 'com.instagram.android',
  facebook: 'com.facebook.katana',
  twitter: 'com.twitter.android',
  x: 'com.twitter.android',
  tiktok: 'com.zhiliaoapp.musically',
  telegram: 'org.telegram.messenger',
  gallery: 'com.google.android.apps.photos',
  calculator: 'com.google.android.calculator',
  calendar: 'com.google.android.calendar',
};

// In-memory pending-approval queue, same shape/spirit as computer.js's, kept
// local and small since only two action kinds ever land here.
const pendingActions = new Map();
let nextId = 1;

function proposeConsequentialAction(kind, payload, describe) {
  const approvalId = `android-${kind}-${nextId++}`;
  pendingActions.set(approvalId, { kind, payload });
  return `⏸ Proposed (not yet sent): ${describe}\n` +
    `Call confirm_android_action("${approvalId}", confirm=true) to actually send it, ` +
    `or confirm=false to discard.`;
}

export const ANDROID_CONTROL_TOOLS = [
  {
    name: 'open_app',
    declaration: {
      name: 'open_app',
      description:
        'Launch an app on the real device by common name (e.g. "whatsapp", "camera", "spotify") ' +
        'or an exact Android package name if you know it. Real intent-based launch, opens immediately ' +
        '(no confirmation needed — just switches what app is in front, nothing sent anywhere).',
      parameters: {
        type: 'object',
        properties: { app: { type: 'string', description: 'Friendly app name or exact package name' } },
        required: ['app'],
      },
    },
    async execute({ app }) {
      const key = app.toLowerCase().replace(/[^a-z]/g, '');
      const pkg = APP_PACKAGES[key] || (app.includes('.') ? app : null);
      if (!pkg) {
        return `Don't have "${app}" in the built-in name list, and it doesn't look like a package name ` +
          `(e.g. "com.spotify.music"). Known names: ${Object.keys(APP_PACKAGES).join(', ')}.`;
      }
      const res = await run('am', ['start', '-a', 'android.intent.action.MAIN',
        '-c', 'android.intent.category.LAUNCHER', '-p', pkg]);
      return res.includes('not found') || res.includes('failed') || res.includes('timed out')
        ? res
        : `Opened ${app} (${pkg}).`;
    },
  },

  {
    name: 'open_url',
    declaration: {
      name: 'open_url',
      description: 'Open a URL in the device\'s default browser right now.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full URL, including https://' } },
        required: ['url'],
      },
    },
    async execute({ url }) {
      const res = await run('termux-open-url', [url]);
      return res === '(done)' ? `Opened ${url}` : res;
    },
  },

  {
    name: 'share_content',
    declaration: {
      name: 'share_content',
      description:
        'Open the real Android share sheet with given text (or a file path) — lets the user pick which ' +
        'app to send it to. Does NOT send anything by itself; the human picks the destination.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Text to share, or an absolute file path' },
        },
        required: ['content'],
      },
    },
    async execute({ content }) {
      const res = await run('termux-share', [content]);
      return res === '(done)' ? 'Share sheet opened.' : res;
    },
  },

  {
    name: 'set_volume',
    declaration: {
      name: 'set_volume',
      description: 'Set a real device volume stream (music, ring, notification, alarm, call) to a level.',
      parameters: {
        type: 'object',
        properties: {
          stream: { type: 'string', description: "'music' | 'ring' | 'notification' | 'alarm' | 'call'" },
          level: { type: 'number', description: 'Volume level (device-dependent max, usually 0-15 or 0-7)' },
        },
        required: ['stream', 'level'],
      },
    },
    async execute({ stream, level }) {
      const res = await run('termux-volume', [stream, String(level)]);
      return res === '(done)' ? `${stream} volume set to ${level}.` : res;
    },
  },

  {
    name: 'set_wifi_enabled',
    declaration: {
      name: 'set_wifi_enabled',
      description: 'Turn the real device wifi on or off.',
      parameters: {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
        required: ['enabled'],
      },
    },
    async execute({ enabled }) {
      const res = await run('termux-wifi-enable', [enabled ? 'true' : 'false']);
      return res === '(done)' ? `Wifi turned ${enabled ? 'on' : 'off'}.` : res;
    },
  },

  {
    name: 'send_sms',
    declaration: {
      name: 'send_sms',
      description:
        'Propose sending a real SMS from this device to a real phone number. Reaches an actual person ' +
        'and may cost money — this only QUEUES the message; nothing is sent until the human calls ' +
        'confirm_android_action with confirm=true. Never call the confirm step yourself speculatively.',
      parameters: {
        type: 'object',
        properties: {
          number: { type: 'string', description: 'Recipient phone number' },
          message: { type: 'string', description: 'Message text' },
        },
        required: ['number', 'message'],
      },
    },
    async execute({ number, message }) {
      return proposeConsequentialAction('sms', { number, message },
        `send SMS to ${number}: "${message}"`);
    },
  },

  {
    name: 'make_call',
    declaration: {
      name: 'make_call',
      description:
        'Propose placing a real phone call from this device. Only QUEUES it — nothing is dialed until ' +
        'the human calls confirm_android_action with confirm=true.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'string', description: 'Number to call' } },
        required: ['number'],
      },
    },
    async execute({ number }) {
      return proposeConsequentialAction('call', { number }, `call ${number}`);
    },
  },

  {
    name: 'confirm_android_action',
    declaration: {
      name: 'confirm_android_action',
      description:
        'Execute or discard a pending send_sms / make_call action. Requires the human to have actually ' +
        'said yes in this conversation — never call with confirm=true speculatively or on the agent\'s ' +
        'own judgement.',
      parameters: {
        type: 'object',
        properties: {
          approval_id: { type: 'string' },
          confirm: { type: 'boolean', description: 'true to actually execute, false to discard' },
        },
        required: ['approval_id', 'confirm'],
      },
    },
    async execute({ approval_id, confirm }) {
      const pending = pendingActions.get(approval_id);
      if (!pending) return `No pending action "${approval_id}" (already handled or invalid id).`;
      pendingActions.delete(approval_id);
      if (!confirm) return `Discarded "${approval_id}" — nothing sent.`;

      if (pending.kind === 'sms') {
        const { number, message } = pending.payload;
        const res = await run('termux-sms-send', ['-n', number, message], { timeout: 15000 });
        return res === '(done)' ? `SMS sent to ${number}.` : res;
      }
      if (pending.kind === 'call') {
        const res = await run('termux-telephony-call', [pending.payload.number]);
        return res === '(done)' ? `Calling ${pending.payload.number}…` : res;
      }
      return `Unknown pending action kind "${pending.kind}".`;
    },
  },
];

