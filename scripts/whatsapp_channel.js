// scripts/whatsapp_channel.js
//
// Lets you chat with JOJO over WhatsApp and get real spoken voice-note
// replies (male TTS voice), not just text. Run with: npm run whatsapp
// See WHATSAPP_CHANNEL.md for full setup.
//
// SECURITY MODEL — read this before you rely on it:
//   Same shape as email_channel.js's, adapted for WhatsApp:
//     1. JOJO_WHATSAPP_ALLOWED_NUMBER — only messages whose SENDER matches
//        this number are looked at at all. Everything else is silently
//        ignored — no reply, so a stranger who somehow reaches this session
//        gets no confirmation JOJO is listening.
//     2. This channel logs into WhatsApp AS YOUR OWN NUMBER (a linked
//        device, same mechanism as WhatsApp Web) — no second SIM needed.
//        Because of that, the only WhatsApp thread where "you" can message
//        "yourself" is the built-in self-chat (WhatsApp → tap your own name
//        at the top of the chat list) — that's the thread JOJO listens on.
//        Gate 1 still applies underneath that; if you'd rather run this on
//        a SEPARATE WhatsApp number instead (recommended if anyone else
//        ever has physical access to your phone), just link this session
//        to that number's WhatsApp instead and leave
//        JOJO_WHATSAPP_ALLOWED_NUMBER set to your real personal number —
//        nothing else in this file changes.
//   On top of both gates, JOJO_WHATSAPP_SAFE_MODE (default ON) disables the
//   riskiest tools for anything triggered over WhatsApp — same denylist
//   idea as SAFE_MODE_BLOCKED_TOOLS in email_channel.js.

import 'dotenv/config';
import chalk from 'chalk';
import { JojoAgent } from '../src/core/agent.js';
import { WhatsAppClient } from '../src/core/whatsapp_client.js';

const { JOJO_WHATSAPP_ALLOWED_NUMBER } = process.env;

const REPLY_MODE = (process.env.JOJO_WHATSAPP_REPLY_MODE || 'both').toLowerCase(); // 'text' | 'voice' | 'both' | 'auto'
const SAFE_MODE  = process.env.JOJO_WHATSAPP_SAFE_MODE !== 'false'; // default ON
const MAX_CHARS  = 4000; // guardrail against a huge/malformed message wedging a turn

// `auto` mode: text always goes out; a voice note ADDITIONALLY goes out when
// either (a) JOJO itself judged the reply worth hearing and called
// send_whatsapp_voice_note mid-turn (see whatsapp_tools.js + agent._voiceState),
// or (b) this incoming message itself is asking for a spoken reply. This
// pattern only has to catch (b) — (a) is detected via agent._voiceState.sent.
const VOICE_REQUEST_PATTERN =
  /\b(voice\s*(note|message|memo|reply)s?|voicemail|audio\s*(note|message|reply)s?|say\s+(it|that|this)\b|speak\s+(it|that|this)\b|read\s+(it|that|this)\s+(to|for)\s+me|out\s+loud)\b/i;

function wantsVoiceReply(text) {
  return VOICE_REQUEST_PATTERN.test(text || '');
}

// Tools switched off for WhatsApp-triggered turns when SAFE_MODE is on —
// mirrors email_channel.js's list. A denylist, not a sandbox: anything not
// listed here still runs.
const SAFE_MODE_BLOCKED_TOOLS = [
  'bash_execute',
  'code_execute',
  'nmap_scan',
  'aircrack_ng', 'airmon_ng', 'airodump_ng', 'aireplay_ng',
  'apply_deployment', 'rollback_deployment',
  'apply_browser_action',
  'world_watch_add',
];

if (!JOJO_WHATSAPP_ALLOWED_NUMBER) {
  console.error(chalk.red('Missing JOJO_WHATSAPP_ALLOWED_NUMBER in .env — set it to your own number, digits only, no +, e.g. 256701267948.'));
  process.exit(1);
}

const ALLOWED_JID = `${JOJO_WHATSAPP_ALLOWED_NUMBER.replace(/\D/g, '')}@s.whatsapp.net`;

