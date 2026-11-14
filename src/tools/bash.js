import { exec } from 'child_process';
import { promisify } from 'util';
import { getProjectSandbox } from '../core/sandbox.js';

const execAsync = promisify(exec);
const TIMEOUT   = parseInt(process.env.BASH_TIMEOUT || '30000');
const CWD       = process.env.BASH_CWD || process.cwd();

export const BASH_TOOLS = [
  {
    name: 'bash_execute',
    declaration: {
      name: 'bash_execute',
      description:
        'Execute a bash/shell command and return stdout + stderr. ' +
        'Use for: running scripts, installing packages, git, system info, compiling, etc. ' +
        'Runs inside an isolated sandbox (container) scoped to the working directory when ' +
        'one is available on this machine; otherwise runs directly on the host (a warning ' +
        'is printed once when that happens).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          cwd:     { type: 'string', description: 'Working directory (optional)' },
        },
        required: ['command'],
      },
    },

    async execute({ command, cwd }) {
      const workDir = cwd || CWD;
      try {
        const sandbox = await getProjectSandbox(workDir);
        const res = await sandbox.exec(command, { timeoutMs: TIMEOUT });
        if (res.ok) return res.output.trim() || '(no output)';
        return res.timedOut
          ? `Error: timed out after ${TIMEOUT}ms`
          : `Error: ${res.output.trim()}`;
      } catch (err) {
        // Sandbox itself failed to start (e.g. JOJO_SANDBOX=docker but no
        // daemon) — surface that clearly instead of silently going unsafe.
        return `Error: sandbox unavailable (${err.message}). Set JOJO_SANDBOX=host to run unsandboxed on purpose, or fix Docker.`;
      }
    },
  },
];

// Kept for callers that explicitly need a raw, unsandboxed host exec (e.g.
// Jojo's own setup/diagnostic scripts, not model-driven tool calls).
export async function rawHostExec(command, { cwd, timeout = TIMEOUT } = {}) {
  const { stdout, stderr } = await execAsync(command, {
    cwd: cwd || CWD, timeout, maxBuffer: 5 * 1024 * 1024, env: { ...process.env },
  });
  return (stdout || '') + (stderr ? `\nSTDERR:\n${stderr}` : '');
}

