import { exec }    from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ── Preset flag profiles ──────────────────────────────────────────────────────
const SCAN_PROFILES = {
  quick:   '-T4 -F',                    // top 100 ports, fast
  version: '-sV -T4',                   // service + version detection
  os:      '-O -T4',                    // OS fingerprinting (needs root)
  full:    '-T4 -A -v',                 // OS + version + scripts + traceroute
  stealth: '-sS -T2',                   // SYN scan (needs root)
  ping:    '-sn',                       // host discovery only, no ports
  udp:     '-sU -T4 --top-ports 100',   // top 100 UDP ports
  vuln:    '--script vuln -T4',         // NSE vulnerability scripts
};

// ── Helper: validate target looks safe (no shell metacharacters) ───────────────
function validateTarget(target) {
  // Allow: IPs, CIDR, hostnames, ranges (e.g. 192.168.1.1-20), comma lists
  if (/[;&|`$(){}[\]\\'"<>!]/.test(target)) {
    throw new Error(`Unsafe characters in target: "${target}"`);
  }
  if (!target.trim()) throw new Error('Target must not be empty.');
}

// ── Helper: validate ports string ─────────────────────────────────────────────
function validatePorts(ports) {
  if (!ports) return;
  if (!/^[\d,\-]+$/.test(ports) && ports !== 'all') {
    throw new Error(`Invalid port expression: "${ports}"`);
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const NMAP_TOOLS = [

  // ── nmap_scan ───────────────────────────────────────────────────────────────
  {
    name: 'nmap_scan',
    declaration: {
      name: 'nmap_scan',
      description:
        'Run an nmap scan against one or more hosts. ' +
        'Use for: port discovery, service enumeration, OS detection, host discovery, and vulnerability checks. ' +
        'Requires nmap to be installed on the system (sudo apt install nmap). ' +
        'Some scan types (os, stealth) require root/sudo privileges.',
      parameters: {
        type: 'object',
        properties: {

          target: {
            type: 'string',
            description:
              'What to scan. Accepts: single IP (192.168.1.1), hostname (example.com), ' +
              'CIDR range (192.168.1.0/24), dash range (192.168.1.1-50), ' +
              'or space/comma-separated list of any of the above.',
          },

          scan_type: {
            type: 'string',
            enum: ['quick', 'version', 'os', 'full', 'stealth', 'ping', 'udp', 'vuln'],
            description:
              'Scan profile to use (default: quick). ' +
              'quick   → top-100 ports, fast timing. ' +
              'version → service + version detection. ' +
              'os      → OS fingerprinting (needs root). ' +
              'full    → OS + versions + NSE scripts + traceroute. ' +
              'stealth → TCP SYN scan (needs root). ' +
              'ping    → host-discovery only, no ports. ' +
              'udp     → top-100 UDP ports. ' +
              'vuln    → run NSE vulnerability scripts.',
          },

          ports: {
            type: 'string',
            description:
              'Port(s) to scan. Examples: "80", "22,80,443", "1-1024", "all" (1-65535). ' +
              'Leave empty to use the profile default.',
          },

          extra_args: {
            type: 'string',
            description:
              'Any additional raw nmap flags, e.g. "--open -v --script http-title". ' +
              'Appended after the profile flags.',
          },

          timeout: {
            type: 'number',
            description: 'Max seconds to wait for nmap to finish (default: 120).',
          },

        },
        required: ['target'],
      },
    },

    async execute({ target, scan_type = 'quick', ports, extra_args = '', timeout = 120 }) {
      try {
        validateTarget(target);
        validatePorts(ports);

        const profile   = SCAN_PROFILES[scan_type] ?? SCAN_PROFILES.quick;
        const portFlag  = ports ? (ports === 'all' ? '-p-' : `-p ${ports}`) : '';
        const command   = `nmap ${profile} ${portFlag} ${extra_args} ${target}`.replace(/\s+/g, ' ').trim();

        let out = `$ ${command}\n\n`;

        const { stdout, stderr } = await execAsync(command, {
          timeout: timeout * 1000,
          maxBuffer: 10 * 1024 * 1024, // 10 MB
        });

        if (stdout) out += stdout;
        if (stderr)  out += `\nSTDERR:\n${stderr}`;
        return out.trim() || '(no output)';

      } catch (err) {
        if (err.killed || err.signal === 'SIGTERM') {
          return `Error: nmap timed out after ${timeout}s. Try a narrower target or fewer ports.`;
        }
        // nmap not installed
        if (/not found|ENOENT/i.test(err.message)) {
          return (
            'Error: nmap is not installed.\n' +
            'Install it with:  sudo apt install nmap\n' +
            '(On macOS:        brew install nmap)'
          );
        }
        const msg = err.stderr || err.stdout || err.message;
        return `Error (exit ${err.code ?? '?'}): ${String(msg).trim()}`;
      }
    },
  },

];

