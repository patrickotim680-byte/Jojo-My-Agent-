// ── Computer Use Tools ───────────────────────────────────────────────────────
// Exposes ComputerUseEngine (src/core/computer.js) as callable tools. Context
// carries { computerUse } — shared instance — injected by the agent, same
// wiring pattern as { browser } in browser_tools.js. Unlike browser_act,
// EVERY action here is gated — see computer.js's file header for why real
// OS-level control has no equivalent to browser.js's irreversibility
// classifier or rollout_sandbox.js's disposable fork.

export const COMPUTER_TOOLS = [

  {
    name: 'computer_click',
    declaration: {
      name: 'computer_click',
      description:
        'Propose clicking somewhere on the user\'s REAL, LIVE desktop screen — any application, not just a ' +
        'browser. Takes a screenshot, asks a vision model to locate the described target, and queues the click ' +
        'for approval. NEVER executes immediately — there is no irreversibility classifier for this tool the way ' +
        'browser_act has one; every single computer_click always requires apply_computer_action with ' +
        'human_approved=true afterward, no exceptions. Show the human the target coordinate and the model\'s ' +
        'stated reasoning before asking them to approve.',
      parameters: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description: 'Plain description of what to click, e.g. "the blue Save button in the top right" or "the Chrome icon in the taskbar". Be as specific as the screen content allows.',
          },
        },
        required: ['instruction'],
      },
    },
    async execute({ instruction }, { computerUse }) {
      if (!computerUse) return 'Computer-use engine unavailable.';
      try {
        return await computerUse.propose({ kind: 'click', instruction });
      } catch (err) {
        return `Error proposing computer-use click: ${err.message}`;
      }
    },
  },

  {
    name: 'computer_type',
    declaration: {
      name: 'computer_type',
      description:
        'Propose clicking a field on the user\'s REAL, LIVE desktop screen and typing text into it. Same ' +
        'unconditional approval gate as computer_click — nothing is typed until apply_computer_action is called ' +
        'with human_approved=true. The exact text is included in the approval prompt so the human sees it before ' +
        'approving — do not use this to type credentials or secrets you don\'t want echoed back for review.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Plain description of which field to click into first, e.g. "the search box at the top of the page".' },
          text: { type: 'string', description: 'The exact text to type after clicking into the field.' },
        },
        required: ['instruction', 'text'],
      },
    },
    async execute({ instruction, text }, { computerUse }) {
      if (!computerUse) return 'Computer-use engine unavailable.';
      try {
        return await computerUse.propose({ kind: 'type', instruction, text });
      } catch (err) {
        return `Error proposing computer-use type action: ${err.message}`;
      }
    },
  },

  {
    name: 'computer_key',
    declaration: {
      name: 'computer_key',
      description:
        'Propose pressing a single named key (e.g. "Enter", "Escape", "Tab") on the user\'s REAL, LIVE desktop. ' +
        'No vision lookup needed since there\'s no target to locate — but still queued behind the same ' +
        'unconditional approval gate as computer_click/computer_type.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'nut-js key name, e.g. "Enter", "Escape", "Tab", "Backspace".' },
        },
        required: ['key'],
      },
    },
    async execute({ key }, { computerUse }) {
      if (!computerUse) return 'Computer-use engine unavailable.';
      try {
        return await computerUse.propose({ kind: 'key', key });
      } catch (err) {
        return `Error proposing computer-use key action: ${err.message}`;
      }
    },
  },

  {
    name: 'apply_computer_action',
    declaration: {
      name: 'apply_computer_action',
      description:
        'Execute a pending computer-use action for real — actually moves the mouse/clicks/types on the user\'s ' +
        'live desktop. HARD RULE, same as apply_browser_action/apply_verified_fix: always show the human the ' +
        'queued target/text first, and only call this with human_approved=true after they explicitly agree. ' +
        'Never call it speculatively. There is no sandbox behind this action kind — see computer.js HONEST ' +
        'LIMITS — this is the real, first, only attempt.',
      parameters: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', description: 'The pending action id from computer_click/computer_type/computer_key\'s output or list_pending_computer_actions.' },
          human_approved: { type: 'boolean', description: 'Must be true.' },
        },
        required: ['approval_id', 'human_approved'],
      },
    },
    async execute({ approval_id, human_approved }, { computerUse }) {
      if (!computerUse) return 'Computer-use engine unavailable.';
      return computerUse.applyPendingAction(approval_id, !!human_approved);
    },
  },

  {
    name: 'dismiss_computer_action',
    declaration: {
      name: 'dismiss_computer_action',
      description: 'Discard a pending computer-use action without executing it. Safe without approval.',
      parameters: {
        type: 'object',
        properties: { approval_id: { type: 'string', description: 'The pending action id to discard.' } },
        required: ['approval_id'],
      },
    },
    async execute({ approval_id }, { computerUse }) {
      if (!computerUse) return 'Computer-use engine unavailable.';
      return computerUse.dismissPendingAction(approval_id);
    },
  },

  {
    name: 'list_pending_computer_actions',
    declaration: {
      name: 'list_pending_computer_actions',
      description: 'List every computer-use action currently queued and awaiting human_approved=true.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { computerUse }) {
      if (!computerUse) return 'Computer-use engine unavailable.';
      return computerUse.listPending();
    },
  },

];

