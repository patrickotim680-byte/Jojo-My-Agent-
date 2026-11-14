// ── Continuity Tools ──────────────────────────────────────────────────────────
// Explicit, model-callable controls over ContinuityDaemon (src/core/continuity.js).
// Context carries { continuity } — the shared ContinuityDaemon instance —
// injected by the agent, same wiring pattern as { worldModel } in world_tools.js.

export const CONTINUITY_TOOLS = [

  {
    name: 'continuity_status',
    declaration: {
      name: 'continuity_status',
      description:
        'Show cross-device continuity status: every known device (this one and any others that have ' +
        'checked into the shared state file), when each was last seen, what task it was on, whether a ' +
        'handoff is in effect, and when a push notification last went out. Use when the user asks "what\'s ' +
        'this on other devices", "did my phone/desktop get notified", or "who else is working on this".',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { continuity }) {
      if (!continuity) return 'Continuity daemon unavailable.';
      const devices = continuity.listDevices();
      const lines = [`Device: "${continuity.label}" (${continuity.deviceId}).`, ''];
      devices.forEach(d => {
        lines.push(`${d.self ? '→ ' : '  '}${d.label}${d.self ? ' (this device)' : ''} — ${d.status}, last seen ${d.lastSeenAt}` +
          `${d.locationTag ? `, tagged "${d.locationTag}"` : ''}` +
          `${d.activeTaskTitle ? `, on task "${d.activeTaskTitle}"` : ''}`);
      });
      if (continuity.state.handoff) {
        lines.push('', `Handoff: "${continuity.state.handoff.label}" marked itself active at ${continuity.state.handoff.since}.`);
      }
      return lines.join('\n');
    },
  },

  {
    name: 'continuity_handoff',
    declaration: {
      name: 'continuity_handoff',
      description:
        'Mark THIS device as the one actively being used right now — advisory only, not a hard lock (see ' +
        'continuity.js HONEST LIMITS). Use when the user says something like "I\'m switching to my laptop/' +
        'phone now" or "this is the active device". Other devices reading the shared state file will see ' +
        'it was handed off here on their next check.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional new label for this device (e.g. "work laptop"). Omit to keep the current label.' },
        },
      },
    },
    async execute({ label }, context) {
      if (!context.continuity) return 'Continuity daemon unavailable.';
      return context.continuity.handoff(context, { label });
    },
  },

  {
    name: 'continuity_push_now',
    declaration: {
      name: 'continuity_push_now',
      description:
        'Send a push notification right now, regardless of whether another device looks active — use when ' +
        'the user explicitly asks to be notified/texted/pinged about something ("let me know when this is ' +
        'done", "text me the result"), as opposed to the automatic push that only fires when no device has ' +
        'been seen recently. Delivers via whatever is configured (webhook URL, WhatsApp if connected) and ' +
        'always narrates locally too. Returns exactly what did and didn\'t deliver — never claims success it ' +
        'didn\'t confirm.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The notification text to send.' },
        },
        required: ['message'],
      },
    },
    async execute({ message }, context) {
      if (!context.continuity) return 'Continuity daemon unavailable.';
      const { delivered, failed } = await context.continuity.push(message, context);
      return `Push sent. Delivered via: ${delivered.join(', ')}.` +
        (failed.length ? ` Failed: ${failed.join(', ')}.` : '') +
        (delivered.length <= 1 ? ' (Only local terminal narration — set JOJO_CONTINUITY_PUSH_URL, or connect the WhatsApp channel, to actually reach another device.)' : '');
    },
  },

  {
    name: 'set_presence_location',
    declaration: {
      name: 'set_presence_location',
      description:
        'Tag THIS device with a human-named location ("bedroom", "office", "living room") so ' +
        'continuity_status can show where each known device physically is. Set once — ask the user what ' +
        'to call this device\'s location if they haven\'t said, rather than guessing from wifi/sensors. ' +
        'Not auto-detected on purpose: a wrong guess here is worse than just asking.',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string', description: 'e.g. "bedroom", "office", "kitchen"' } },
        required: ['location'],
      },
    },
    async execute({ location }, context) {
      if (!context.continuity) return 'Continuity daemon unavailable.';
      context.continuity.setLocationTag(location);
      await context.continuity.tick(context); // persist immediately rather than waiting for the next scheduled tick
      return `This device is now tagged "${location}". Other devices reading the shared state file will see it.`;
    },
  },

];

