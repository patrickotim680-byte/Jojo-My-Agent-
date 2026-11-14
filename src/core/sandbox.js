import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);

function isTermux() {
  return !!process.env.PREFIX?.includes('com.termux') || os.platform() === 'android';
}

// ── Sandbox execution layer ─────────────────────────────────────────────────
// WHY THIS EXISTS:
// Before this file, every exec surface in Jojo (builder.js's verify pipeline,
// bash_execute, aircrack/nmap wrappers, etc) ran child_process.exec() directly
// against the host process — same user, same filesystem, same network, same
// env vars as Jojo itself. A model-written command (or a model-proposed
// "candidate fix" from the self-heal loop) could read/write anything Jojo's
// host user can, exfiltrate over any host network path, or spawn anything the
// host has installed. The per-task tmp-dir copy in builder.js's old
// verifyCandidateFix() was directory-level isolation only — it stopped a
// candidate fix from clobbering the wrong FILE, not from doing anything else
// a shell command can do.
//
// This module gives every exec call in Jojo a real process/filesystem/network
// boundary using Docker containers, while trying hard not to take away
// anything the agent could do before:
//   - PERSISTENT per-project containers (not per-command, not per-task) so
//     installed deps, caches, and long-running processes (dev servers) behave
//     like a normal machine across a session — the agent doesn't lose state
//     between tool calls the way a fresh container-per-call would force.
//   - Resource limits (memory, CPU, pids) so a runaway build or a fork bomb
//     can't take down the host.
//   - Non-root by default, capabilities dropped, no-new-privileges — so even
//     a fully compromised or malicious command inside the container can't
//     trivially escalate.
//   - Network is ON by default (npm/pip install need it) but is a named,
//     inspectable Docker network the host isn't otherwise exposed on, and can
//     be set to 'none' per-call for steps that shouldn't need net (e.g. a
//     `build` or `test` step after `install` has already fetched deps).
//   - HOST FALLBACK: if Docker isn't installed/running, Jojo still works
//     exactly as before (direct host exec) but prints a one-time loud warning
//     so the user knows they're running unsandboxed. This is a deliberate
//     choice: failing closed (refusing to run anything without Docker) would
//     make Jojo strictly worse on machines without Docker, which trades one
//     capability regression for a different one. The honest tradeoff is
//     surfaced to the user instead of hidden.
//   - ON TERMUX/ANDROID: this always falls back to host mode, permanently —
//     Docker needs Linux kernel namespaces/cgroups Android's kernel doesn't
//     expose, root or not. That's not a gap this file can close with more
//     code; the real, already-existing protection on Termux is Android's own
//     per-app sandboxing (Termux can't see other apps' data or system
//     partitions without a rooted device) plus the human-approval gate on
//     consequential actions elsewhere in this codebase. See warnFallbackOnce()
//     below for what actually gets told to the user.
//
// HONEST LIMITS (say this to the user, don't oversell it):
//   - Docker containers share the host kernel. This stops filesystem/process/
//     network abuse and most accidental damage, but it is not a security
//     boundary against a determined kernel-exploit-level attacker the way a
//     Firecracker/gVisor microVM (what E2B, Modal, and Devin's cloud sandbox
//     use) is. If Jojo starts running fully untrusted third-party code
//     instead of its own model's output, upgrade the runtime — see
//     SANDBOX_RUNTIME below, which already accepts 'runsc' (gVisor) as a
//     drop-in if the host has it installed.
//   - This is host-machine isolation, not Devin's separate managed cloud
//     sandbox. It solves "the agent can't nuke your machine or your other
//     projects," not "the agent's execution environment is a totally
//     separate machine from yours." A true separate-cloud-VM mode is a
//     reasonable v2 (point SANDBOX_PROVIDER at a remote Docker/Firecracker
//     host over SSH/TCP) but is out of scope here — this module's interface
//     is written so that swap is a provider change, not a caller change.

const SANDBOX_MODE = process.env.JOJO_SANDBOX || 'auto';     // auto | docker | host
const SANDBOX_IMAGE = process.env.JOJO_SANDBOX_IMAGE || 'jojo-sandbox:latest';
const SANDBOX_RUNTIME = process.env.JOJO_SANDBOX_RUNTIME || ''; // '' | 'runsc' (gVisor)
const SANDBOX_MEMORY = process.env.JOJO_SANDBOX_MEMORY || '2g';
const SANDBOX_CPUS = process.env.JOJO_SANDBOX_CPUS || '2';
const SANDBOX_PIDS = process.env.JOJO_SANDBOX_PIDS || '512';
const DEFAULT_TIMEOUT = parseInt(process.env.BUILD_STEP_TIMEOUT || '180000');

