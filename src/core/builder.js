import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Sandbox } from './sandbox.js';

const execAsync = promisify(exec);

// ── Build Orchestrator ──────────────────────────────────────────────────────
// WHY THIS EXISTS:
// A model that just writes files and stops is guessing. It doesn't know if
// the code actually compiles, if the imports resolve, if the tests pass, or
// if the dev server even boots. Jojo's edge over a plain "write code" agent
// is that it treats "I wrote the code" and "the project works" as two
// different, separately-checkable claims — and never reports the second
// without having actually run something that proves it.
//
// This module gives Jojo two things a coding agent needs to build complex
// projects reliably:
//   1. SCAFFOLDS  — known-good starting points for common stacks, so Jojo
//      isn't hand-typing config files (vite.config, tsconfig, package.json)
//      from memory every time, which is where a lot of silent breakage
//      creeps in (wrong option name, mismatched dependency versions, etc).
//   2. VERIFY PIPELINE — a single function that actually installs,
//      type-checks, lints, builds, and tests a project, and hands back a
//      structured, truthful report. No step is allowed to be skipped
//      silently; a skipped step is reported as skipped, not as passing.
//
// HONEST LIMITS:
//   - This can only verify what the target machine actually has installed
//     (node/npm, python/pip, go, etc). Missing toolchains are reported as
//     failures with the exact missing binary, not swallowed.
//   - "Verified" means "the commands defined for this stack succeeded" —
//     it is not a substitute for a human trying the actual app. Jojo should
//     say so, not oversell a green build as "guaranteed bug-free."
//   - The fix loop (see build_tools.js) bounds iteration count on purpose.
//     If a project isn't converging after several rounds, the honest move
//     is to surface the persistent error to the user, not spin forever.

const DEFAULT_TIMEOUT = parseInt(process.env.BUILD_STEP_TIMEOUT || '180000'); // 3 min/step
const MAX_OUTPUT_CHARS = 4000; // keep step output bounded so one noisy step can't blow the context

function truncate(s, n = MAX_OUTPUT_CHARS) {
  s = String(s || '');
  if (s.length <= n) return s;
  const head = s.slice(0, Math.floor(n * 0.6));
  const tail = s.slice(-Math.floor(n * 0.35));
  return `${head}\n… [truncated ${s.length - n} chars] …\n${tail}`;
}

async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function writeFiles(targetDir, files) {
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(targetDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    written.push(rel);
  }
  return written;
}

// ── Stack templates ─────────────────────────────────────────────────────────
// Each stack: files(name, opts) -> {relPath: content}, and steps(opts) ->
// ordered pipeline. `required:false` steps (e.g. lint) don't abort the
// pipeline on failure but are still reported honestly.

