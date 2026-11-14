// scripts/voice_channel.js
//
// Real voice conversation with JOJO: speak, JOJO listens (termux-speech-to-text),
// thinks, replies out loud (termux-tts-speak). Run with: npm run voice
//
// REQUIRES Termux:API — see environment_tools.js's header comment for setup
// (same-source install of the Termux:API app + `pkg install termux-api`).
//
// This is a separate standalone process from `npm start`'s text REPL —
// same pattern as scripts/whatsapp_channel.js and scripts/email_channel.js.
// Run it in its own Termux session (or a `tmux` pane) alongside/instead of
// the text REPL; they don't share conversation history with each other.
//
// SAFETY: mirrors whatsapp_channel.js's SAFE_MODE — the riskiest tools
// (raw shell/code execution, network attack tools, deploys) are disabled
// for voice-triggered turns by default, since a misheard word is easier
// here than a typo in a typed message. Set JOJO_VOICE_SAFE_MODE=false to
// disable that if you specifically want full tool access over voice.

import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import { JojoAgent } from '../src/core/agent.js';
import { spawnCancelable, isProbablyEcho, endedWithQuestion } from './voice_barge_in_utils.js';

const execFileAsync = promisify(execFile);

const SAFE_MODE = process.env.JOJO_VOICE_SAFE_MODE !== 'false'; // default ON
const EXIT_PHRASES = ['goodbye jojo', 'stop listening', 'exit voice mode', 'that will be all'];
const AFFIRMATIVE = ['yes', 'yeah', 'yep', 'sure', 'go ahead', 'do it', 'please', 'okay', 'ok'];

// ── Feature: local-first mode for sensitive tasks ───────────────────────────
// Spoken session toggle — see agent.js's Stage -3 (run()) and
// local_router.js's routeForced() for what actually happens once this is on:
// every turn is forced through the local model only, and a decline there
// never falls back to cloud.
const LOCAL_ONLY_ON_PHRASES = ['go local-only', 'go local only', 'local only mode', 'stay on device', 'stay on this device'];
const LOCAL_ONLY_OFF_PHRASES = ['back to normal', 'leave local-only', 'leave local only mode', 'go back to normal', 'end local-only'];

// How many consecutive silent listen() timeouts (each ~20s, see listen())
// before offering to hand off to another device that's been active/idle
// recently. This is the ONLY "presence" signal this uses — no continuous
// audio monitoring, no room inference, nothing beyond the silence-timeout
// signal termux-speech-to-text already surfaces. Deliberately not more
// clever than that: a real always-listening "is anyone in this room" feature
// is a genuine privacy line, not something to cross by default. Set
// JOJO_VOICE_SILENCE_HANDOFF_AFTER=0 to disable this suggestion entirely.
const SILENCE_HANDOFF_AFTER = parseInt(process.env.JOJO_VOICE_SILENCE_HANDOFF_AFTER || '3', 10);

// ── Feature: true barge-in ────────────────────────────────────────────────────
// termux-speech-to-text has no partial-result / streaming mode — it's a
// one-shot call that returns only once its own endpointing decides you've
// stopped talking. So "the instant you start talking" is bounded by that
// engine's endpointing latency, not a true sub-300ms interrupt; this gets as
// close as the underlying tool allows by racing capture against playback
// instead of running them sequentially. Set JOJO_VOICE_BARGE_IN=false to
// fall back to the old strict listen-then-speak behavior (e.g. if you're on
// speaker without headphones and self-echo is triggering false interrupts).
const BARGE_IN_ENABLED = process.env.JOJO_VOICE_BARGE_IN !== 'false';
// If the mic capture during playback is suspiciously similar to what's
// currently being spoken, it's almost certainly the device's own TTS output
// bleeding into the mic (no headphones), not the user talking over it.
const ECHO_SIMILARITY_THRESHOLD = 0.6;

// ── Feature: silence as a signal (check-in after an unfinished exchange) ─────
// Separate from SILENCE_HANDOFF_AFTER above — this fires sooner and only
// when the previous reply plausibly left something open (heuristic: did it
// end with a question). Fires exactly once per unfinished reply, not a
// repeating nag, and never during ordinary quiet after a reply that already
// wrapped up. Set JOJO_VOICE_CHECKIN_AFTER=0 to disable.
const UNFINISHED_CHECKIN_AFTER = parseInt(process.env.JOJO_VOICE_CHECKIN_AFTER || '2', 10);
const CHECK_IN_LINE = "Still there? I can pick this back up whenever you're ready.";

