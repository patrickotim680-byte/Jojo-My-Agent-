/**
 * Run this ONCE: `node scripts/get-puter-token.js`
 *
 * Opens a browser to log into puter.com (free account, no credit card),
 * then prints an auth token. Paste that into .env as PUTER_AUTH_TOKEN.
 * The token doesn't expire on a schedule, so you only need to do this once
 * per puter.com account.
 */
import { getAuthToken } from '@heyputer/puter.js/src/init.cjs';

const token = await getAuthToken();
console.log('\nPUTER_AUTH_TOKEN=' + token + '\n');
console.log('Copy the line above into your .env file.');