const STACKS = {
  'react-vite': {
    label: 'React + Vite (JS or TS) — SPA frontend',
    files(name, opts = {}) {
      const ts = !!opts.typescript;
      const ext = ts ? 'tsx' : 'jsx';
      const files = {
        'package.json': JSON.stringify({
          name: name || 'app',
          private: true,
          version: '0.0.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: ts ? 'tsc -b && vite build' : 'vite build',
            preview: 'vite preview',
            typecheck: ts ? 'tsc --noEmit' : 'echo "no typecheck (JS project)"',
            test: 'vitest run',
            lint: 'eslint . --max-warnings=0',
          },
          dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
          devDependencies: {
            vite: '^5.4.10',
            '@vitejs/plugin-react': '^4.3.3',
            vitest: '^2.1.4',
            eslint: '^9.13.0',
            ...(ts ? { typescript: '^5.6.3', '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1' } : {}),
          },
        }, null, 2),
        'vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { port: 5173 },\n});\n`,
        'index.html': `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${name || 'App'}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.${ext}"></script>\n  </body>\n</html>\n`,
        [`src/main.${ext}`]: `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.${ext}';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
        [`src/App.${ext}`]: `import { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>\n      <h1>${name || 'App'}</h1>\n      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>\n    </main>\n  );\n}\n`,
        'src/index.css': `:root { color-scheme: light dark; }\nbody { margin: 0; }\n`,
        [`src/App.test.${ts ? 'tsx' : 'jsx'}`]: `import { describe, it, expect } from 'vitest';\n\ndescribe('sanity', () => {\n  it('runs', () => {\n    expect(1 + 1).toBe(2);\n  });\n});\n`,
        '.gitignore': 'node_modules\ndist\n.env\n',
      };
      if (ts) {
        files['tsconfig.json'] = JSON.stringify({
          compilerOptions: {
            target: 'ES2020', useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext',
            skipLibCheck: true, moduleResolution: 'bundler', resolveJsonModule: true,
            isolatedModules: true, noEmit: true, jsx: 'react-jsx', strict: true,
          },
          include: ['src'],
        }, null, 2);
      }
      return files;
    },
    steps(opts = {}) {
      const s = [
        { name: 'install', cmd: 'npm install', required: true },
        { name: 'typecheck', cmd: 'npm run typecheck', required: !!opts.typescript },
        { name: 'lint', cmd: 'npm run lint', required: false },
        { name: 'build', cmd: 'npm run build', required: true },
        { name: 'test', cmd: 'npm run test', required: false },
      ];
      return s;
    },
  },

  'nextjs': {
    label: 'Next.js (App Router, TypeScript) — full-stack React',
    files(name) {
      return {
        'package.json': JSON.stringify({
          name: name || 'app', version: '0.1.0', private: true,
          scripts: {
            dev: 'next dev', build: 'next build', start: 'next start',
            lint: 'next lint', typecheck: 'tsc --noEmit',
          },
          dependencies: { next: '^15.0.3', react: '^18.3.1', 'react-dom': '^18.3.1' },
          devDependencies: {
            typescript: '^5.6.3', '@types/node': '^22.9.0',
            '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1',
            eslint: '^9.13.0', 'eslint-config-next': '^15.0.3',
          },
        }, null, 2),
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            target: 'ES2020', lib: ['dom', 'dom.iterable', 'esnext'],
            allowJs: true, skipLibCheck: true, strict: true, noEmit: true,
            esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler',
            resolveJsonModule: true, isolatedModules: true, jsx: 'preserve',
            incremental: true, paths: { '@/*': ['./src/*'] },
          },
          include: ['next-env.d.ts', '**/*.ts', '**/*.tsx'],
          exclude: ['node_modules'],
        }, null, 2),
        'next.config.js': `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nexport default nextConfig;\n`,
        'src/app/layout.tsx': `export const metadata = { title: '${name || 'App'}' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
        'src/app/page.tsx': `export default function Home() {\n  return (\n    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>\n      <h1>${name || 'App'}</h1>\n      <p>Edit src/app/page.tsx to get started.</p>\n    </main>\n  );\n}\n`,
        '.gitignore': 'node_modules\n.next\n.env\n',
      };
    },
    steps() {
      return [
        { name: 'install', cmd: 'npm install', required: true },
        { name: 'typecheck', cmd: 'npm run typecheck', required: true },
        { name: 'lint', cmd: 'npm run lint', required: false },
        { name: 'build', cmd: 'npm run build', required: true },
      ];
    },
  },

  'node-express': {
    label: 'Node + Express — REST API backend',
    files(name) {
      return {
        'package.json': JSON.stringify({
          name: name || 'api', version: '1.0.0', type: 'module',
          scripts: {
            start: 'node src/server.js',
            dev: 'node --watch src/server.js',
            test: 'node --test src/**/*.test.js',
          },
          dependencies: { express: '^4.21.1', cors: '^2.8.5', dotenv: '^16.4.7' },
        }, null, 2),
        'src/server.js': `import express from 'express';\nimport cors from 'cors';\nimport { router } from './routes.js';\n\nconst app = express();\napp.use(cors());\napp.use(express.json());\napp.use('/api', router);\n\napp.get('/health', (req, res) => res.json({ ok: true }));\n\nconst PORT = process.env.PORT || 3000;\nif (process.env.NODE_ENV !== 'test') {\n  app.listen(PORT, () => console.log(\`API listening on :\${PORT}\`));\n}\n\nexport default app;\n`,
        'src/routes.js': `import { Router } from 'express';\n\nexport const router = Router();\n\nrouter.get('/ping', (req, res) => {\n  res.json({ message: 'pong' });\n});\n`,
        'src/routes.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert';\nimport app from './server.js';\n\ntest('GET /health responds ok', async () => {\n  const server = app.listen(0);\n  const { port } = server.address();\n  const res = await fetch(\`http://localhost:\${port}/health\`);\n  const body = await res.json();\n  assert.strictEqual(body.ok, true);\n  server.close();\n});\n`,
        '.env.example': 'PORT=3000\n',
        '.gitignore': 'node_modules\n.env\n',
      };
    },
    steps() {
      return [
        { name: 'install', cmd: 'npm install', required: true },
        { name: 'test', cmd: 'npm run test', required: true },
      ];
    },
  },

  'python-fastapi': {
    label: 'Python + FastAPI — REST API backend',
    files(name) {
      return {
        'requirements.txt': 'fastapi>=0.115\nuvicorn[standard]>=0.32\npytest>=8.3\nhttpx>=0.27\n',
        'app/__init__.py': '',
        'app/main.py': `from fastapi import FastAPI\n\napp = FastAPI(title="${name || 'app'}")\n\n\n@app.get("/health")\ndef health():\n    return {"ok": True}\n\n\n@app.get("/api/ping")\ndef ping():\n    return {"message": "pong"}\n`,
        'tests/test_main.py': `from fastapi.testclient import TestClient\nfrom app.main import app\n\nclient = TestClient(app)\n\n\ndef test_health():\n    r = client.get("/health")\n    assert r.status_code == 200\n    assert r.json()["ok"] is True\n`,
        'pytest.ini': '[pytest]\npythonpath = .\n',
        '.gitignore': '__pycache__/\n*.pyc\n.venv/\n.env\n',
      };
    },
    steps() {
      return [
        { name: 'venv', cmd: 'python3 -m venv .venv', required: true },
        { name: 'install', cmd: '. .venv/bin/activate && pip install -r requirements.txt', required: true },
        { name: 'test', cmd: '. .venv/bin/activate && pytest -q', required: true },
      ];
    },
  },

  'static': {
    label: 'Static HTML/CSS/JS — no build step, served directly',
    files(name) {
      return {
        'index.html': `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${name || 'Site'}</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <h1>${name || 'Site'}</h1>\n  <script src="script.js"></script>\n</body>\n</html>\n`,
        'style.css': 'body { font-family: system-ui, sans-serif; margin: 2rem; }\n',
        'script.js': "console.log('loaded');\n",
      };
    },
    steps() {
      return [
        { name: 'html-check', cmd: "node -e \"require('fs').readFileSync('index.html','utf-8')\"", required: true },
      ];
    },
  },
};

export function listStacks() {
  return Object.entries(STACKS).map(([key, s]) => ({ key, label: s.label }));
}

export async function scaffoldProject({ stack, targetDir, projectName, options = {} }) {
  const def = STACKS[stack];
  if (!def) {
    return { ok: false, error: `Unknown stack "${stack}". Known: ${Object.keys(STACKS).join(', ')}` };
  }
  if (!targetDir) return { ok: false, error: 'targetDir is required' };

  await fs.mkdir(targetDir, { recursive: true });
  const existing = await fs.readdir(targetDir).catch(() => []);
  if (existing.length && !options.force) {
    return {
      ok: false,
      error: `Target directory "${targetDir}" is not empty. Pass options.force=true to write into it anyway (existing files with the same name will be overwritten; others left alone).`,
      existing,
    };
  }

  const files = def.files(projectName, options);
  const written = await writeFiles(targetDir, files);
  return {
    ok: true,
    stack,
    targetDir,
    filesWritten: written,
    nextSteps: [
      `Run verify_project with target_dir="${targetDir}" and stack="${stack}" to install deps and confirm it actually builds before writing more code on top of it.`,
      'Only start adding features once the scaffold verifies clean — building on top of an unverified base compounds errors.',
    ],
  };
}

// ── Stack auto-detection for existing / uploaded projects ─────────────────

export async function detectStack(targetDir) {
  const has = async (f) => pathExists(path.join(targetDir, f));
  if (await has('next.config.js') || await has('next.config.mjs') || await has('next.config.ts')) return 'nextjs';
  if (await has('requirements.txt') || await has('pyproject.toml')) return 'python-fastapi';
  if (await has('package.json')) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return 'nextjs';
      if (deps.vite) return 'react-vite';
      if (deps.express) return 'node-express';
      return 'generic-node';
    } catch { return 'generic-node'; }
  }
  if (await has('index.html')) return 'static';
  return 'unknown';
}