const SAFE_MODE_BLOCKED_TOOLS = [
  'bash_execute',
  'code_execute',
  'nmap_scan',
  'aircrack_ng', 'airmon_ng', 'airodump_ng', 'aireplay_ng',
  'apply_deployment', 'rollback_deployment',
  'apply_browser_action',
  'world_watch_add',
];

// Strip markdown/code so TTS doesn't try to read out "asterisk asterisk"
// or a wall of code — speak the prose, skip the rest.
function stripForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' (code block, see the screen) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[-*]\s+/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
}

async function listen() {
  try {
    const { stdout } = await execFileAsync('termux-speech-to-text', [], { timeout: 20000 });
    return stdout.trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(chalk.red('termux-speech-to-text not found — install Termux:API first (see this file\'s header comment).'));
      process.exit(1);
    }
    return ''; // timeout / no speech detected — just loop again
  }
}

async function speak(text) {
  const clean = stripForSpeech(text);
  if (!clean) return;
  try {
    await execFileAsync('termux-tts-speak', [clean], { timeout: 30000 });
  } catch (err) {
    console.error(chalk.red('[voice] TTS failed:'), err.message);
  }
}

// Speaks `text` while concurrently listening, so the user can talk over it.
// Returns the barged-in utterance (string) if the user's speech won the
// race and wasn't judged to be self-echo, or null if playback finished
// (or barge-in is disabled) with nothing to report — same as calling
// speak() followed by nothing.
async function speakInterruptible(text) {
  const clean = stripForSpeech(text);
  if (!clean) return null;

  if (!BARGE_IN_ENABLED) {
    await speak(text);
    return null;
  }

  const speakTask = spawnCancelable('termux-tts-speak', [clean], { timeout: 30000 });
  const captureTask = spawnCancelable('termux-speech-to-text', [], { timeout: 20000 });

  const first = await Promise.race([
    speakTask.promise.then((r) => ({ from: 'speak', r })),
    captureTask.promise.then((r) => ({ from: 'capture', r })),
  ]);

  if (first.from === 'capture' && first.r.ok && first.r.text && !isProbablyEcho(first.r.text, clean, ECHO_SIMILARITY_THRESHOLD)) {
    // The user started talking before playback finished — this is the
    // barge-in. Cut audio now; don't wait for speakTask to unwind.
    speakTask.cancel();
    return first.r.text;
  }

  // Either speak finished first, or the capture that "won" was empty/echo —
  // let playback run out normally and stop the now-unneeded capture.
  await speakTask.promise;
  captureTask.cancel();
  return null;
}

