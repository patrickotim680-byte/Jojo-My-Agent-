import { exec }    from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Helper: validate interface name ───────────────────────────────────────────
function validateInterface(iface) {
  if (!iface || !iface.trim()) throw new Error('Interface must not be empty.');
  if (!/^[a-zA-Z0-9_-]+$/.test(iface.trim())) {
    throw new Error(`Unsafe characters in interface name: "${iface}"`);
  }
}

// ── Helper: validate file path (no shell metacharacters) ─────────────────────
function validatePath(filePath) {
  if (!filePath || !filePath.trim()) throw new Error('File path must not be empty.');
  if (/[;&|`$(){}[\]\\'\"<>!]/.test(filePath)) {
    throw new Error(`Unsafe characters in file path: "${filePath}"`);
  }
}

// ── Helper: validate BSSID / MAC ─────────────────────────────────────────────
function validateBSSID(bssid) {
  if (!bssid) return;
  if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(bssid.trim())) {
    throw new Error(`Invalid BSSID/MAC format: "${bssid}"`);
  }
}

// ── Helper: check if tool is installed ───────────────────────────────────────
function notInstalledMsg(tool) {
  return (
    `Error: ${tool} is not installed.\n` +
    'Install aircrack-ng with:  sudo apt install aircrack-ng\n' +
    '(On macOS:                 brew install aircrack-ng)'
  );
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const AIRCRACK_TOOLS = [

  // ── aircrack_ng ─────────────────────────────────────────────────────────────
  {
    name: 'aircrack_ng',
    declaration: {
      name: 'aircrack_ng',
      description:
        'Crack WEP or WPA/WPA2 passphrases from a capture file (.cap/.ivs). ' +
        'Use for: recovering keys from previously captured wireless handshakes or IVs. ' +
        'For WPA/WPA2 a wordlist is required. For WEP enough IVs must be in the capture. ' +
        'Requires aircrack-ng to be installed (sudo apt install aircrack-ng). ' +
        'Only use on networks you own or have explicit written permission to test.',
      parameters: {
        type: 'object',
        properties: {

          capture_file: {
            type: 'string',
            description: 'Path to the .cap or .ivs capture file containing handshake/IVs.',
          },

          wordlist: {
            type: 'string',
            description:
              'Path to a wordlist file for WPA/WPA2 cracking (e.g. /usr/share/wordlists/rockyou.txt). ' +
              'Not needed for WEP (statistical attack is used instead).',
          },

          bssid: {
            type: 'string',
            description: 'Target AP BSSID in AA:BB:CC:DD:EE:FF format. Narrows cracking to one network when the capture has multiple.',
          },

          essid: {
            type: 'string',
            description: 'Target network ESSID (name). Used when BSSID is not enough to identify the network.',
          },

          extra_args: {
            type: 'string',
            description: 'Additional raw aircrack-ng flags, e.g. "-e MyNet -l found.txt". Appended last.',
          },

          timeout: {
            type: 'number',
            description: 'Max seconds to wait (default: 300).',
          },

        },
        required: ['capture_file'],
      },
    },

    async execute({ capture_file, wordlist, bssid, essid, extra_args = '', timeout = 300 }) {
      try {
        validatePath(capture_file);
        if (wordlist)  validatePath(wordlist);
        if (bssid)     validateBSSID(bssid);

        const bssidFlag  = bssid   ? `-b ${bssid}`        : '';
        const essidFlag  = essid   ? `-e "${essid}"`       : '';
        const wlistFlag  = wordlist ? `-w "${wordlist}"`   : '';
        const command    = `aircrack-ng ${bssidFlag} ${essidFlag} ${wlistFlag} ${extra_args} "${capture_file}"`
                           .replace(/\s+/g, ' ').trim();

        let out = `$ ${command}\n\n`;
        const { stdout, stderr } = await execAsync(command, {
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });

        if (stdout) out += stdout;
        if (stderr)  out += `\nSTDERR:\n${stderr}`;
        return out.trim() || '(no output)';

      } catch (err) {
        if (err.killed || err.signal === 'SIGTERM') {
          return `Error: aircrack-ng timed out after ${timeout}s. The capture may need more IVs/handshakes.`;
        }
        if (/not found|ENOENT/i.test(err.message)) return notInstalledMsg('aircrack-ng');
        const msg = err.stderr || err.stdout || err.message;
        return `Error (exit ${err.code ?? '?'}): ${String(msg).trim()}`;
      }
    },
  },

  // ── airmon_ng ────────────────────────────────────────────────────────────────
  {
    name: 'airmon_ng',
    declaration: {
      name: 'airmon_ng',
      description:
        'Enable, disable, or check monitor mode on a wireless interface using airmon-ng. ' +
        'Use for: putting a card into monitor mode before capturing or injecting packets. ' +
        'Requires root privileges. Part of the aircrack-ng suite.',
      parameters: {
        type: 'object',
        properties: {

          action: {
            type: 'string',
            enum: ['start', 'stop', 'check'],
            description:
              'start  → enable monitor mode on the interface (creates wlan0mon or similar). ' +
              'stop   → return interface to managed mode. ' +
              'check  → list processes that may interfere with monitor mode.',
          },

          interface: {
            type: 'string',
            description: 'Wireless interface name, e.g. "wlan0". Required for start/stop.',
          },

          channel: {
            type: 'number',
            description: 'Lock monitor interface to this channel (1-14 for 2.4 GHz, 36+ for 5 GHz). Optional for start.',
          },

        },
        required: ['action'],
      },
    },

    async execute({ action, interface: iface, channel }) {
      try {
        if (action !== 'check') validateInterface(iface);

        const chanFlag = (action === 'start' && channel) ? ` ${channel}` : '';
        const target   = iface ? ` ${iface.trim()}` : '';
        const command  = `airmon-ng ${action}${target}${chanFlag}`.trim();

        let out = `$ ${command}\n\n`;
        const { stdout, stderr } = await execAsync(command, {
          timeout: 30000,
          maxBuffer: 2 * 1024 * 1024,
        });

        if (stdout) out += stdout;
        if (stderr)  out += `\nSTDERR:\n${stderr}`;
        return out.trim() || '(no output)';

      } catch (err) {
        if (/not found|ENOENT/i.test(err.message)) return notInstalledMsg('airmon-ng');
        const msg = err.stderr || err.stdout || err.message;
        return `Error (exit ${err.code ?? '?'}): ${String(msg).trim()}`;
      }
    },
  },

  // ── airodump_ng ──────────────────────────────────────────────────────────────
  {
    name: 'airodump_ng',
    declaration: {
      name: 'airodump_ng',
      description:
        'Capture 802.11 frames with airodump-ng — list nearby APs/clients or record packets to file. ' +
        'Use for: discovering wireless networks, capturing WPA handshakes, or collecting WEP IVs. ' +
        'Interface must already be in monitor mode (use airmon_ng first). Requires root. ' +
        'Only use on networks you own or have explicit written permission to test.',
      parameters: {
        type: 'object',
        properties: {

          interface: {
            type: 'string',
            description: 'Monitor-mode interface to listen on, e.g. "wlan0mon".',
          },

          bssid: {
            type: 'string',
            description: 'Filter capture to a single AP by BSSID (AA:BB:CC:DD:EE:FF). Leave empty to see all.',
          },

          channel: {
            type: 'number',
            description: 'Lock to this channel instead of hopping. Required when targeting a specific AP.',
          },

          write_prefix: {
            type: 'string',
            description: 'Output file prefix. airodump-ng will create <prefix>-01.cap, <prefix>-01.csv, etc.',
          },

          duration: {
            type: 'number',
            description: 'How many seconds to capture before stopping (default: 30). Keep short for discovery scans.',
          },

          band: {
            type: 'string',
            enum: ['a', 'b', 'g', 'abg'],
            description: 'Frequency band to scan: a=5GHz, b/g=2.4GHz, abg=both. Default: bg.',
          },

          extra_args: {
            type: 'string',
            description: 'Additional raw airodump-ng flags, appended last.',
          },

        },
        required: ['interface'],
      },
    },

    async execute({ interface: iface, bssid, channel, write_prefix, duration = 30, band, extra_args = '' }) {
      try {
        validateInterface(iface);
        if (bssid)        validateBSSID(bssid);
        if (write_prefix) validatePath(write_prefix);

        const bssidFlag  = bssid        ? `--bssid ${bssid}`          : '';
        const chanFlag   = channel      ? `--channel ${channel}`       : '';
        const writeFlag  = write_prefix ? `--write "${write_prefix}"`  : '';
        const bandFlag   = band         ? `--band ${band}`             : '';

        const command = (
          `timeout ${duration} airodump-ng ${bssidFlag} ${chanFlag} ${writeFlag} ${bandFlag} ${extra_args} ${iface}`
        ).replace(/\s+/g, ' ').trim();

        let out = `$ ${command}\n\n`;
        const { stdout, stderr } = await execAsync(command, {
          timeout: (duration + 10) * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });

        if (stdout) out += stdout;
        if (stderr)  out += `\nSTDERR:\n${stderr}`;
        return out.trim() || '(no output — try increasing duration or check that the interface is in monitor mode)';

      } catch (err) {
        // timeout exit code 124 is normal — return whatever was captured
        if (err.code === 124 || err.killed) {
          const collected = (err.stdout || '') + (err.stderr ? `\nSTDERR:\n${err.stderr}` : '');
          return collected.trim() || '(capture ended — no output collected)';
        }
        if (/not found|ENOENT/i.test(err.message)) return notInstalledMsg('airodump-ng');
        const msg = err.stderr || err.stdout || err.message;
        return `Error (exit ${err.code ?? '?'}): ${String(msg).trim()}`;
      }
    },
  },

  // ── aireplay_ng ──────────────────────────────────────────────────────────────
  {
    name: 'aireplay_ng',
    declaration: {
      name: 'aireplay_ng',
      description:
        'Inject 802.11 frames with aireplay-ng to accelerate WPA handshake capture or WEP IV collection. ' +
        'Common attacks: deauth (force clients to reconnect and expose handshake), fake-auth, ARP replay. ' +
        'Requires monitor-mode interface and root. ' +
        'Only use on networks you own or have explicit written permission to test.',
      parameters: {
        type: 'object',
        properties: {

          interface: {
            type: 'string',
            description: 'Monitor-mode interface, e.g. "wlan0mon".',
          },

          attack: {
            type: 'string',
            enum: ['deauth', 'fakeauth', 'arpreplay', 'chopchop', 'fragment', 'caffe-latte', 'interactive'],
            description:
              'deauth      → send deauthentication frames (kick clients, -0). ' +
              'fakeauth    → fake-authenticate with AP to associate (-1). ' +
              'arpreplay   → ARP-request replay to generate WEP IVs (-3). ' +
              'chopchop    → WEP chop-chop attack (-4). ' +
              'fragment    → fragmentation attack (-5). ' +
              'caffe-latte → recover WEP key from isolated client (-6). ' +
              'interactive → interactive frame selection (-2).',
          },

          bssid: {
            type: 'string',
            description: 'Target AP BSSID (AA:BB:CC:DD:EE:FF).',
          },

          client_mac: {
            type: 'string',
            description: 'Client MAC to deauth or replay from. Use "FF:FF:FF:FF:FF:FF" to deauth all clients.',
          },

          count: {
            type: 'number',
            description: 'Number of frames/deauths to send (0 = continuous). Default: 5 for deauth.',
          },

          extra_args: {
            type: 'string',
            description: 'Additional raw aireplay-ng flags.',
          },

          timeout: {
            type: 'number',
            description: 'Max seconds to run (default: 30).',
          },

        },
        required: ['interface', 'attack', 'bssid'],
      },
    },

    async execute({ interface: iface, attack, bssid, client_mac, count, extra_args = '', timeout = 30 }) {
      try {
        validateInterface(iface);
        validateBSSID(bssid);
        if (client_mac) validateBSSID(client_mac);

        const ATTACK_FLAGS = {
          deauth:      '-0',
          fakeauth:    '-1',
          interactive: '-2',
          arpreplay:   '-3',
          chopchop:    '-4',
          fragment:    '-5',
          'caffe-latte': '-6',
        };

        const flag       = ATTACK_FLAGS[attack];
        const countVal   = count !== undefined ? count : (attack === 'deauth' ? 5 : 0);
        const clientFlag = client_mac ? `-c ${client_mac}` : '';
        const command    = (
          `aireplay-ng ${flag} ${countVal} -a ${bssid} ${clientFlag} ${extra_args} ${iface}`
        ).replace(/\s+/g, ' ').trim();

        let out = `$ ${command}\n\n`;
        const { stdout, stderr } = await execAsync(command, {
          timeout: timeout * 1000,
          maxBuffer: 5 * 1024 * 1024,
        });

        if (stdout) out += stdout;
        if (stderr)  out += `\nSTDERR:\n${stderr}`;
        return out.trim() || '(no output)';

      } catch (err) {
        if (err.killed || err.signal === 'SIGTERM') {
          const collected = (err.stdout || '') + (err.stderr ? `\nSTDERR:\n${err.stderr}` : '');
          return collected.trim() || `Stopped after ${timeout}s.`;
        }
        if (/not found|ENOENT/i.test(err.message)) return notInstalledMsg('aireplay-ng');
        const msg = err.stderr || err.stdout || err.message;
        return `Error (exit ${err.code ?? '?'}): ${String(msg).trim()}`;
      }
    },
  },

];

