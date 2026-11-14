# Review Board (Multi-Perspective Adversarial Code Review)

`src/core/review_board.js` layers a deeper verification pass onto any diff/branch — most usefully
the winning branch `divergent_synthesis` (`SYNTHESIS_WORKFLOW.md`) already produces, but it works
standalone on any directory.

## Why this exists

A single pass reviewing its own work shares the blind spots it had while writing it. This gets
better verdicts out of the *same* underlying model by changing the process, not the model:

1. **Specialized parallel reviewers** — 4 sub-agents by default (correctness-vs-spec, security,
   performance, maintainability), each scoped to exactly one axis, each with `read_file` /
   `list_directory` / `bash_execute` but **no `write_file`** — structurally incapable of "fixing"
   what they're supposed to critique, not just told not to.
2. **Devil's advocate** — a separate sub-agent argues specifically *for rejecting* the change, using
   the specialists' findings as ammunition, explicitly instructed to say plainly if it can't build a
   credible case rather than manufacture a weak one.
3. **Verdict synthesis** — weighs both into `PASS` / `PASS_WITH_CONCERNS` / `BLOCK` plus a rationale
   and a severity-tagged concern list.

## Tool

- `review_code(dir, task, axes?)` — runs the full 3-phase review, returns the formatted verdict.

## Wiring

Already installed: `review_tools.js` registered in `registry.js`, `ReviewBoard` instantiated in
`agent.js`'s constructor and exposed via `_toolContext()` as `reviewBoard`. No `init()` call and no
ledger — it's stateless beyond the last in-memory run (`reviewBoard.getContext()` in the system
prompt just reports the last verdict).

## Honest limits

- Still one underlying model reviewing itself from different angles, not an independent second
  opinion. Correlated blind spots can survive all four passes — a `PASS` means "passed structured
  adversarial review," not proof of correctness.
- `_parseVerdict()` is a heuristic text parse of the verdict sub-agent's own report. It defaults to
  the more cautious `PASS_WITH_CONCERNS` when the text is ambiguous rather than guessing `PASS`.
- Costs 4+ real sub-agent calls per review — `agent.js`'s system prompt instructs the agent to
  reserve it for changes worth that cost, not routine edits.

