# Browser Automation (Dual-Grounded, Self-Healing, Irreversibility-Gated)

`src/core/browser.js` + `src/core/browser_explorer.js` implement a browser automation engine
combining four mechanisms no current browser-using agent (Operator, Claude computer-use loops,
browser-use, plain Playwright/Puppeteer wrappers) combines.

## Why this exists

Every existing browser agent grounds its understanding of a page **one way per step** — either a
DOM/accessibility read OR a screenshot read — and acts straight off that single read. This engine
does four things differently:

1. **Dual-ground verification.** `browser_extract` does BOTH a real DOM scan of every visible
   interactive element AND an independent vision-model read of a screenshot, then cross-checks
   them. An element the DOM calls visible/enabled that the vision pass never mentions — covered by
   an overlay, off-screen despite CSS visibility, a stale cached layout — is surfaced as a
   `groundingDisagreement` instead of silently trusted.
2. **Self-healing selectors with a persistent drift ledger.** Actions target a logical name
   ("submit button"), not a brittle CSS selector. If a previous element id has gone stale, the
   engine re-scans and picks the closest (role, accessible-name) match, then logs the heal to
   `SiteLedger` (`site_ledger.js`, same pattern as `skill_ledger.js`) so future runs on that domain
   start from the healed target — and a target that keeps drifting gets flagged unstable.
3. **Irreversibility classification + counterfactual dry-run.** Every action is classified
   reversible/irreversible before it runs. An irreversible one (submit, pay, delete, confirm,
   checkout, transfer...) is never executed directly — the engine reads the target's enclosing
   form, method, action URL, and every field's current value without triggering it, and that
   prediction becomes a pending proposal gated behind `human_approved=true`, the same pattern
   `apply_verified_fix` / `apply_synthesis_proposal` already use.
4. **Parallel divergent tab exploration.** `browser_explore_parallel` (`browser_explorer.js`) opens
   several isolated sessions for different hypotheses about an ambiguous goal, runs them
   concurrently via `SwarmManager` (the same mechanism `synthesis.js` uses for code branches,
   applied to navigation branches), then arbitrates which one actually reached the goal.
   Irreversible actions inside any branch still go through the same human gate — parallelism never
   bypasses it.

## Tools

- `browser_open_session(url?)` — open an isolated session, returns `session_id`.
- `browser_navigate(session_id, url)`
- `browser_extract(session_id, focus?)` — dual-grounded page read (costs one vision model call).
- `browser_list_elements(session_id)` — cheaper DOM-only element list, no vision pass.
- `browser_act(session_id, type, target_id?, role?, name?, logical_name?, value?)` — click/fill/select;
  self-heals stale targets; returns a pending approval instead of executing if irreversible.
- `apply_browser_action(approval_id, human_approved)` / `dismiss_browser_action(approval_id)` /
  `list_pending_browser_actions()` — human-facing side of the irreversibility gate.
- `browser_close_session(session_id)`
- `browser_explore_parallel(url, goal, hypotheses?)` — parallel divergent exploration + arbitration.

## Setup

Requires the `playwright` package (added to `package.json`) and a Chromium install:

```
npm install
npx playwright install chromium
```

Set `JOJO_BROWSER_HEADLESS=false` in `.env` to watch sessions run instead of headless.

## Honest limits

- The "DOM ground" is a direct `page.evaluate()` scan of common interactive selectors + computed
  visibility, not Playwright's deprecated `page.accessibility` API. Solid and version-stable, but a
  heuristic — screen-reader-only patterns (aria-live regions, complex composite widgets) may be
  under-detected.
- The vision pass costs one real model call with an image per `browser_extract` — don't call it in
  a tight loop; re-extract only after an action that plausibly changed the page.
- Irreversibility classification is a heuristic (keyword list + form-context check), not a
  guarantee. When genuinely unsure it's deliberately biased toward the human-gated path.
- The dry-run's form snapshot is read-only (`element.value` at read time) — it does not execute any
  client-side JS the page might run on submit, so it's a prediction, not a proof.
- `browser_explore_parallel`'s arbitration is a single model call over a text summary of each
  branch's final state — it does not itself re-verify anything on the page.