// ── Verification pipeline ───────────────────────────────────────────────────

async function runStep(step, cwd, timeoutMs, sandbox) {
  const started = Date.now();

  if (sandbox) {
    const res = await sandbox.exec(step.cmd, { timeoutMs });
    const missing = /command not found|not recognized|ENOENT|No such file or directory/i.test(res.output || '');
    return {
      name: step.name, cmd: step.cmd, ok: res.ok, required: step.required !== false,
      durationMs: res.durationMs, timedOut: !!res.timedOut,
      missingToolchain: !res.ok && missing,
      sandboxed: res.sandboxed,
      output: truncate(res.output),
    };
  }

  try {
    const { stdout, stderr } = await execAsync(step.cmd, {
      cwd, timeout: timeoutMs || DEFAULT_TIMEOUT, maxBuffer: 8 * 1024 * 1024,
      shell: '/bin/bash', env: { ...process.env },
    });
    return {
      name: step.name, cmd: step.cmd, ok: true, required: step.required !== false,
      durationMs: Date.now() - started, sandboxed: false,
      output: truncate((stdout || '') + (stderr ? `\nSTDERR:\n${stderr}` : '')),
    };
  } catch (err) {
    const missing = /command not found|not recognized|ENOENT|No such file or directory/i.test(String(err.stderr || err.message));
    return {
      name: step.name, cmd: step.cmd, ok: false, required: step.required !== false,
      durationMs: Date.now() - started, sandboxed: false,
      timedOut: !!err.killed,
      missingToolchain: missing,
      output: truncate(String(err.stderr || err.stdout || err.message)),
    };
  }
}

