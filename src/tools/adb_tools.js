// ── ADB Control Tools ────────────────────────────────────────────────────────
// Exposes AdbControlEngine (src/core/adb.js) — real, system-wide phone
// control via ADB self-connected over Termux. Context carries { adbControl },
// same injection pattern as { computerUse } in computer_tools.js.
//
// Read-only tools (adb_status, adb_screenshot, adb_dump_ui, adb_current_app)
// run immediately — nothing to approve, they don't change device state.
// State-changing tools (tap/swipe/type/key/launch) ALWAYS queue for approval,
// same unconditional gate as computer_tools.js — no exceptions.

export const ADB_TOOLS = [

  {
    name: 'adb_status',
    declaration: {
      name: 'adb_status',
      description: 'Check whether ADB is connected to the real device. Always safe to call, no approval needed.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      return adbControl.status();
    },
  },

  {
    name: 'adb_screenshot',
    declaration: {
      name: 'adb_screenshot',
      description:
        'Take a real screenshot of the phone\'s current screen right now via ADB. Returns a local file path — ' +
        'follow up with vision_analyze on that path to actually see what\'s on screen before proposing a tap/swipe/type.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      const res = await adbControl.screenshot();
      return res.ok ? `Screenshot saved to ${res.path}` : `Screenshot failed: ${res.error}`;
    },
  },

  {
    name: 'adb_dump_ui',
    declaration: {
      name: 'adb_dump_ui',
      description:
        'Read the current screen\'s element tree via ADB (uiautomator dump) — text labels, class names, and center ' +
        'coordinates for clickable/text elements. Use this INSTEAD of guessing pixel coordinates from a screenshot ' +
        'alone — it tells you exactly where each visible element actually is.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      const res = await adbControl.dumpUi();
      if (!res.ok) return `UI dump failed: ${res.error}`;
      if (res.elements.length === 0) return 'UI dump succeeded but found no labeled/clickable elements on screen.';
      return res.elements.map(e => `"${e.text}" (${e.className}${e.clickable ? ', clickable' : ''}) @ [${e.center[0]}, ${e.center[1]}]`).join('\n');
    },
  },

  {
    name: 'adb_current_app',
    declaration: {
      name: 'adb_current_app',
      description: 'Get the package/activity currently in the foreground on the real device.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      const res = await adbControl.currentApp();
      return res.ok ? res.raw : `Failed: ${res.error}`;
    },
  },

  {
    name: 'propose_adb_tap',
    declaration: {
      name: 'propose_adb_tap',
      description:
        'Propose a real tap at exact coordinates on the phone screen — get them from adb_dump_ui, not a guess. ' +
        'ALWAYS queued for approval, never executes immediately.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate (pixels)' },
          y: { type: 'number', description: 'Y coordinate (pixels)' },
        },
        required: ['x', 'y'],
      },
    },
    async execute({ x, y }, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      try { return await adbControl.propose({ kind: 'tap', x, y }); }
      catch (err) { return `Error proposing tap: ${err.message}`; }
    },
  },

  {
    name: 'propose_adb_swipe',
    declaration: {
      name: 'propose_adb_swipe',
      description: 'Propose a real swipe gesture from one point to another. ALWAYS queued for approval.',
      parameters: {
        type: 'object',
        properties: {
          x1: { type: 'number' }, y1: { type: 'number' },
          x2: { type: 'number' }, y2: { type: 'number' },
          duration_ms: { type: 'number', description: 'Swipe duration, default 300' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
    async execute({ x1, y1, x2, y2, duration_ms }, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      try { return await adbControl.propose({ kind: 'swipe', x1, y1, x2, y2, durationMs: duration_ms }); }
      catch (err) { return `Error proposing swipe: ${err.message}`; }
    },
  },

  {
    name: 'propose_adb_type',
    declaration: {
      name: 'propose_adb_type',
      description:
        'Propose typing real text into whatever field is currently focused on the phone (tap the field first via ' +
        'propose_adb_tap if needed). ALWAYS queued for approval — the exact text is shown to the human before ' +
        'they approve, so don\'t use this for anything you don\'t want echoed back for review.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Exact text to type' } },
        required: ['text'],
      },
    },
    async execute({ text }, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      try { return await adbControl.propose({ kind: 'type', text }); }
      catch (err) { return `Error proposing type action: ${err.message}`; }
    },
  },

  {
    name: 'propose_adb_key',
    declaration: {
      name: 'propose_adb_key',
      description:
        'Propose a single Android key event — e.g. "KEYCODE_BACK", "KEYCODE_HOME", "KEYCODE_ENTER", ' +
        '"KEYCODE_VOLUME_UP". ALWAYS queued for approval.',
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Android KEYCODE name' } },
        required: ['key'],
      },
    },
    async execute({ key }, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      try { return await adbControl.propose({ kind: 'key', key }); }
      catch (err) { return `Error proposing key action: ${err.message}`; }
    },
  },

  {
    name: 'propose_adb_launch_app',
    declaration: {
      name: 'propose_adb_launch_app',
      description: 'Propose launching an installed app by its package name (e.g. "com.whatsapp"). ALWAYS queued for approval.',
      parameters: {
        type: 'object',
        properties: { package: { type: 'string', description: 'Android package name' } },
        required: ['package'],
      },
    },
    async execute({ package: pkg }, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      try { return await adbControl.propose({ kind: 'launch_app', package: pkg }); }
      catch (err) { return `Error proposing app launch: ${err.message}`; }
    },
  },

  {
    name: 'apply_adb_action',
    declaration: {
      name: 'apply_adb_action',
      description:
        'Execute a pending ADB action for real — actually taps/swipes/types/presses/launches on the live device. ' +
        'HARD RULE, same as apply_computer_action: only call with human_approved=true after the human has ' +
        'explicitly agreed to the specific queued action. Never call speculatively.',
      parameters: {
        type: 'object',
        properties: {
          approval_id: { type: 'string' },
          human_approved: { type: 'boolean', description: 'Must be true.' },
        },
        required: ['approval_id', 'human_approved'],
      },
    },
    async execute({ approval_id, human_approved }, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      return adbControl.applyPendingAction(approval_id, !!human_approved);
    },
  },

  {
    name: 'dismiss_adb_action',
    declaration: {
      name: 'dismiss_adb_action',
      description: 'Discard a pending ADB action without executing it. Safe without approval.',
      parameters: {
        type: 'object',
        properties: { approval_id: { type: 'string' } },
        required: ['approval_id'],
      },
    },
    async execute({ approval_id }, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      return adbControl.dismissPendingAction(approval_id);
    },
  },

  {
    name: 'list_pending_adb_actions',
    declaration: {
      name: 'list_pending_adb_actions',
      description: 'List every ADB action currently queued and awaiting human_approved=true.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { adbControl }) {
      if (!adbControl) return 'ADB control engine unavailable.';
      return adbControl.listPending();
    },
  },

];

