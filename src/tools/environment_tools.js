// environment_tools.js — real Android environment awareness + device actions,
// via Termux:API (https://wiki.termux.com/wiki/Termux:API).
//
// WHAT THIS ACTUALLY IS — read before expecting a JARVIS that can tap
// buttons in any app on the phone:
//   Termux:API is Android's own sanctioned bridge from a terminal into a
//   bounded set of hardware/system features — battery, GPS, sensors, torch,
//   vibration, clipboard, notifications, camera, TTS, wifi/telephony info.
//   Every call here shells out to one of those commands. There is NO general
//   "control any app" capability in this file — that would require Android's
//   Accessibility Service and a real installed Android app (a much bigger,
//   riskier, separate project), not something a Termux script can do.
//   What you get here is real and useful (JOJO can sense its physical
//   surroundings and act on the device itself), just bounded to what
//   Termux:API exposes.
//
// SETUP (once):
//   1. Install the "Termux:API" app from the SAME source as Termux itself
//      (both F-Droid, or both Play Store — mixing sources breaks the bridge).
//   2. Inside Termux:  pkg install termux-api
//   3. The first time each command type runs, Android will pop a permission
//      dialog (location, camera, etc.) — accept it once, it's remembered.
//
// Every tool below fails soft with a clear message if Termux:API isn't
// installed or a permission hasn't been granted yet — nothing here throws
// an uncaught error into the agent loop.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

async function runTermuxApi(cmd, args = [], { timeout = 10000, parseJSON = false } = {}) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout });
    const out = stdout.trim();
    if (!parseJSON) return out || '(no output)';
    try {
      return JSON.parse(out);
    } catch {
      return out; // some termux-api commands return plain text, not JSON
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      return `${cmd} not found — Termux:API isn't installed. Run \`pkg install termux-api\` ` +
        `and make sure the Termux:API app (same install source as Termux itself) is installed too.`;
    }
    if (err.killed || err.signal === 'SIGTERM') {
      return `${cmd} timed out after ${timeout}ms — this usually means the matching Android ` +
        `permission hasn't been granted yet (check for a pending dialog / notification) or the ` +
        `relevant hardware (e.g. GPS) can't get a fix right now.`;
    }
    return `${cmd} failed: ${(err.stderr || err.message || '').toString().trim() || 'unknown error'}`;
  }
}

async function runShell(cmd, args = [], timeout = 5000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout });
    return stdout.trim();
  } catch {
    return null; // caller decides how to degrade — missing ONE field shouldn't blank the whole report
  }
}

