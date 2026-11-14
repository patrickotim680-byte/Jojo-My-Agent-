import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);
const TIMEOUT   = parseInt(process.env.CODE_TIMEOUT || process.env.BASH_TIMEOUT || '60000');

// ── Language definitions ────────────────────────────────────────────────────
// Interpreted: one command runs the file directly.
const RUNNERS = {
  python:     { ext: 'py',     bin: 'python3', cmd: f => `python3 "${f}"` },
  python3:    { ext: 'py',     bin: 'python3', cmd: f => `python3 "${f}"` },
  javascript: { ext: 'js',     bin: 'node',    cmd: f => `node "${f}"` },
  node:       { ext: 'js',     bin: 'node',    cmd: f => `node "${f}"` },
  typescript: { ext: 'ts',     bin: 'npx',     cmd: f => `npx --yes tsx "${f}"` },
  bash:       { ext: 'sh',     bin: 'bash',    cmd: f => `bash "${f}"` },
  shell:      { ext: 'sh',     bin: 'bash',    cmd: f => `bash "${f}"` },
  ruby:       { ext: 'rb',     bin: 'ruby',    cmd: f => `ruby "${f}"` },
  go:         { ext: 'go',     bin: 'go',      cmd: f => `go run "${f}"` },
  php:        { ext: 'php',    bin: 'php',     cmd: f => `php "${f}"` },
  perl:       { ext: 'pl',     bin: 'perl',    cmd: f => `perl "${f}"` },
  r:          { ext: 'R',      bin: 'Rscript', cmd: f => `Rscript "${f}"` },
  lua:        { ext: 'lua',    bin: 'lua',     cmd: f => `lua "${f}"` },
  swift:      { ext: 'swift',  bin: 'swift',   cmd: f => `swift "${f}"` },
  kotlin:     { ext: 'kts',    bin: 'kotlin',  cmd: f => `kotlin "${f}"` },
  dart:       { ext: 'dart',   bin: 'dart',    cmd: f => `dart run "${f}"` },
  elixir:     { ext: 'exs',    bin: 'elixir',  cmd: f => `elixir "${f}"` },
  julia:      { ext: 'jl',     bin: 'julia',   cmd: f => `julia "${f}"` },
  haskell:    { ext: 'hs',     bin: 'runghc',  cmd: f => `runghc "${f}"` },
  zig:        { ext: 'zig',    bin: 'zig',     cmd: f => `zig run "${f}"` },
  deno:       { ext: 'ts',     bin: 'deno',    cmd: f => `deno run --allow-all "${f}"` },
  bun:        { ext: 'js',     bin: 'bun',     cmd: f => `bun run "${f}"` },
  fsharp:     { ext: 'fsx',    bin: 'dotnet',  cmd: f => `dotnet fsi "${f}"` },
};

// Compiled: build step, then a separate run step.
const COMPILED = {
  c:       { ext: 'c',   bin: 'gcc',   build: (f, bin) => `gcc "${f}" -o "${bin}" -lm`, run: bin => `"${bin}"` },
  cpp:     { ext: 'cpp', bin: 'g++',   build: (f, bin) => `g++ "${f}" -o "${bin}" -std=c++17`, run: bin => `"${bin}"` },
  rust:    { ext: 'rs',  bin: 'rustc', build: (f, bin) => `rustc "${f}" -O -o "${bin}"`, run: bin => `"${bin}"` },
  java:    { ext: 'java', bin: 'javac', className: true,
             build: f => `javac "${f}"`,
             run: (className, dir) => `java -cp "${dir}" ${className}` },
  csharp:  { ext: 'cs',  bin: 'mcs',   build: (f, bin) => `mcs "${f}" -out:"${bin}.exe"`, run: bin => `mono "${bin}.exe"` },
};

const SUPPORTED = [...new Set([...Object.keys(RUNNERS), ...Object.keys(COMPILED)])];

// ── helpers ──────────────────────────────────────────────────────────────────

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

async function runCmd(command, cwd, timeoutMs) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout:   timeoutMs || TIMEOUT,
      maxBuffer: 5 * 1024 * 1024,
      env:       { ...process.env },
    });
    let out = stdout || '';
    if (stderr) out += `\nSTDERR:\n${stderr}`;
    return out.trim() || '(no output)';
  } catch (err) {
    if (err.killed) return `Error: timed out after ${timeoutMs || TIMEOUT}ms`;
    const msg = String(err.stderr || err.stdout || err.message).trim();
    if (/command not found|not recognized|ENOENT/i.test(msg)) {
      return `Error: the interpreter/compiler for this language isn't installed on this machine. (${msg.split('\n')[0]})`;
    }
    return `Error (exit ${err.code}): ${msg}`;
  }
}

