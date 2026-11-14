# Talking to JOJO by email

This lets you send JOJO an email and get a reply in the same thread — useful
for when you're somewhere you can't run the terminal REPL (e.g. school).

JOJO still has to be running on a machine with network access for this to
work — the email channel is `npm run email` running as its own long-lived
process (leave it running on a computer at home, or on a small always-on
box/VPS). It is not a way to run JOJO "in the cloud" by itself.

## Security model — read before you set this up

JOJO can run shell commands, scan networks, drive a browser, and deploy
things. Wiring that up to an email inbox means **whoever can get a message
into that inbox, formatted the right way, can make JOJO act on your
machine.** Take the setup below seriously, not just as boilerplate:

- **Use a dedicated Google account for JOJO**, not your everyday inbox.
  If it's ever compromised, the blast radius is "an inbox JOJO reads,"
  not your real email.
- **`JOJO_TRUSTED_EMAIL_SENDERS`** — only mail *from* these addresses is
  looked at at all. Set it to your own address(es) only.
- **`JOJO_EMAIL_CODEWORD`** — a secret string you pick, that you have not
  typed anywhere else (not in this repo, not in a public gist, not in a
  message to someone else). Every command email must contain it. This is
  what protects you if the trusted address itself gets spoofed or the
  account is compromised.
- **Safe mode is on by default.** Email-triggered turns run with shell
  execution, code execution, network scanning, wireless tools, and live
  deploys switched off, even for a trusted+codeworded sender — see
  `SAFE_MODE_BLOCKED_TOOLS` in `scripts/email_channel.js`. You can turn
  this off with `JOJO_EMAIL_SAFE_MODE=false`, but think about whether you
  actually want "an email can run a shell command on my laptop" before
  you do — it's much safer to keep it on and just accept that a few tools
  aren't available from school.

## 1. Create a Google Cloud project + enable the Gmail API

1. Go to https://console.cloud.google.com/ and create a new project (any
   name, e.g. "jojo-email").
2. In that project, go to **APIs & Services → Library**, search for
   **Gmail API**, and click **Enable**.

## 2. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External** is fine for personal use.
3. Fill in the required fields (app name, your email as support/developer
   contact). You don't need to add scopes here or submit for verification.
4. **Publishing status: set it to "Production", not "Testing".** Apps left
   in Testing mode have their refresh tokens killed by Google every 7
   days — the opposite of an unattended email channel. You'll see an
   "unverified app" warning when you authorize in step 4 below; that's
   expected for a personal-use app and fine to click through.

## 3. Create an OAuth client

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app**.
3. Download the client ID and client secret (or just copy them from the
   console).

## 4. Set up your `.env`

In the project root, create/edit `.env`:

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret

JOJO_TRUSTED_EMAIL_SENDERS=your.real.address@example.com
JOJO_EMAIL_CODEWORD=pick-something-you-have-not-typed-anywhere-else
```

Then run:

```
npm install
npm run email-auth
```

Follow the prompts: open the printed URL, sign in as the Google account
**you want JOJO to use** (the dedicated one from step "Use a dedicated
Google account" above, not your daily driver), approve access, and paste
the code back in. It will print a `GOOGLE_REFRESH_TOKEN=...` line — add
that to `.env` too.

## 5. Run it

```
npm run email
```

Leave this running. Send an email to the JOJO Gmail address from one of
your `JOJO_TRUSTED_EMAIL_SENDERS`, with your codeword anywhere in the
subject or body, and JOJO will reply in the same thread within one poll
interval (30s by default).

## Optional tuning (all in `.env`)

| Variable | Default | What it does |
|---|---|---|
| `JOJO_EMAIL_POLL_INTERVAL_MS` | `30000` | How often to check the inbox. |
| `JOJO_EMAIL_MAX_PER_POLL` | `5` | Max messages handled per poll cycle. |
| `JOJO_EMAIL_SAFE_MODE` | `true` | Set `false` to allow shell/network/deploy tools over email — see the security note above before you do this. |

## Troubleshooting

- **"No refresh_token in the response"** when running `npm run email-auth`:
  this Google account already authorized this app once before, and Google
  only issues a refresh token on first consent. Go to
  https://myaccount.google.com/permissions, remove access for the app, and
  re-run `npm run email-auth`.
- **Replies stop after ~7 days**: your OAuth consent screen is still in
  "Testing" — go back to step 2 and switch it to "Production".
- **JOJO never replies to a trusted email**: check the codeword is spelled
  exactly the same in the email as in `.env`, and that the sending address
  exactly matches one in `JOJO_TRUSTED_EMAIL_SENDERS` (it's compared
  case-insensitively but must otherwise match exactly).

