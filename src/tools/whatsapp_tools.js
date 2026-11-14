// ── WhatsApp Push Tools ──────────────────────────────────────────────────────
// Lets a running agent proactively send YOU a WhatsApp message or a real
// spoken voice note — e.g. "let me know the moment the build finishes", or
// the self-healing loop (healer.js) narrating a fix it just verified —
// instead of only ever replying inside a WhatsApp turn.
//
// Only works if scripts/whatsapp_channel.js is the process currently running
// this agent — it attaches agent.whatsapp + agent.whatsappAllowedJid after
// connecting (see that file). Running via `npm start` (plain terminal) or
// the email channel, context.whatsapp is undefined and both tools say so
// instead of failing silently.
//
// Both tools always send to agent.whatsappAllowedJid — the SAME number
// whatsapp_channel.js already gates incoming messages to. There is no
// parameter for a different recipient; this cannot be used to message
// anyone else.

export const WHATSAPP_TOOLS = [

  {
    name: 'send_whatsapp_message',
    declaration: {
      name: 'send_whatsapp_message',
      description:
        'Send yourself a WhatsApp text message right now, outside the normal reply flow — for a proactive ' +
        'update (a build finished, a world_model watch fired, a long background task completed), not for a ' +
        'routine reply to something you just asked in chat.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message to send.' },
        },
        required: ['text'],
      },
    },
    async execute({ text }, { whatsapp, whatsappAllowedJid }) {
      if (!whatsapp || !whatsappAllowedJid) {
        return 'WhatsApp channel is not connected — run `npm run whatsapp` as a separate process for this tool to work.';
      }
      await whatsapp.sendText(whatsappAllowedJid, text);
      return 'Sent.';
    },
  },

  {
    name: 'send_whatsapp_voice_note',
    declaration: {
      name: 'send_whatsapp_voice_note',
      description:
        'Send yourself a real spoken WhatsApp voice note (male TTS voice), instead of or alongside text — use ' +
        'for anything worth hearing rather than reading, e.g. a status update while you\'re away from a screen. ' +
        'Keep it to a few sentences — this is meant to sound like a short voicemail, not be read a full report. ' +
        'In a WhatsApp turn with JOJO_WHATSAPP_REPLY_MODE=auto, this is also how YOU decide a reply is worth ' +
        'hearing — call it whenever you judge the answer deserves one; the plain-text reply still goes out ' +
        'either way, this just adds the spoken version.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What JOJO should say.' },
        },
        required: ['text'],
      },
    },
    async execute({ text }, { whatsapp, whatsappAllowedJid, voiceState }) {
      if (!whatsapp || !whatsappAllowedJid) {
        return 'WhatsApp channel is not connected — run `npm run whatsapp` as a separate process for this tool to work.';
      }
      await whatsapp.sendVoiceNote(whatsappAllowedJid, text);
      // Tells scripts/whatsapp_channel.js's `auto` reply mode a voice note
      // already went out for this turn (you asked for one yourself), so it
      // doesn't synthesize a second one from the plain-text reply.
      if (voiceState) voiceState.sent = true;
      return 'Voice note sent.';
    },
  },

];