async function main() {
  console.log(chalk.gray(`[voice] safe mode: ${SAFE_MODE ? 'ON (risky tools blocked)' : 'OFF (full tool access)'}`));
  console.log(chalk.gray(`[voice] say one of ${JSON.stringify(EXIT_PHRASES)} to stop, or Ctrl+C anytime.\n`));

  const agent = new JojoAgent();
  agent.setChannel('voice'); // feature: one consistent persona across every channel
  await agent.init();
  await speak("Voice mode active. I'm listening.");

  // Feature: ambient task-completion pings + self-healing out loud. Plain,
  // non-interruptible speak() on purpose — these are ambient background
  // pings, not part of the barge-in-aware turn-taking loop below.
  agent.setVoiceSession(true, (text) => { speak(text); });

  // eslint-disable-next-line no-constant-condition
  let consecutiveSilences = 0;
  let awaitingHandoffAnswer = false;
  // Feature: silence as a signal. Independent of the handoff counter above —
  // this one only counts timeouts that follow a reply which plausibly left
  // something open, fires once, and doesn't reset the handoff counter's own
  // timing.
  let lastReplyUnfinished = false;
  let unfinishedSilenceCount = 0;
  let checkInSent = false;
  // Feature: true barge-in. When speakInterruptible() gets talked over, it
  // hands back what it heard instead of nothing — carry that straight into
  // the next turn instead of calling listen() again and dropping it.
  let bargedInText = null;

  try {
    while (true) {
      let heard;
      if (bargedInText) {
        heard = bargedInText;
        bargedInText = null;
        console.log(chalk.magenta(`🎤 (barge-in) heard over playback: "${heard}"`));
      } else {
        console.log(chalk.cyan('🎤 Listening…'));
        heard = await listen();
      }

      if (!heard) {
        consecutiveSilences++;

        if (lastReplyUnfinished && !checkInSent && UNFINISHED_CHECKIN_AFTER > 0) {
          unfinishedSilenceCount++;
          if (unfinishedSilenceCount >= UNFINISHED_CHECKIN_AFTER) {
            checkInSent = true; // exactly one check-in per unfinished reply, never a repeating nag
            await speak(CHECK_IN_LINE);
          }
        }

        if (consecutiveSilences === SILENCE_HANDOFF_AFTER && SILENCE_HANDOFF_AFTER > 0 && !awaitingHandoffAnswer) {
          // Real signal, not a guess dressed up as one: this session has gone
          // quiet, AND continuity.js's own heartbeat says another device was
          // seen recently. That's it — no room inference, no audio-level
          // detection beyond the STT timeout already happening anyway.
          const others = agent.continuity?.listDevices?.()
            .filter(d => !d.self && (d.status === 'active' || d.status === 'idle')) || [];
          if (others.length) {
            const target = others[0]; // most-recently-seen — listDevices() is already sorted that way
            awaitingHandoffAnswer = true;
            await speak(`It's gone quiet here. I noticed "${target.label}" was active recently — want me to hand off there?`);
          }
        }
        continue;
      }

      consecutiveSilences = 0;
      unfinishedSilenceCount = 0;
      checkInSent = false;
      console.log(chalk.white(`You said: "${heard}"`));

      if (awaitingHandoffAnswer) {
        awaitingHandoffAnswer = false;
        const said = heard.toLowerCase();
        if (AFFIRMATIVE.some(w => said.includes(w))) {
          // Deliberately does NOT call continuity.handoff() here — this device
          // (the phone) has no authority to truthfully claim ANOTHER device is
          // now active; handoff() only ever marks the CALLING device (see its
          // body in continuity.js — the deviceId is always `this.deviceId`,
          // there's no mechanism to assert it on another device's behalf, and
          // there shouldn't be — one device asserting state for a machine it
          // isn't running on is exactly the kind of thing that'd make this
          // data untrustworthy). The honest move: step back from being the
          // active device myself, and trust that the target device's own JOJO
          // instance heartbeats/hands off for itself once actually used there.
          await speak(`Okay — stepping back here. Go ahead on the other device whenever you're ready. ` +
            `Say "goodbye jojo" anytime, or just start talking again if you want me back on this one.`);
          break;
        }
        // Not affirmative — don't discard what they said, it might not have
        // been an answer to the question at all; fall through to normal handling.
      }

      if (EXIT_PHRASES.some(p => heard.toLowerCase().includes(p))) {
        await speak('Voice mode ending. Goodbye.');
        break;
      }

      const heardLower = heard.toLowerCase();
      if (LOCAL_ONLY_ON_PHRASES.some(p => heardLower.includes(p))) {
        agent.setLocalOnly(true);
        bargedInText = await speakInterruptible("Okay — local-only mode. Everything stays on this device until you say otherwise.");
        continue;
      }
      if (LOCAL_ONLY_OFF_PHRASES.some(p => heardLower.includes(p))) {
        agent.setLocalOnly(false);
        bargedInText = await speakInterruptible("Back to normal — the cloud model's available again.");
        continue;
      }

      let snapshot = null;
      if (SAFE_MODE) snapshot = agent.tools.disableTemporary(SAFE_MODE_BLOCKED_TOOLS);

      let reply;
      try {
        reply = await agent.run(heard);
      } catch (err) {
        console.error(chalk.red('[voice] agent.run failed:'), err.message);
        reply = `I hit an error with that: ${err.message}`;
      } finally {
        if (snapshot) agent.tools.restoreTemporary(snapshot);
      }

      console.log(chalk.green(`JOJO: ${reply}\n`));
      lastReplyUnfinished = endedWithQuestion(reply);
      bargedInText = await speakInterruptible(reply);
    }
  } finally {
    agent.setVoiceSession(false);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(chalk.red('[voice] fatal:'), err);
  process.exit(1);
});