function jidNumber(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

async function main() {
  if (!['text', 'voice', 'both', 'auto'].includes(REPLY_MODE)) {
    console.warn(chalk.yellow(`[whatsapp] unrecognized JOJO_WHATSAPP_REPLY_MODE "${REPLY_MODE}" — expected text | voice | both | auto. No replies (text or voice) will be sent until this is fixed.`));
  }

  console.log(chalk.gray(`[whatsapp] allowed sender: ${JOJO_WHATSAPP_ALLOWED_NUMBER.replace(/\D/g, '')}`));
  console.log(chalk.gray(`[whatsapp] reply mode: ${REPLY_MODE}`));
  console.log(chalk.gray(`[whatsapp] safe mode: ${SAFE_MODE ? 'ON (risky tools blocked)' : 'OFF (full tool access)'}\n`));

  const agent = new JojoAgent();
  agent.setChannel('whatsapp'); // feature: one consistent persona across every channel
  await agent.init();

  const client = new WhatsAppClient();
  const allowedNumber = jidNumber(ALLOWED_JID);

  client.onIncoming = async ({ text, key }) => {
    // Gate 1: sender allowlist. Everything else is ignored, silently.
    if (jidNumber(key.remoteJid) !== allowedNumber) {
      console.log(chalk.gray(`[whatsapp] ignoring message from unrecognized number ${jidNumber(key.remoteJid)}`));
      return;
    }

    const userText = text.slice(0, MAX_CHARS);
    console.log(chalk.cyan(`[whatsapp] "${userText.slice(0, 60)}${userText.length > 60 ? '…' : ''}"`));

    let snapshot = null;
    if (SAFE_MODE) snapshot = agent.tools.disableTemporary(SAFE_MODE_BLOCKED_TOOLS);

    let reply;
    try {
      reply = await agent.run(userText);
    } catch (err) {
      console.error(chalk.red('[whatsapp] agent.run failed:'), err.message);
      reply = `I hit an error handling that: ${err.message}`;
    } finally {
      if (snapshot) agent.tools.restoreTemporary(snapshot);
    }

    if (REPLY_MODE === 'text' || REPLY_MODE === 'both' || REPLY_MODE === 'auto') {
      await client.sendText(key.remoteJid, reply)
        .catch(err => console.error(chalk.red('[whatsapp] send text failed:'), err.message));
    }
    if (REPLY_MODE === 'voice' || REPLY_MODE === 'both') {
      try {
        await client.sendVoiceNote(key.remoteJid, reply);
      } catch (err) {
        console.error(chalk.red('[whatsapp] voice note failed:'), err.message);
        if (REPLY_MODE === 'voice') { // text mode already covered above for 'both'
          await client.sendText(key.remoteJid, reply).catch(() => {});
        }
      }
    } else if (REPLY_MODE === 'auto') {
      // Text is already sent above. Don't add a second voice note if JOJO
      // already sent one itself mid-turn (agent._voiceState.sent) — only
      // add one here when you actually asked for a spoken reply in this
      // message and JOJO hasn't already covered that.
      const jojoAlreadySentVoice = agent._voiceState.sent;
      if (!jojoAlreadySentVoice && wantsVoiceReply(userText)) {
        await client.sendVoiceNote(key.remoteJid, reply)
          .catch(err => console.error(chalk.red('[whatsapp] voice note failed:'), err.message));
          // text already sent above — no fallback needed on failure here
      }
    }
  };

  await client.connect();
  // Attach to the agent so send_whatsapp_message / send_whatsapp_voice_note
  // (src/tools/whatsapp_tools.js) can push messages proactively — always to
  // this same allowlisted JID, never anywhere else.
  agent.whatsapp = client;
  agent.whatsappAllowedJid = ALLOWED_JID;

  console.log(chalk.green('[whatsapp] ready — message yourself on WhatsApp to talk to JOJO. Ctrl+C to stop.'));

  process.on('SIGINT', async () => {
    console.log(chalk.cyan('\n[whatsapp] shutting down…'));
    await agent.shutdown().catch(() => {});
    process.exit(0);
  });
}

main().catch(err => {
  console.error(chalk.red('[whatsapp] fatal:'), err);
  process.exit(1);
});

