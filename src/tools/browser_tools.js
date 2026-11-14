// ── Browser Tools ─────────────────────────────────────────────────────────────
// Exposes BrowserSessionManager and ParallelBrowserExplorer (src/core/browser.js,
// src/core/browser_explorer.js) as callable tools. Context carries { browser,
// browserExplorer } — shared instances — injected by the agent, same wiring
// pattern as { swarm }/{ healer }/{ synthesis } elsewhere. browser_act is the
// human-gated side for irreversible actions, mirroring apply_verified_fix /
// apply_synthesis_proposal.

function fmtExtract(x) {
  const lines = [
    `${x.title} — ${x.url}`,
    `Grounding agreement: ${x.groundingAgreement}%` +
      (x.groundingDisagreements.length ? ` (${x.groundingDisagreements.length} disagreement(s) — see below)` : ''),
    '',
    'Interactive elements:',
    ...x.interactiveElements.map(e =>
      `  [${e.id}] ${e.role}${e.type ? `/${e.type}` : ''} "${e.name}"${e.enabled ? '' : ' (disabled)'}${e.value ? ` = "${e.value}"` : ''}`),
    '',
    'Vision summary:',
    x.visionSummary,
  ];
  if (x.groundingDisagreements.length) {
    lines.push('', 'Grounding disagreements (verify before acting on these):');
    for (const d of x.groundingDisagreements) lines.push(`  [${d.id}] ${d.role} "${d.name}" — ${d.note}`);
  }
  return lines.join('\n');
}

