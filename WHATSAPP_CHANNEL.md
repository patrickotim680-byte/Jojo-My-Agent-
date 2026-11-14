# Talking to JOJO over WhatsApp

This lets you message JOJO on WhatsApp and get a reply back — as text, as a
real spoken voice note (male TTS voice), or both. Unlike the email channel,
JOJO can also push a message or voice note to you *proactively* (a build
finished, a `world_model` watch fired) via `send_whatsapp_message` /
`send_whatsapp_voice_note`, whenever this channel is running.

JOJO still has to be running on a machine with network access — `npm run
whatsapp` is its own long-lived process, same as the email channel. Leave it
running on a computer at home or a small always-on box; it's not a way to
run JOJO "in the cloud" by itself.

## How the connection works (read this — it's not a bot API)

WhatsApp has no official free bot API for personal numbers. This channel
uses **Baileys**, which connects the same way WhatsApp Web does — it logs in
as a *linked device* on a real WhatsApp account, via QR code, no phone
number verification step of its own.

That means the account this session logs into **is** the number you scan
with. If you scan with your own phone (`+256701267948`), JOJO is now a
linked device on your own account — and the only WhatsApp thread where "you"
can message "yourself" is the built-in **self-chat**: open WhatsApp, tap
your own name at the top of the chat list ("Message yourself"). That's the
thread JOJO listens on.

If you'd rather keep JOJO off your primary account entirely (recommended if
anyone else ever has physical access to your phone), link this session to a
*different* number's WhatsApp instead (a spare SIM, an old phone, WhatsApp's
own second-device support) — everything below stays the same, you just text
that number from your real one instead of using self-chat.

Either way, **`JOJO_WHATSAPP_ALLOWED_NUMBER`** is the real gate: only
messages whose sender matches this number are ever looked at. Set it to your
own number. Everything else is silently ignored — no reply, so a stranger
who somehow reaches this session gets no confirmation JOJO is listening.

**Safe mode is on by default.** WhatsApp-triggered turns run with shell
execution, code execution, network scanning, wireless tools, and live
deploys switched off — see `SAFE_MODE_BLOCKED_TOOLS` in
`scripts/whatsapp_channel.js`. Turn it off with
`JOJO_WHATSAPP_SAFE_MODE=false` only if you're sure you want "a WhatsApp
message can run a shell command on my laptop."

## 1. Install ffmpeg

Voice notes need it to remux TTS output into the format WhatsApp accepts.

```bash
# Debian/Ubuntu
sudo apt-get install ffmpeg

# macOS
brew install ffmpeg

# Windows
winget install ffmpeg
```

## 2. Install dependencies

```bash
npm install
```

(This pulls in `@whiskeysockets/baileys`, `msedge-tts`, and
`qrcode-terminal` — already added to `package.json`.)

## 3. Set up your `.env`

```
JOJO_WHATSAPP_ALLOWED_NUMBER=256701267948
```

Digits only, country code first, **no `+` and no leading `0`** — this has to
match the number in the JID WhatsApp sends, e.g. `256701267948`, not
`+256 701 267 948` or `0701267948`.

## 4. Run it and scan the QR

```bash
npm run whatsapp
```

A QR code prints in the terminal. On your phone: **WhatsApp → Settings →
Linked Devices → Link a device**, and scan it. The session is saved to
`./whatsapp_auth/` so you won't need to re-scan on restart — **add that
folder to `.gitignore`**, it holds live session credentials, equivalent to
a login token for the account.

Once connected, message yourself on WhatsApp (or message the dedicated
number from your real one, if you went that route) — JOJO replies within
the same chat.

## Optional tuning (all in `.env`)

| Variable | Default | What it does |
|---|---|---|
| `JOJO_WHATSAPP_REPLY_MODE` | `both` | `text`, `voice`, `both`, or `auto`. `auto` always sends text, and *additionally* sends a voice note when either JOJO itself decides the reply is worth hearing (it calls `send_whatsapp_voice_note` mid-turn — see below) or your message asks for one, e.g. "voice note", "say that", "read that to me". Set `voice` for pure voicemail-style replies. |
| `JOJO_WHATSAPP_SAFE_MODE` | `true` | Set `false` to allow shell/network/deploy tools over WhatsApp — see the security note above first. |
| `JOJO_WHATSAPP_AUTH_DIR` | `./whatsapp_auth` | Where the linked-device session is stored. |
| `JOJO_TTS_VOICE` | `en-US-ChristopherNeural` | The voice. Other male options: `en-US-GuyNeural`, `en-US-EricNeural`, `en-GB-RyanNeural`. Full list: run `npx msedge-tts` or see the package README. |
| `JOJO_TTS_MAX_CHARS` | `1800` | Longer replies are truncated for the *voice note only* — the text reply (if `REPLY_MODE` includes `text`) is unaffected. |

## Proactive voice notes / messages

Once `npm run whatsapp` is running, any JOJO turn — from any channel, or
from `world_model`/`healer` drift-handling — can call `send_whatsapp_message`
or `send_whatsapp_voice_note` to reach you outside the normal reply flow.
Both always send to the same `JOJO_WHATSAPP_ALLOWED_NUMBER` this channel
already gates on; there's no way to point them at anyone else.

This is also the mechanism behind `JOJO_WHATSAPP_REPLY_MODE=auto`'s "JOJO
decides" half: if JOJO calls `send_whatsapp_voice_note` while handling your
WhatsApp message, `auto` mode notices and won't also synthesize a second
voice note from the plain-text reply — you just get the one JOJO chose to
send, plus the text reply as always.

## Troubleshooting

- **"ffmpeg not found or failed to start"**: install it (step 1) and make
  sure it's on `PATH` — restart your terminal after installing.
- **QR expires before you scan it**: it refreshes automatically; just wait
  for the next one, or restart `npm run whatsapp`.
- **JOJO never replies**: check `JOJO_WHATSAPP_ALLOWED_NUMBER` is digits
  only with no `+`/leading `0`, and that you're actually messaging the
  self-chat thread (or the dedicated bot number), not a normal contact.
- **"logged out, delete ./whatsapp_auth and re-scan"**: WhatsApp invalidated
  the linked-device session (you unlinked it from your phone, or it expired
  from long inactivity) — delete the folder and run `npm run whatsapp` again
  to get a fresh QR.
- **Voice notes arrive as a regular audio attachment, not a playable voice
  bubble**: WhatsApp is strict about the mimetype (`audio/ogg; codecs=opus`)
  and the file actually being Opus-in-Ogg — this is what the ffmpeg remux in
  `src/core/tts.js` produces; if you changed that code, that's the first
  place to check.

