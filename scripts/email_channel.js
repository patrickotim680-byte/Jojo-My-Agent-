// scripts/email_channel.js
//
// Lets you talk to JOJO by email — send a message to the Gmail address you
// authorized in gmail_auth_setup.js, and JOJO replies in the same thread.
// Run with: npm run email  (see EMAIL_CHANNEL.md for full setup).
//
// SECURITY MODEL — read this before you rely on it:
//   JOJO can run shell commands, scan networks, and drive a browser. An
//   email channel means anyone who can get a message into that inbox with
//   the right sender + codeword can make JOJO do things on your machine.
//   Two independent gates protect that:
//     1. JOJO_TRUSTED_EMAIL_SENDERS — only mail From: one of these addresses
//        is looked at at all. Everything else is archived unread and ignored.
//     2. JOJO_EMAIL_CODEWORD — even a trusted sender's message is ignored
//        unless it contains this exact string somewhere in the body/subject.
//        This is what protects you if that "trusted" Gmail address itself
//        gets compromised or spoofed, and it's your signal that a message
//        was really typed by you and not e.g. an auto-reply loop.
//   On top of that, by default (JOJO_EMAIL_SAFE_MODE=true) the riskiest
//   tools — shell/code execution, network scanning, wireless attacks,
//   live deploys — are switched off for anything triggered by email, even
//   from a trusted+codeworded sender. You can turn that off, but think
//   about whether you actually want "reply-all can run a command on my
//   laptop" before you do.

import 'dotenv/config';
import { google } from 'googleapis';
import chalk from 'chalk';
import { JojoAgent } from '../src/core/agent.js';

// ── config ───────────────────────────────────────────────────────────────────

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  JOJO_TRUSTED_EMAIL_SENDERS,
  JOJO_EMAIL_CODEWORD,
} = process.env;

const POLL_INTERVAL_MS = Number(process.env.JOJO_EMAIL_POLL_INTERVAL_MS || 30_000);
const MAX_PER_POLL      = Number(process.env.JOJO_EMAIL_MAX_PER_POLL || 5);
const SAFE_MODE         = process.env.JOJO_EMAIL_SAFE_MODE !== 'false'; // default ON
const MAX_BODY_CHARS    = 8_000; // guardrail against a huge/malformed message wedging a turn

// Tools switched off for email-triggered turns when SAFE_MODE is on. This is
// a denylist, not a sandbox — anything not listed here still runs. If you add
// a new tool group to registry.js that can touch the filesystem, network, or
// external accounts, consider whether it belongs on this list too.
const SAFE_MODE_BLOCKED_TOOLS = [
  'bash_execute',
  'code_execute',
  'nmap_scan',
  'aircrack_ng', 'airmon_ng', 'airodump_ng', 'aireplay_ng',
  'apply_deployment', 'rollback_deployment',
  'apply_browser_action',
  'world_watch_add',
];

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
  console.error(chalk.red('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN in .env.'));
  console.error(chalk.gray('Run `node scripts/gmail_auth_setup.js` first — see EMAIL_CHANNEL.md.'));
  process.exit(1);
}
if (!JOJO_TRUSTED_EMAIL_SENDERS) {
  console.error(chalk.red('Missing JOJO_TRUSTED_EMAIL_SENDERS in .env — set it to your own email address(es), comma-separated.'));
  process.exit(1);
}
if (!JOJO_EMAIL_CODEWORD) {
  console.error(chalk.red('Missing JOJO_EMAIL_CODEWORD in .env — pick a secret word/phrase you have not used anywhere else.'));
  process.exit(1);
}

const TRUSTED_SENDERS = JOJO_TRUSTED_EMAIL_SENDERS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// ── gmail client ─────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

let MY_ADDRESS = null; // filled in at startup from the authorized account's own profile

// ── MIME helpers ─────────────────────────────────────────────────────────────

function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** Walk a Gmail message payload's MIME tree and return the best plain-text
 *  body it can find (prefers text/plain, falls back to stripped text/html). */
