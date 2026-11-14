import {
  listStacks,
  scaffoldProject,
  detectStack,
  runVerification,
} from '../core/builder.js';

// ── Fix-loop iteration tracking ─────────────────────────────────────────────
// Keyed by targetDir, in-process only (resets when Jojo restarts). Purpose:
// stop Jojo from silently looping "edit → verify → edit → verify" forever on
// a project that isn't converging. After the cap, verify_project keeps
// working, but the report tells Jojo (and the user) to stop and reassess
// instead of burning more turns on the same wall.
const ITERATION_CAP = 8;
const iterations = new Map(); // targetDir -> count

function bumpIteration(targetDir) {
  const n = (iterations.get(targetDir) || 0) + 1;
  iterations.set(targetDir, n);
  return n;
}

export const BUILD_TOOLS = [

  // ── list_project_stacks ───────────────────────────────────────────────────
  {
    name: 'list_project_stacks',
    declaration: {
      name: 'list_project_stacks',
      description:
        'List the stacks Jojo has a built-in scaffold + verification pipeline for ' +
        '(react-vite, nextjs, node-express, python-fastapi, static). Call this before ' +
        'scaffold_project if unsure which stack key to use, or to decide what to ' +
        'recommend to the user for a given kind of app.',
      parameters: { type: 'object', properties: {} },
    },
    async execute() {
      return JSON.stringify(listStacks(), null, 2);
    },
  },

  // ── scaffold_project ─────────────────────────────────────────────────────
  {
    name: 'scaffold_project',
    declaration: {
      name: 'scaffold_project',
      description:
        'Generate a known-good starting project (package.json, configs, entry files, ' +
        'a real passing test) for a given stack into target_dir. Use this INSTEAD of ' +
        'hand-writing boilerplate config files from memory for a new project — the ' +
        'templates here have working dependency versions and correct config option ' +
        'names, which is where most "silent breakage" in hand-typed scaffolds comes ' +
        'from. After scaffolding, ALWAYS call verify_project before adding features on ' +
        'top — never assume a scaffold works without running it.',
      parameters: {
        type: 'object',
        properties: {
          stack: {
            type: 'string',
            description: 'One of the keys from list_project_stacks (e.g. "react-vite", "nextjs", "node-express", "python-fastapi", "static").',
          },
          target_dir: { type: 'string', description: 'Directory to write the scaffold into.' },
          project_name: { type: 'string', description: 'Name of the project (used in package.json / page titles).' },
          typescript: { type: 'boolean', description: 'For stacks that support a JS/TS choice (react-vite): use TypeScript. Default false.' },
          force: { type: 'boolean', description: 'Write into a non-empty target_dir anyway, overwriting same-named files. Default false.' },
        },
        required: ['stack', 'target_dir'],
      },
    },
    async execute({ stack, target_dir, project_name, typescript, force }) {
      const res = await scaffoldProject({
        stack, targetDir: target_dir, projectName: project_name,
        options: { typescript: !!typescript, force: !!force },
      });
      iterations.delete(target_dir); // fresh scaffold = fresh iteration budget
      return JSON.stringify(res, null, 2);
    },
  },

  // ── detect_project_stack ─────────────────────────────────────────────────
  {
    name: 'detect_project_stack',
    declaration: {
      name: 'detect_project_stack',
      description:
        'Inspect an existing directory (e.g. an uploaded or previously-started project ' +
        'Jojo did not scaffold itself) and guess its stack from config files present, ' +
        'so verify_project knows what pipeline to run. Returns "unknown" if nothing ' +
        'recognizable is found — in that case pass explicit custom_steps to verify_project.',
      parameters: {
        type: 'object',
        properties: { target_dir: { type: 'string', description: 'Directory to inspect.' } },
        required: ['target_dir'],
      },
    },
    async execute({ target_dir }) {
      const stack = await detectStack(target_dir);
      return JSON.stringify({ target_dir, detectedStack: stack });
    },
  },

  // ── verify_project ───────────────────────────────────────────────────────
  {
    name: 'verify_project',
    declaration: {
      name: 'verify_project',
      description:
        'THE core truth-check. Actually installs dependencies, type-checks, lints, ' +
        'builds, and runs tests for a project — and returns a structured, honest ' +
        'report of exactly what passed, what failed, and what was skipped. ' +
        'NEVER tell the user a project "should work" or "is complete" without calling ' +
        'this first and getting ok:true. If it returns ok:false, read the failing ' +
        'step\'s output, fix the actual cause in the code/config, and call this again — ' +
        'do not just re-describe the fix without re-verifying. ' +
        'For a stack without a built-in pipeline (detect_project_stack returns "unknown" ' +
        'or "generic-node"), pass custom_steps describing exactly how to install/build/test it.',
      parameters: {
        type: 'object',
        properties: {
          target_dir: { type: 'string', description: 'Project directory to verify.' },
          stack: {
            type: 'string',
            description: 'Stack key (react-vite, nextjs, node-express, python-fastapi, static) or "auto" to detect. Ignored if custom_steps is given.',
          },
          custom_steps: {
            type: 'array',
            description: 'Override/extend pipeline for a stack with no built-in template: ordered list of {name, cmd, required}.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                cmd: { type: 'string' },
                required: { type: 'boolean', description: 'If false, a failure here is reported but does not halt the pipeline. Default true.' },
              },
              required: ['name', 'cmd'],
            },
          },
          timeout_ms: { type: 'number', description: 'Per-step timeout override in ms (default 180000).' },
        },
        required: ['target_dir'],
      },
    },
    async execute({ target_dir, stack, custom_steps, timeout_ms }) {
      const n = bumpIteration(target_dir);
      const res = await runVerification({
        targetDir: target_dir,
        stack: stack || 'auto',
        customSteps: custom_steps,
        timeoutMs: timeout_ms,
      });
      res.fixIteration = n;
      if (!res.ok && n >= ITERATION_CAP) {
        res.summary = `${res.summary} ⚠ This is fix attempt ${n}/${ITERATION_CAP} on this directory without a clean verify. ` +
          'Stop iterating blindly — re-read the actual error above, form a specific hypothesis about the root cause, ' +
          'and if still stuck after that, explain the blocker to the user instead of continuing to guess.';
      }
      return JSON.stringify(res, null, 2);
    },
  },

  // ── reset_build_iterations ───────────────────────────────────────────────
  {
    name: 'reset_build_iterations',
    declaration: {
      name: 'reset_build_iterations',
      description:
        'Reset the fix-loop iteration counter for a directory (e.g. after the user ' +
        'gives new direction, or a genuinely new problem starts). Rarely needed — ' +
        'mainly for when verify_project has been flagging "too many attempts" and ' +
        'the situation has actually changed.',
      parameters: {
        type: 'object',
        properties: { target_dir: { type: 'string' } },
        required: ['target_dir'],
      },
    },
    async execute({ target_dir }) {
      iterations.delete(target_dir);
      return `Iteration counter reset for ${target_dir}`;
    },
  },
];

