// scripts/gmail_auth_setup.js
//
// RUN THIS YOURSELF, ONCE, LOCALLY: `node scripts/gmail_auth_setup.js`
// JOJO never runs this and never sees your Google login — this script only
// talks to Google directly, in your own browser, and prints a refresh token
// for YOU to put in your own .env file.
//
// Prerequisites (see EMAIL_CHANNEL.md for the full walkthrough):
//   1. A Google account for JOJO to use (create a new dedicated one — don't
//      point this at your personal daily-driver inbox).
//   2. A Google Cloud project with the Gmail API enabled.
//   3. An OAuth client ID (type: "Desktop app") — download its client ID +
//      secret, set them as GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.
//   4. IMPORTANT: on the OAuth consent screen, set publishing status to
//      "Production" (NOT "Testing") before running this. Apps left in
//      Testing mode get their refresh token silently killed by Google every
//      7 days — the exact opposite of "checks its own email unattended."
//      For personal use (just you) you do NOT need to complete Google's
//      full verification review to go to Production — you'll see an
//      "unverified app" warning during consent, click through it.
import 'dotenv/config';
import { google } from 'googleapis';
import readline from 'readline';

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (from your OAuth client — see EMAIL_CHANNEL.md).');
  process.exit(1);
}

const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'; // "out of band" — no local server needed, code is shown on-screen
const SCOPES = ['https://www.googleapis.com/auth/gmail.modify']; // read + send + label; never account/profile changes

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

console.log('\n1. Open this URL, and sign in as the Google account JOJO should use (not your personal one):\n');
console.log('   ' + authUrl + '\n');
console.log('2. Approve access. Google will show you a code on the page (or in the redirected URL if your');
console.log('   client type is not "Desktop app" — use "urn:ietf:wg:oauth:2.0:oob" / Desktop app to avoid needing a server).\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('3. Paste that code here and press enter: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code.trim());
    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token in the response. This usually means this Google account already ' +
        'authorized this app before — go to https://myaccount.google.com/permissions, remove access for ' +
        'this app, and run this script again so Google issues a fresh refresh token.');
      process.exit(1);
    }
    console.log('\nSuccess. Add these to your .env (never commit .env to source control):\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nAlso set (not printed by this script — you choose these yourself):');
    console.log('JOJO_TRUSTED_EMAIL_SENDERS=your.real.address@example.com');
    console.log('JOJO_EMAIL_CODEWORD=<pick something you have not typed anywhere else>');
  } catch (err) {
    console.error('\nToken exchange failed:', err.message);
    process.exit(1);
  }
});