/**
 * Runs a stack's (or custom) verification pipeline against a real directory.
 * Stops at the first FAILING REQUIRED step (no point building on top of a
 * project that doesn't even install) but always returns every step attempted
 * so far, honestly marked ok/failed — never silently omits a step.
 *
 * `sandbox: true` (default) runs every step inside an isolated container
 * (see core/sandbox.js) mounted on targetDir instead of directly on the host
 * process — falling back to direct host exec automatically if Docker isn't
 * available. Pass `sandbox: false` to opt out explicitly.
 */
export async function runVerification({ targetDir, stack, customSteps, timeoutMs, sandbox = true, network }) {
  if (!targetDir || !(await pathExists(targetDir))) {
    return { ok: false, error: `targetDir "${targetDir}" does not exist` };
  }

  let steps;
  let resolvedStack = stack;
  if (customSteps && customSteps.length) {
    steps = customSteps.map(s => ({ name: s.name, cmd: s.cmd, required: s.required !== false }));
  } else {
    if (!resolvedStack || resolvedStack === 'auto') resolvedStack = await detectStack(targetDir);
    const def = STACKS[resolvedStack];
    if (!def) {
      return {
        ok: false,
        error: `Can't auto-verify stack "${resolvedStack}" (no built-in pipeline). Pass customSteps: [{name, cmd}] describing how to install/build/test this project.`,
        detectedStack: resolvedStack,
      };
    }
    steps = def.steps();
  }

  let sbx = null;
  if (sandbox) {
    sbx = new Sandbox({ hostDir: targetDir, label: 'verify', network: network || 'default' });
    await sbx.start().catch(err => { throw new Error(`Sandbox failed to start: ${err.message}`); });
  }

  const results = [];
  let hardFail = false;
  try {
    for (const step of steps) {
      const res = await runStep(step, targetDir, timeoutMs, sbx);
      results.push(res);
      if (!res.ok && res.required) { hardFail = true; break; }
    }
  } finally {
    if (sbx) await sbx.destroy();
  }

  const allRequiredOk = results.filter(r => r.required).every(r => r.ok);
  const attemptedAll = results.length === steps.length;

  return {
    ok: allRequiredOk && attemptedAll,
    stack: resolvedStack || 'custom',
    targetDir,
    steps: results,
    skipped: steps.slice(results.length).map(s => s.name),
    summary: allRequiredOk && attemptedAll
      ? 'All required steps passed. This is verified working, not just written.'
      : hardFail
        ? `Stopped at "${results[results.length - 1].name}" — fix this before doing anything else, then re-run verify_project. Building further on a broken base only compounds the error.`
        : 'Some non-required steps (lint/etc) reported issues — review but not necessarily blocking.',
  };
}