export const ENVIRONMENT_TOOLS = [
  {
    name: 'get_location',
    declaration: {
      name: 'get_location',
      description:
        'Get the device\'s real current GPS/network location (latitude, longitude, accuracy, provider). ' +
        'Requires Termux:API and the location permission granted once. Can take several seconds for a GPS fix.',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: "'gps' | 'network' | 'passive' — default 'network' (faster, less precise)" },
        },
      },
    },
    async execute({ provider = 'network' } = {}) {
      return runTermuxApi('termux-location', ['-p', provider, '-r', 'once'], { timeout: 20000, parseJSON: true });
    },
  },

  {
    name: 'get_battery_status',
    declaration: {
      name: 'get_battery_status',
      description: 'Get real device battery level, charge state (charging/discharging/full), health, and temperature.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return runTermuxApi('termux-battery-status', [], { parseJSON: true });
    },
  },

  {
    name: 'get_wifi_info',
    declaration: {
      name: 'get_wifi_info',
      description: 'Get real current wifi connection info (SSID, signal strength, link speed, IP) if connected.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return runTermuxApi('termux-wifi-connectioninfo', [], { parseJSON: true });
    },
  },

  {
    name: 'get_device_info',
    declaration: {
      name: 'get_device_info',
      description: 'Get real device/telephony info: manufacturer, model, Android version, network type, SIM state, etc.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return runTermuxApi('termux-telephony-deviceinfo', [], { parseJSON: true });
    },
  },

  {
    name: 'get_sensor_reading',
    declaration: {
      name: 'get_sensor_reading',
      description:
        'Read a real hardware sensor once (e.g. "light" for ambient brightness, "accelerometer" for motion/orientation, ' +
        '"proximity" for something near the screen). Use get_sensor_list first if unsure of exact sensor names on this device.',
      parameters: {
        type: 'object',
        properties: {
          sensor: { type: 'string', description: 'Partial sensor name, e.g. "light", "accelerometer", "proximity", "gyroscope"' },
        },
        required: ['sensor'],
      },
    },
    async execute({ sensor }) {
      return runTermuxApi('termux-sensor', ['-s', sensor, '-n', '1'], { timeout: 8000, parseJSON: true });
    },
  },

  {
    name: 'get_sensor_list',
    declaration: {
      name: 'get_sensor_list',
      description: 'List every hardware sensor actually available on this specific device, by exact name.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return runTermuxApi('termux-sensor', ['-l'], { parseJSON: true });
    },
  },

  {
    name: 'set_torch',
    declaration: {
      name: 'set_torch',
      description: 'Turn the real device flashlight/torch on or off.',
      parameters: {
        type: 'object',
        properties: { state: { type: 'string', description: "'on' or 'off'" } },
        required: ['state'],
      },
    },
    async execute({ state }) {
      if (!['on', 'off'].includes(state)) return `Invalid state "${state}" — must be "on" or "off".`;
      const res = await runTermuxApi('termux-torch', [state]);
      return res === '(no output)' ? `Torch turned ${state}.` : res;
    },
  },

  {
    name: 'vibrate_device',
    declaration: {
      name: 'vibrate_device',
      description: 'Vibrate the physical device — useful as a real, felt confirmation/alert.',
      parameters: {
        type: 'object',
        properties: { duration_ms: { type: 'number', description: 'Duration in milliseconds, default 1000' } },
      },
    },
    async execute({ duration_ms = 1000 } = {}) {
      const res = await runTermuxApi('termux-vibrate', ['-d', String(duration_ms)]);
      return res === '(no output)' ? `Vibrated for ${duration_ms}ms.` : res;
    },
  },

  {
    name: 'send_device_notification',
    declaration: {
      name: 'send_device_notification',
      description: 'Post a real Android notification on this device — visible even if JOJO is backgrounded.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          content: { type: 'string', description: 'Notification body text' },
        },
        required: ['title', 'content'],
      },
    },
    async execute({ title, content }) {
      const res = await runTermuxApi('termux-notification', ['--title', title, '--content', content]);
      return res === '(no output)' ? 'Notification sent.' : res;
    },
  },

  {
    name: 'get_clipboard',
    declaration: {
      name: 'get_clipboard',
      description: "Read the device's real current system clipboard text.",
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return runTermuxApi('termux-clipboard-get');
    },
  },

  {
    name: 'set_clipboard',
    declaration: {
      name: 'set_clipboard',
      description: "Set the device's real system clipboard to given text — e.g. so the user can paste it somewhere.",
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to place on the clipboard' } },
        required: ['text'],
      },
    },
    async execute({ text }) {
      const res = await runTermuxApi('termux-clipboard-set', [text]);
      return res === '(no output)' ? 'Clipboard set.' : res;
    },
  },

  {
    name: 'take_device_photo',
    declaration: {
      name: 'take_device_photo',
      description:
        'Take a real photo with the device camera right now and save it. Returns the saved file path — ' +
        'follow up with vision_analyze on that path if you need to actually see what it captured.',
      parameters: {
        type: 'object',
        properties: { camera: { type: 'string', description: "'0' (back, default) or '1' (front)" } },
      },
    },
    async execute({ camera = '0' } = {}) {
      const path = `${process.env.HOME || '.'}/memory/photo_${Date.now()}.jpg`;
      const res = await runTermuxApi('termux-camera-photo', ['-c', camera, path], { timeout: 15000 });
      if (res.includes('not found') || res.includes('failed') || res.includes('timed out')) return res;
      return `Photo saved to ${path}`;
    },
  },

  {
    name: 'speak_text',
    declaration: {
      name: 'speak_text',
      description:
        'Speak text out loud through the device speaker right now, via Android TTS — works even outside the ' +
        'voice channel (npm run voice), as an immediate spoken aside from a normal text session. Keep it short.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'What to say out loud' } },
        required: ['text'],
      },
    },
    async execute({ text }) {
      const res = await runTermuxApi('termux-tts-speak', [text], { timeout: 15000 });
      return res === '(no output)' ? 'Spoken.' : res;
    },
  },

  {
    name: 'get_device_specs',
    declaration: {
      name: 'get_device_specs',
      description:
        'Real hardware specs of THIS device: CPU core count, total/available RAM, free storage, ' +
        'architecture, Android version — sourced from /proc, df, and getprop, not Termux:API (works even ' +
        'without Termux:API installed). Call this before recommending or running anything ' +
        'resource-intensive (npm installs of heavy packages, Blender/Unreal renders, spawn_subagent_swarm, ' +
        'distillation/LoRA training, large builds) so the recommendation is calibrated to what this ' +
        'specific device can actually handle, not assumed desktop-class resources. Specs don\'t change ' +
        'mid-session — no need to call this more than once per session unless something seems off.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      const [nproc, meminfo, df, arch, androidRelease] = await Promise.all([
        runShell('nproc'),
        runShell('cat', ['/proc/meminfo']),
        runShell('df', ['-h', process.env.HOME || '/data/data/com.termux/files/home']),
        runShell('uname', ['-m']),
        runShell('getprop', ['ro.build.version.release']),
      ]);

      const cpuCores = nproc ? parseInt(nproc, 10) : null;

      let ramTotalMB = null, ramAvailableMB = null;
      if (meminfo) {
        const total = meminfo.match(/MemTotal:\s+(\d+)\s*kB/);
        const avail = meminfo.match(/MemAvailable:\s+(\d+)\s*kB/);
        if (total) ramTotalMB = Math.round(parseInt(total[1], 10) / 1024);
        if (avail) ramAvailableMB = Math.round(parseInt(avail[1], 10) / 1024);
      }

      let storageFree = null, storageTotal = null;
      if (df) {
        const dataLine = df.split('\n')[1]; // header row + one data row for a single path
        const parts = dataLine?.trim().split(/\s+/) || [];
        if (parts.length >= 5) { storageTotal = parts[1]; storageFree = parts[3]; }
      }

      // Rough, Android/Termux-context thresholds (not desktop-class) — concrete
      // enough to act on without the model having to guess what "low RAM" means
      // on a phone. Deliberately conservative: available RAM, not total, since
      // that's what actually determines whether the next heavy thing OOMs.
      const warnings = [];
      let tier = 'capable';
      if (ramAvailableMB !== null) {
        if (ramAvailableMB < 1024) { tier = 'low'; warnings.push(`Only ~${ramAvailableMB}MB RAM available — avoid starting Blender/Unreal renders, large builds, or spawn_subagent_swarm without warning the human first; consider suggesting they close background apps.`); }
        else if (ramAvailableMB < 3072) { tier = 'moderate'; warnings.push(`~${ramAvailableMB}MB RAM available — fine for normal work, but a heavy build or render may be slow or risk getting killed; mention that upfront rather than after it fails.`); }
      }
      if (cpuCores !== null && cpuCores <= 4) {
        warnings.push(`${cpuCores} CPU core(s) — expect real builds/compiles/renders to take noticeably longer than a desktop; set expectations rather than let it look "stuck".`);
      }
      if (storageFree) {
        const freeNum = parseFloat(storageFree);
        const unit = storageFree.replace(/[\d.]/g, '');
        if (unit === 'M' || (unit === 'G' && freeNum < 1)) {
          warnings.push(`Only ${storageFree} free storage — don't start a large install/download without flagging this first.`);
        }
      }

      return {
        cpuCores, ramTotalMB, ramAvailableMB, storageFree, storageTotal,
        architecture: arch || 'unknown',
        androidVersion: androidRelease || 'unknown',
        tier, // 'low' | 'moderate' | 'capable'
        warnings,
      };
    },
  },
];

