# Build System

Jojo's answer to "just write me a full app" is not "generate a lot of files
and hope." It's a small, real pipeline:

**plan → scaffold → verify → implement incrementally → verify again → ship**

Nothing new is simulated. `scaffold_project` writes real files to real disk.
`verify_project` actually shells out to `npm install`, `tsc`, `eslint`,
`vite build`, `pytest`, etc. and reports exactly what happened. The point is
to close the gap between "the code looks right" and "the code runs" — the
same gap that produces most of the broken output people get from agents
that only ever write code and never run it end-to-end.

## What's new

| File | Purpose |
|---|---|
| `src/core/builder.js` | Stack templates + the install/build/test pipeline runner |
| `src/tools/build_tools.js` | Tool wrappers the model actually calls |

Five tools, registered in `src/tools/registry.js` alongside everything else:

- **`list_project_stacks`** — see what's supported.
- **`scaffold_project`** — generate a real starting project for a stack
  (`react-vite`, `nextjs`, `node-express`, `python-fastapi`, `static`).
  Every scaffold ships with correct, pinned-enough dependency versions and
  one real passing test, so Jojo isn't retyping config files from memory
  each time (that's where a lot of "silently wrong" boilerplate comes from).
- **`detect_project_stack`** — figure out the stack of a project Jojo didn't
  scaffold itself (uploaded, or already in progress).
- **`verify_project`** — the actual truth-check: installs deps, type-checks,
  lints, builds, and tests, and returns a structured report of exactly which
  steps passed/failed/were skipped, with real captured output for anything
  that failed. Supports `custom_steps` for stacks with no built-in template.
- **`reset_build_iterations`** — clears the per-directory fix-loop counter.

## Why a fix-loop counter

`verify_project` tracks how many times it's been called against the same
`target_dir` without a clean pass. Past a cap (default 8) it starts telling
Jojo, explicitly, to stop guessing and either think harder about the actual
root cause or surface the blocker to you — instead of quietly looping edits
forever or (worse) giving up silently and declaring the project done anyway.

## Honest limits

- Verification only works if the target machine actually has the toolchain
  installed (node/npm, python3, etc). A missing binary is reported as a
  failed step with the real error, not swallowed.
- "Verified" means the defined pipeline succeeded on this machine right now.
  It is not a formal proof of correctness, and Jojo is expected to say so
  rather than oversell a green build — e.g. a passing build/lint/test cycle
  doesn't guarantee correct UX or handle every edge case a human tester would.
- Built-in templates cover five common stacks. Anything else (Rails, Go
  services, mobile, etc.) still gets a real, honest verify — you just supply
  `custom_steps` since there's no canned template for it yet. Extending
  `STACKS` in `src/core/builder.js` with more templates is a normal, additive
  change (same shape as the existing five).

## Extending it

Adding a new stack template is the main way to grow this. In
`src/core/builder.js`, add an entry to `STACKS` with:

```js
'my-stack': {
  label: 'Human-readable description',
  files(name, opts) { return { 'relative/path': 'file contents', ... }; },
  steps(opts) { return [{ name: 'install', cmd: '...', required: true }, ...]; },
}
```

`detectStack()` can also be taught to recognize it (e.g. a marker config
file) so `verify_project` auto-detects it on existing projects too.