async function runScript({ language, code, args = [], stdin = '', timeoutMs }) {
  const lang = String(language || '').toLowerCase().trim();
  if (!RUNNERS[lang] && !COMPILED[lang]) {
    return `Error: unsupported language "${language}". Supported: ${SUPPORTED.join(', ')}`;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jojo-code-'));
  try {
    const argStr = (args || []).map(shQuote).join(' ');
    let stdinRedirect = '';
    if (stdin) {
      const stdinFile = path.join(tmpDir, 'stdin.txt');
      await fs.writeFile(stdinFile, stdin, 'utf-8');
      stdinRedirect = ` < "${stdinFile}"`;
    }

    // ── interpreted languages ──────────────────────────────────────────────
    if (RUNNERS[lang]) {
      const file = path.join(tmpDir, `main.${RUNNERS[lang].ext}`);
      await fs.writeFile(file, code, 'utf-8');
      const cmd = `${RUNNERS[lang].cmd(file)} ${argStr}${stdinRedirect}`.trim();
      return await runCmd(cmd, tmpDir, timeoutMs);
    }

    // ── compiled languages ──────────────────────────────────────────────────
    const spec = COMPILED[lang];

    if (spec.className) {
      // Java: filename must match the public class name.
      const match     = code.match(/public\s+(?:final\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      const className = match ? match[1] : 'Main';
      const file = path.join(tmpDir, `${className}.java`);
      await fs.writeFile(file, code, 'utf-8');

      const buildResult = await runCmd(spec.build(file), tmpDir, timeoutMs);
      if (buildResult.startsWith('Error')) return `Compile error:\n${buildResult}`;

      const runResult = await runCmd(`${spec.run(className, tmpDir)} ${argStr}${stdinRedirect}`.trim(), tmpDir, timeoutMs);
      return runResult;
    }

    const file = path.join(tmpDir, `main.${spec.ext}`);
    const bin  = path.join(tmpDir, 'jojo_bin');
    await fs.writeFile(file, code, 'utf-8');

    const buildResult = await runCmd(spec.build(file, bin), tmpDir, timeoutMs);
    if (buildResult.startsWith('Error')) return `Compile error:\n${buildResult}`;

    return await runCmd(`${spec.run(bin)} ${argStr}${stdinRedirect}`.trim(), tmpDir, timeoutMs);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkEnvironment() {
  const all = { ...RUNNERS, ...COMPILED };
  const seen = new Map(); // bin -> language list, dedupe checks
  for (const [lang, spec] of Object.entries(all)) {
    if (!seen.has(spec.bin)) seen.set(spec.bin, []);
    seen.get(spec.bin).push(lang);
  }

  const results = await Promise.all(
    [...seen.entries()].map(async ([bin, langs]) => {
      try {
        await execAsync(`command -v ${bin}`, { timeout: 5000 });
        return { bin, langs, ok: true };
      } catch {
        return { bin, langs, ok: false };
      }
    })
  );

  const lines = results
    .sort((a, b) => a.bin.localeCompare(b.bin))
    .map(r => `${r.ok ? '✅' : '❌'} ${r.bin.padEnd(10)} → ${r.langs.join(', ')}`);

  return `Code runtimes detected on this machine:\n${lines.join('\n')}\n\n` +
    `Languages with ❌ will fail in code_execute until that interpreter/compiler is installed on the host.`;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

export const CODE_TOOLS = [
  {
    name: 'code_execute',
    declaration: {
      name: 'code_execute',
      description:
        'Write real source code to disk and execute it for real — supports ' +
        `${SUPPORTED.length} languages: ${SUPPORTED.join(', ')}. ` +
        'Compiles C/C++/Rust/Java/C# automatically before running. Captures real stdout, stderr, and ' +
        'exit/compile errors, then cleans up temp files. Use this (not bash_execute) whenever the task is ' +
        '"write code that does X and run it." For Java, name the public class "Main" unless your code already ' +
        'declares its own public class — Jojo auto-detects it. Call code_environment_check first if unsure ' +
        'whether a given language is installed on this machine.',
      parameters: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            description: `One of: ${SUPPORTED.join(', ')}`,
          },
          code: { type: 'string', description: 'Full source code to write and run' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command-line arguments passed to the program (optional)',
          },
          stdin:      { type: 'string', description: "Text piped to the program's stdin (optional)" },
          timeout_ms: { type: 'number', description: 'Override execution timeout in ms (optional)' },
        },
        required: ['language', 'code'],
      },
    },
    async execute({ language, code, args, stdin, timeout_ms }) {
      return runScript({ language, code, args, stdin, timeoutMs: timeout_ms });
    },
  },

  {
    name: 'code_environment_check',
    declaration: {
      name: 'code_environment_check',
      description:
        'Check which language interpreters/compilers are actually installed on this host machine. ' +
        'Run this before relying on code_execute for a less-common language, or when a user asks ' +
        '"what languages can you actually run?"',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return checkEnvironment();
    },
  },
];