export const BROWSER_TOOLS = [

  {
    name: 'browser_open_session',
    declaration: {
      name: 'browser_open_session',
      description:
        'Open a new isolated browser session (its own browser context/tab) and optionally navigate to a ' +
        'URL. Returns a session_id — pass this to every other browser_* tool call. Sessions persist across ' +
        'multiple tool calls in this conversation until explicitly closed.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Optional URL to navigate to immediately.' } },
      },
    },
    async execute({ url }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      try {
        const sessionId = await browser.openSession(url);
        return `Opened session ${sessionId}${url ? ` at ${url}` : ''}.`;
      } catch (err) {
        return `Error opening browser session: ${err.message}`;
      }
    },
  },

  {
    name: 'browser_navigate',
    declaration: {
      name: 'browser_navigate',
      description: 'Navigate an existing session to a new URL.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id from browser_open_session.' },
          url: { type: 'string', description: 'URL to navigate to.' },
        },
        required: ['session_id', 'url'],
      },
    },
    async execute({ session_id, url }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      try {
        const r = await browser.navigate(session_id, url);
        return `Navigated to ${r.url}`;
      } catch (err) {
        return `Error navigating: ${err.message}`;
      }
    },
  },

  {
    name: 'browser_extract',
    declaration: {
      name: 'browser_extract',
      description:
        'Dual-grounded read of the current page: a real DOM scan of every visible interactive element ' +
        '(with a stable id you use in browser_act) CROSS-CHECKED against an independent vision-model read of ' +
        'a screenshot. Disagreements between the two (an element the DOM calls visible that the screenshot ' +
        'read never mentions — often a covered/off-screen/stale element) are flagged explicitly. Costs one ' +
        'real model call with an image — do not call this in a tight loop; re-extract only after an action ' +
        'that plausibly changed the page.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id from browser_open_session.' },
          focus: { type: 'string', description: 'Optional — what to pay particular attention to in the vision read.' },
        },
        required: ['session_id'],
      },
    },
    async execute({ session_id, focus }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      try {
        const x = await browser.extract(session_id, { focus });
        return fmtExtract(x);
      } catch (err) {
        return `Error extracting page: ${err.message}`;
      }
    },
  },

  {
    name: 'browser_list_elements',
    declaration: {
      name: 'browser_list_elements',
      description: 'Cheaper than browser_extract — DOM-only list of currently visible interactive elements and their ids, no vision pass, no cross-check. Use when you just need element ids and already trust the page hasn\'t changed since your last browser_extract.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Session id from browser_open_session.' } },
        required: ['session_id'],
      },
    },
    async execute({ session_id }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      try {
        const elements = await browser._scanInteractive(session_id);
        const visible = elements.filter(e => e.visible);
        if (!visible.length) return 'No visible interactive elements found.';
        return visible.map(e =>
          `[${e.id}] ${e.role}${e.type ? `/${e.type}` : ''} "${e.name}"${e.enabled ? '' : ' (disabled)'}`
        ).join('\n');
      } catch (err) {
        return `Error listing elements: ${err.message}`;
      }
    },
  },

  {
    name: 'browser_act',
    declaration: {
      name: 'browser_act',
      description:
        'Act on an element: click, fill (type text), or select (choose a dropdown option). Every action is ' +
        'classified reversible/irreversible BEFORE running. Reversible actions (most navigation clicks, non-' +
        'destructive toggles) execute immediately. Irreversible actions (submit, pay, delete, confirm, ' +
        'checkout, transfer, and similar) are NEVER executed directly — this returns a pending approval id ' +
        'plus a dry-run prediction (the exact form data that would be sent) instead. You must show that ' +
        'prediction to the human and only call apply_browser_action with human_approved=true after they ' +
        'explicitly agree. If the target element\'s id has gone stale (page re-rendered since your last ' +
        'extract), this self-heals by re-locating the closest matching element by role+name — pass a ' +
        'logical_name so healing (and its persistent history) is meaningful across runs.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id from browser_open_session.' },
          type: { type: 'string', enum: ['click', 'fill', 'select'], description: 'Action type.' },
          target_id: { type: 'string', description: 'Element id from browser_extract/browser_list_elements, e.g. "jj-3".' },
          role: { type: 'string', description: 'Fallback if target_id is stale/unknown — expected role (e.g. "button", "input").' },
          name: { type: 'string', description: 'Fallback if target_id is stale/unknown — expected accessible name/label text.' },
          logical_name: { type: 'string', description: 'A short stable label for this target (e.g. "submit button", "email field") — enables persistent self-healing history across runs on this domain.' },
          value: { type: 'string', description: 'Text to type (for fill) or option value (for select).' },
        },
        required: ['session_id', 'type'],
      },
    },
    async execute({ session_id, type, target_id, role, name, logical_name, value }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      try {
        const result = await browser.act(session_id, {
          type, value,
          target: { id: target_id, role, name, logicalName: logical_name },
        });
        if (result.pending) {
          return `${result.summary}\n\nDry-run prediction:\n${JSON.stringify(result.dryRun.prediction, null, 2)}`;
        }
        return `${result.executed}${result.healed ? ' (target was self-healed — original id had gone stale)' : ''}`;
      } catch (err) {
        return `Error performing action: ${err.message}`;
      }
    },
  },

  {
    name: 'apply_browser_action',
    declaration: {
      name: 'apply_browser_action',
      description:
        'Execute a browser action that was classified irreversible and is awaiting approval. HARD RULE, ' +
        'same as apply_verified_fix/apply_synthesis_proposal: always show the human the dry-run prediction ' +
        '(exact form data / target) first, and only call this with human_approved=true after they explicitly ' +
        'agree. Never call it speculatively.',
      parameters: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', description: 'The pending action id from browser_act\'s output or list_pending_browser_actions.' },
          human_approved: { type: 'boolean', description: 'Must be true.' },
        },
        required: ['approval_id', 'human_approved'],
      },
    },
    async execute({ approval_id, human_approved }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      return browser.applyPendingAction(approval_id, !!human_approved);
    },
  },

  {
    name: 'dismiss_browser_action',
    declaration: {
      name: 'dismiss_browser_action',
      description: 'Discard a pending irreversible browser action without executing it. Safe without approval.',
      parameters: {
        type: 'object',
        properties: { approval_id: { type: 'string', description: 'The pending action id to discard.' } },
        required: ['approval_id'],
      },
    },
    async execute({ approval_id }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      return browser.dismissPendingAction(approval_id);
    },
  },

  {
    name: 'list_pending_browser_actions',
    declaration: {
      name: 'list_pending_browser_actions',
      description: 'List every irreversible browser action currently awaiting human approval.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      const all = browser.listPendingActions();
      if (!all.length) return 'No pending browser actions.';
      return all.map(p => `[${p.id}] ${p.action.type} on ${p.target.role} "${p.target.name}" (session ${p.sessionId})`).join('\n');
    },
  },

  {
    name: 'browser_close_session',
    declaration: {
      name: 'browser_close_session',
      description: 'Close a browser session and free its resources.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Session id to close.' } },
        required: ['session_id'],
      },
    },
    async execute({ session_id }, { browser }) {
      if (!browser) return 'Browser engine unavailable.';
      return browser.closeSession(session_id);
    },
  },

  {
    name: 'browser_explore_parallel',
    declaration: {
      name: 'browser_explore_parallel',
      description:
        'For AMBIGUOUS browsing goals where the right path isn\'t known upfront (e.g. "find the cheapest ' +
        'total price", "figure out which signup tier fits", "locate the refund policy" on an unfamiliar ' +
        'site): opens several isolated browser sessions in parallel, each pursuing a different named ' +
        'hypothesis/path toward the goal, then arbitrates which one actually got there. Far more expensive ' +
        'than a single browser_open_session + manual navigation — reserve it for genuinely ambiguous goals, ' +
        'not routine single-path browsing. Irreversible actions inside any branch still require the normal ' +
        'human-approval gate; parallelism never bypasses it.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Starting URL every branch begins from.' },
          goal: { type: 'string', description: 'What counts as success, stated concretely, e.g. "find the lowest total price including shipping".' },
          hypotheses: {
            type: 'array',
            description: 'Up to 5 divergent paths to try in parallel. Defaults to a generic primary-nav + search pair if omitted.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short label, e.g. "category-filter", "search-bar", "sort-by-price".' },
                instruction: { type: 'string', description: 'Specific instructions for exactly what this branch should try.' },
              },
              required: ['name', 'instruction'],
            },
          },
        },
        required: ['url', 'goal'],
      },
    },
    async execute({ url, goal, hypotheses }, context) {
      if (!context.browserExplorer) return 'Parallel browser explorer unavailable.';
      try {
        return await context.browserExplorer.explore({ url, goal, hypotheses, sharedContext: context });
      } catch (err) {
        return `Error running parallel exploration: ${err.message}`;
      }
    },
  },

];