let dockerAvailable = null; // cached tri-state: null=unknown, true/false=checked
let warnedFallback = false;

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

async function checkDocker() {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execAsync('docker info', { timeout: 5000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

function warnFallbackOnce(reason) {
  if (warnedFallback) return;
  warnedFallback = true;
  if (isTermux()) {
    console.warn(
      `\n[jojo/sandbox] Running WITHOUT Docker isolation — expected here, not a config problem to ` +
      `fix. Docker's containers rely on Linux kernel namespaces/cgroups that Android's kernel doesn't ` +
      `expose, even on a rooted device — there's no "install Docker" that fixes this on a phone, and ` +
      `rooting the device wouldn't change that either. Real protection that IS in place on Termux: ` +
      `(1) Android's own per-app sandboxing already confines Termux itself — it can't see other apps' ` +
      `private data or system partitions without a rooted device, a real OS-level boundary most ` +
      `desktop Docker setups don't even have; (2) consequential real-world actions (send_sms, ` +
      `make_call, computer-use OS actions) are gated behind explicit human approval regardless of ` +
      `sandbox mode — see android_control_tools.js / computer.js. Commands run with your own Termux ` +
      `user's actual file access within that Android sandbox, same as before.\n`
    );
    return;
  }
  console.warn(
    `\n[jojo/sandbox] Running WITHOUT container isolation (${reason}). ` +
    `Commands will execute directly on this host with your user's permissions. ` +
    `Install Docker and set JOJO_SANDBOX=docker (or leave JOJO_SANDBOX=auto) to sandbox them.\n`
  );
}

/**
 * Resolve the effective mode once per process: 'docker' or 'host'.
 */
export async function resolveSandboxMode() {
  if (SANDBOX_MODE === 'host') return 'host';
  if (SANDBOX_MODE === 'docker') {
    if (!(await checkDocker())) {
      throw new Error('JOJO_SANDBOX=docker was set but Docker is not available (is the daemon running?).');
    }
    return 'docker';
  }
  // auto
  const ok = await checkDocker();
  if (!ok) warnFallbackOnce('Docker not found or daemon not running');
  return ok ? 'docker' : 'host';
}

/**
 * One persistent isolated environment for a given project directory (or an
 * ephemeral candidate-fix copy of one). Backed by a long-lived Docker
 * container when Docker is available; falls back to direct host exec
 * otherwise so callers never have to branch on sandbox availability.
 */
export class Sandbox {
  /**
   * @param {object} opts
   * @param {string} opts.hostDir - directory on the host to mount/operate on
   * @param {string} [opts.label] - human-readable tag, used in container name
   * @param {boolean} [opts.readOnlyRoot] - mount hostDir read-only (verification
   *   of someone else's tree) vs read-write (building the user's own project)
   * @param {'default'|'none'} [opts.network] - 'none' fully disables networking
   *   for this sandbox (use after deps are already installed, e.g. for a
   *   pure test/build step that shouldn't be able to phone home at all)
   */
  constructor({ hostDir, label = 'proj', readOnlyRoot = false, network = 'default' } = {}) {
    this.hostDir = path.resolve(hostDir);
    this.label = label;
    this.readOnlyRoot = readOnlyRoot;
    this.network = network;
    this.containerName = `jojo-sbx-${label}-${shortId()}`;
    this.mode = null;
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.mode = await resolveSandboxMode();
    if (this.mode === 'docker') {
      await this._startContainer();
      if (this.network !== 'none') await this._checkNetwork();
    }
    this.started = true;
  }

  async _startContainer() {
    const mountFlag = this.readOnlyRoot ? 'ro' : 'rw';
    const args = [
      'run', '-d',
      '--name', this.containerName,
      '--memory', SANDBOX_MEMORY,
      '--cpus', SANDBOX_CPUS,
      '--pids-limit', SANDBOX_PIDS,
      '--security-opt', 'no-new-privileges',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', // enough for npm/pip installs
      '-v', `${this.hostDir}:/workspace:${mountFlag}`,
      '-w', '/workspace',
    ];
    if (SANDBOX_RUNTIME) args.push('--runtime', SANDBOX_RUNTIME);
    if (this.network === 'none') args.push('--network', 'none');
    args.push(SANDBOX_IMAGE, 'sleep', 'infinity');

    try {
      await execAsync(`docker ${args.map(a => /[^A-Za-z0-9._/:=-]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a).join(' ')}`);
    } catch (err) {
      const msg = String(err.stderr || err.message);
      if (/No such image/i.test(msg)) {
        throw new Error(
          `Sandbox image "${SANDBOX_IMAGE}" not found. Build it once with: ` +
          `docker build -t ${SANDBOX_IMAGE} -f sandbox/Dockerfile .`
        );
      }
      throw err;
    }
  }

  /**
   * Docker containers get network ON by default (see module comment above) —
   * this doesn't change that, it just stops a broken network from being
   * *silent*. Without this, a host with a misconfigured Docker bridge/DNS
   * (common with some VPNs, corporate firewalls, or Docker Desktop + WSL2
   * setups) would just see `npm install` mysteriously hang or fail deep
   * inside a build step, with nothing pointing at the real cause. Best-
   * effort only: never throws, never blocks start() — a failed probe just
   * logs a loud one-time warning so the real fix (almost always host/Docker
   * networking, not Jojo) is obvious immediately instead of three steps later.
   */
  async _checkNetwork() {
    try {
      const { stdout } = await execAsync(
        `docker exec ${this.containerName} curl -fsS --max-time 5 -o /dev/null -w '%{http_code}' https://registry.npmjs.org`,
        { timeout: 8000 }
      );
      if (stdout.trim() !== '200') throw new Error(`unexpected response status ${stdout.trim()}`);
    } catch (err) {
      console.warn(
        `\n[jojo/sandbox] Container "${this.containerName}" is up but can't reach the network ` +
        `(${err.message || 'connectivity probe failed'}). Anything needing network (npm/pip install, ` +
        `git clone, etc) will fail inside this sandbox even though network mode is on. This is almost ` +
        `always Docker's network/DNS on the host, not Jojo — try ` +
        `\`docker run --rm ${SANDBOX_IMAGE} curl -v https://registry.npmjs.org\` directly to confirm, ` +
        `and check any VPN/firewall that might be blocking Docker's bridge network.\n`
      );
    }
  }


  /**
   * Run a command inside the sandbox (or directly on host, in fallback mode).
   * Same shape/return contract as builder.js's runStep so callers don't care
   * which backend actually executed it.
   */
  async exec(cmd, { cwd, timeoutMs, env } = {}) {
    if (!this.started) await this.start();
    const timeout = timeoutMs || DEFAULT_TIMEOUT;
    const started = Date.now();

    if (this.mode === 'host') {
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: cwd ? path.join(this.hostDir, cwd) : this.hostDir,
          timeout, maxBuffer: 8 * 1024 * 1024, shell: '/bin/bash',
          env: { ...process.env, ...env },
        });
        return { ok: true, output: stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''), durationMs: Date.now() - started, sandboxed: false };
      } catch (err) {
        return {
          ok: false, timedOut: !!err.killed,
          output: String(err.stderr || err.stdout || err.message),
          durationMs: Date.now() - started, sandboxed: false,
        };
      }
    }

    // docker exec inside the persistent container
    const workdir = cwd ? path.posix.join('/workspace', cwd) : '/workspace';
    const envFlags = Object.entries(env || {}).map(([k, v]) => `-e ${k}=${JSON.stringify(v)}`).join(' ');
    const dockerCmd = `docker exec ${envFlags} -w ${workdir} ${this.containerName} bash -lc ${JSON.stringify(cmd)}`;
    try {
      const { stdout, stderr } = await execAsync(dockerCmd, { timeout, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, output: stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''), durationMs: Date.now() - started, sandboxed: true };
    } catch (err) {
      return {
        ok: false, timedOut: !!err.killed,
        output: String(err.stderr || err.stdout || err.message),
        durationMs: Date.now() - started, sandboxed: true,
      };
    }
  }

  async destroy() {
    if (this.mode !== 'docker') return;
    await execAsync(`docker rm -f ${this.containerName}`).catch(() => {});
  }
}

/**
 * Keeps one Sandbox alive per hostDir for the life of the process, so
 * repeated tool calls (e.g. many bash_execute calls during one session)
 * reuse the same container instead of paying container-start cost and
 * losing installed-tool/cache state every call.
 */
const liveSandboxes = new Map(); // hostDir -> Sandbox

export async function getProjectSandbox(hostDir, opts = {}) {
  const key = path.resolve(hostDir);
  let sbx = liveSandboxes.get(key);
  if (!sbx) {
    sbx = new Sandbox({ hostDir: key, label: 'session', ...opts });
    liveSandboxes.set(key, sbx);
  }
  return sbx;
}

export async function destroyAllSandboxes() {
  for (const sbx of liveSandboxes.values()) await sbx.destroy();
  liveSandboxes.clear();
}

process.on('exit', () => {
  // best-effort sync cleanup isn't possible for async docker rm here;
  // callers (index.js) should await destroyAllSandboxes() on graceful shutdown.
});

