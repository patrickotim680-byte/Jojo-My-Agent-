// ── WhatsApp Client ───────────────────────────────────────────────────────────
// Thin, reusable wrapper around a single Baileys WhatsApp Web socket. Two
// things use this:
//   - scripts/whatsapp_channel.js — the standalone "chat with JOJO over
//     WhatsApp" process. Owns the connection, wires incoming messages into
//     JojoAgent.run(), decides who's ALLOWED to talk to it.
//   - src/tools/whatsapp_tools.js — lets a running agent PUSH a message or
//     voice note out proactively, if a channel process has attached a live
//     client to agent.whatsapp.
//
// This file deliberately does NOT contain any allowlist/access-control
// logic — that gate lives in whatsapp_channel.js, same separation the email
// channel keeps between "how to send an email" and "who's allowed to
// trigger one".
//
// SELF-CHAT ANTI-ECHO:
// Baileys logs in as a real WhatsApp account (a linked device, same
// mechanism as WhatsApp Web) — there is no separate "bot API". If that
// account is your OWN number, the only WhatsApp thread where "you" message
// "yourself" is the built-in self-chat, and BOTH your typed messages and
// JOJO's own replies land in that same thread tagged fromMe:true — nothing
// distinguishes them at the protocol level. Two guards handle this:
//   1. `type !== 'notify'` — Baileys tags history-sync replays and some
//      multi-device echoes differently from a genuinely new message.
//   2. `_sentIds` — every message ID this client itself just sent is
//      recorded and skipped the one time it reappears in the upsert stream,
//      then forgotten. Without this, JOJO would read its own reply as your
//      next message and reply to itself forever.

import makeWASocket, { useMultiFileAuthState, DisconnectReason, jidNormalizedUser } from '@whiskeysockets/baileys';
import qrcodeTerminal from 'qrcode-terminal';
import chalk from 'chalk';
import fs from 'fs/promises';
import { synthesizeVoiceNote } from './tts.js';

const AUTH_DIR = process.env.JOJO_WHATSAPP_AUTH_DIR || './whatsapp_auth';

export class WhatsAppClient {
  constructor() {
    this.sock = null;
    this.myJid = null;          // normalized JID of the logged-in account, set once connected
    this._sentIds = new Set();  // recently-sent message IDs — anti-echo guard, see header
    this.onIncoming = null;     // set by the caller: async ({ text, key, fromMe }) => void
  }

  /** Connect (or reconnect) and resolve once the socket is open. Prints a
   *  scannable QR to the terminal on first run / after a logout. */
  connect() {
    return new Promise(async (resolve, reject) => {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const sock = makeWASocket({ auth: state, syncFullHistory: false });
      this.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          console.log(chalk.cyan('\n[whatsapp] scan this QR — WhatsApp → Linked Devices → Link a device:\n'));
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'open') {
          this.myJid = jidNormalizedUser(sock.user.id);
          console.log(chalk.gray(`[whatsapp] connected as ${this.myJid}`));
          resolve(this);
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          console.log(chalk.yellow(
            `[whatsapp] connection closed (${statusCode || 'unknown'})` +
            (loggedOut ? ` — logged out, delete ${AUTH_DIR} and re-scan` : ', reconnecting…')
          ));
          if (!loggedOut) this.connect().catch(() => {});
          else reject(new Error('WhatsApp session logged out — delete ' + AUTH_DIR + ' and re-run to re-scan the QR.'));
        }
      });

      sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const m of messages) {
          if (!m.message || m.key.remoteJid === 'status@broadcast') continue;
          if (m.key.id && this._sentIds.has(m.key.id)) { this._sentIds.delete(m.key.id); continue; }

          const text = m.message.conversation
            || m.message.extendedTextMessage?.text
            || m.message.imageMessage?.caption
            || '';
          if (!text.trim()) continue;

          if (this.onIncoming) {
            try {
              await this.onIncoming({ text: text.trim(), key: m.key, fromMe: m.key.fromMe });
            } catch (err) {
              console.error(chalk.red('[whatsapp] onIncoming handler failed:'), err.message);
            }
          }
        }
      });
    });
  }

  async sendText(jid, text) {
    const res = await this.sock.sendMessage(jid, { text });
    if (res?.key?.id) this._sentIds.add(res.key.id);
    return res;
  }

  /** Synthesize `text` and send it as a real WhatsApp voice note (ptt). */
  async sendVoiceNote(jid, text, opts) {
    const { path: oggPath, cleanup } = await synthesizeVoiceNote(text, opts);
    try {
      const audio = await fs.readFile(oggPath);
      const res = await this.sock.sendMessage(jid, {
        audio,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });
      if (res?.key?.id) this._sentIds.add(res.key.id);
      return res;
    } finally {
      cleanup();
    }
  }
}

