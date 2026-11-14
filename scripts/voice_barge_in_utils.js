// scripts/voice_barge_in_utils.js
//
// Pure helper logic for two voice-channel features (true barge-in, and the
// unfinished-exchange check-in). Split out from voice_channel.js so it can
// be unit-tested without pulling in Termux/device calls or running main().

import { execFile } from 'child_process';

// Same shape as util.promisify(execFile), but keeps the child process handle
// around so the caller can kill() it mid-flight — promisify(execFile) alone
// doesn't expose that, and cancellation is the whole point of barge-in.
export function spawnCancelable(cmd, args, opts = {}) {
  let child;
  const promise = new Promise((resolve) => {
    child = execFile(cmd, args, opts, (err, stdout) => {
      if (err) {
        resolve({ ok: false, text: '', killed: !!(err.killed || err.signal) });
      } else {
        resolve({ ok: true, text: (stdout || '').trim(), killed: false });
      }
    });
  });
  return { promise, cancel: () => { try { child.kill('SIGTERM'); } catch { /* already dead */ } } };
}

export function wordSet(text) {
  return new Set((text || '').toLowerCase().match(/[a-z0-9']+/g) || []);
}

// Rough Jaccard overlap — enough to tell "that's the TTS bleeding into the
// mic" apart from "the user said something unrelated over it". Not real
// acoustic echo cancellation (this tool has no access to that layer); on
// speaker-without-headphones setups this is a heuristic safety net, not a
// guarantee.
export function isProbablyEcho(heard, spoken, threshold = 0.6) {
  const a = wordSet(heard);
  const b = wordSet(spoken);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size) >= threshold;
}

export function endedWithQuestion(text) {
  return /\?\s*$/.test((text || '').trim());
}