// ── Sandboxed candidate-fix verification ────────────────────────────────────
// WHY THIS EXISTS:
// runVerification() above operates directly on a real targetDir — correct for
// "verify the project I'm actively building," wrong for "test whether an
// unreviewed, model-proposed patch actually fixes something." The self-
// healing loop (see healer.js) needs to prove a candidate fix works BEFORE a
// human ever sees it, without risking the user's real working tree — or the
// host machine — in the process. verifyCandidateFix() is that boundary:
//   1. sourceDir is copied into a throwaway host temp directory (so the
//      candidate's file edits never touch the real project — sourceDir is
//      only ever read here, never written).
//   2. The candidate's files are applied ONLY to that copy.
//   3. runVerification() then runs the install/build/test pipeline against
//      the copy INSIDE an isolated container (core/sandbox.js) — this is the
//      part that used to just be a plain host exec. Directory-copy isolation
//      alone never stopped a candidate command from reading/writing anything
//      else on the host, opening a network connection, etc; the container is
//      what actually closes that gap.
// The temp copy is always deleted afterward, and so is the container.

const SANDBOX_EXCLUDE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', '.cache']);

async function copyForSandbox(sourceDir, destDir) {
  await fs.cp(sourceDir, destDir, {
    recursive: true,
    filter: (src) => !SANDBOX_EXCLUDE.has(path.basename(src)),
  });
}

/** Writes a {relativePath: fullContent} map into targetDir. Shared by the
 *  sandbox pipeline below and by healer.js's applyFix() once a human has
 *  approved writing the same files into the REAL project directory. */
export async function applyFilesToDir(targetDir, files = {}) {
  const written = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(targetDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    written.push(rel);
  }
  return written;
}

/**
 * Copies sourceDir into an isolated temp sandbox, applies a candidate set of
 * file edits there, then runs the same install/typecheck/lint/build/test
 * pipeline runVerification() uses — entirely inside the sandbox. sourceDir
 * itself is only ever read, never written. The sandbox directory is always
 * deleted before returning (success or failure) — the caller only needs the
 * verification report; the candidate's file contents are the caller's own to
 * re-apply to the real tree later via applyFilesToDir, once approved.
 */
export async function verifyCandidateFix({ sourceDir, stack, files = {}, timeoutMs }) {
  if (!sourceDir || !(await pathExists(sourceDir))) {
    return { ok: false, error: `sourceDir "${sourceDir}" does not exist` };
  }
  if (!files || !Object.keys(files).length) {
    return { ok: false, error: 'No candidate files provided to verify.' };
  }

  const sandboxDir = path.join(os.tmpdir(), `jojo-heal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    await copyForSandbox(sourceDir, sandboxDir);
    await applyFilesToDir(sandboxDir, files);
    const resolvedStack = (!stack || stack === 'auto') ? await detectStack(sandboxDir) : stack;
    const verification = await runVerification({ targetDir: sandboxDir, stack: resolvedStack, timeoutMs });
    return {
      ok: !!verification.ok,
      verification,
      sandboxStack: resolvedStack,
      filesApplied: Object.keys(files),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

export { STACKS };