function extractBody(payload) {
  let plain = null;
  let html = null;

  function walk(part) {
    if (!part) return;
    const mimeType = part.mimeType || '';
    if (mimeType === 'text/plain' && part.body?.data) {
      plain = plain || decodeBase64Url(part.body.data);
    } else if (mimeType === 'text/html' && part.body?.data) {
      html = html || decodeBase64Url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  }
  walk(payload);

  if (plain) return plain.trim();
  if (html) return stripHtml(html);
  return '';
}

function headerValue(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/** Pull the bare address out of a "Display Name <addr@domain>" header. */
function bareAddress(fromHeader) {
  const match = fromHeader.match(/<([^>]+)>/);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

/** Strip every occurrence of the codeword out of the text sent to the
 *  agent, so it doesn't show up as a stray token in the conversation. */
function stripCodeword(text) {
  return text.split(JOJO_EMAIL_CODEWORD).join('').trim();
}

function buildReplyRaw({ to, subject, body, inReplyTo, references, threadTopicId }) {
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${to}`,
    `From: ${MY_ADDRESS}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { raw, threadId: threadTopicId };
}

async function sendReply(gmailMsg, body) {
  const headers = gmailMsg.payload.headers;
  const to = bareAddress(headerValue(headers, 'From'));
  const subject = headerValue(headers, 'Subject') || '(no subject)';
  const messageIdHeader = headerValue(headers, 'Message-ID') || headerValue(headers, 'Message-Id');
  const references = [headerValue(headers, 'References'), messageIdHeader].filter(Boolean).join(' ');

  const { raw, threadId } = buildReplyRaw({
    to,
    subject,
    body,
    inReplyTo: messageIdHeader,
    references,
    threadTopicId: gmailMsg.threadId,
  });

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
}

async function markProcessed(messageId) {
  // Remove UNREAD so we don't reprocess it, and INBOX so it doesn't clutter
  // the inbox you're also using as a human — everything's still in All Mail.
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD', 'INBOX'] },
  });
}

// ── one poll cycle ───────────────────────────────────────────────────────────

async function pollOnce(agent) {
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: 'in:inbox is:unread',
    maxResults: MAX_PER_POLL,
  });
  const messages = list.data.messages || [];
  if (!messages.length) return;

  for (const { id } of messages) {
    let full;
    try {
      full = (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data;
    } catch (err) {
      console.error(chalk.red(`[email] failed to fetch message ${id}:`), err.message);
      continue;
    }

    const headers = full.payload.headers;
    const fromHeader = headerValue(headers, 'From');
    const sender = bareAddress(fromHeader);
    const subject = headerValue(headers, 'Subject') || '(no subject)';

    // Gate 1: sender allowlist. Anything else is archived, unread, silently —
    // no reply, so we don't confirm to a stranger/spoofer that this inbox is live.
    if (!TRUSTED_SENDERS.includes(sender)) {
      console.log(chalk.gray(`[email] ignoring "${subject}" from untrusted sender ${sender}`));
      await markProcessed(id).catch(() => {});
      continue;
    }

    const rawBody = extractBody(full.payload);
    const combined = `${subject}\n${rawBody}`;

    // Gate 2: codeword. Trusted sender but no codeword → nudge them once,
    // since this is really just you, not an attacker probing the address.
    if (!combined.includes(JOJO_EMAIL_CODEWORD)) {
      console.log(chalk.gray(`[email] "${subject}" from ${sender} has no codeword — reminding, not running`));
      await sendReply(full, "I got this, but it didn't include the codeword, so I'm not acting on it. Include it anywhere in the email and resend.").catch(err => console.error(chalk.red('[email] reply failed:'), err.message));
      await markProcessed(id).catch(() => {});
      continue;
    }

    const userText = stripCodeword(rawBody).slice(0, MAX_BODY_CHARS);
    if (!userText) {
      await markProcessed(id).catch(() => {});
      continue;
    }

    console.log(chalk.cyan(`[email] running message from ${sender}: "${subject}"`));

    let snapshot = null;
    if (SAFE_MODE) snapshot = agent.tools.disableTemporary(SAFE_MODE_BLOCKED_TOOLS);

    let reply;
    try {
      reply = await agent.run(userText);
    } catch (err) {
      console.error(chalk.red('[email] agent.run failed:'), err.message);
      reply = `I hit an error handling that: ${err.message}`;
    } finally {
      if (snapshot) agent.tools.restoreTemporary(snapshot);
    }

    try {
      await sendReply(full, reply);
    } catch (err) {
      console.error(chalk.red('[email] failed to send reply:'), err.message);
    }
    await markProcessed(id).catch(err => console.error(chalk.red('[email] failed to mark processed:'), err.message));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

let stopping = false;
process.on('SIGINT', async () => {
  console.log(chalk.cyan('\n[email] shutting down…'));
  stopping = true;
});

async function main() {
  const profile = await gmail.users.getProfile({ userId: 'me' });
  MY_ADDRESS = profile.data.emailAddress;

  console.log(chalk.gray(`[email] authorized as ${MY_ADDRESS}`));
  console.log(chalk.gray(`[email] trusted senders: ${TRUSTED_SENDERS.join(', ')}`));
  console.log(chalk.gray(`[email] safe mode: ${SAFE_MODE ? 'ON (risky tools blocked)' : 'OFF (full tool access)'}`));
  console.log(chalk.gray(`[email] polling every ${POLL_INTERVAL_MS / 1000}s — Ctrl+C to stop\n`));

  const agent = new JojoAgent();
  agent.setChannel('email'); // feature: one consistent persona across every channel
  await agent.init();

  while (!stopping) {
    try {
      await pollOnce(agent);
    } catch (err) {
      console.error(chalk.red('[email] poll cycle failed:'), err.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  await agent.shutdown().catch(() => {});
  process.exit(0);
}

main().catch(err => {
  console.error(chalk.red('[email] fatal:'), err);
  process.exit(1);
});

