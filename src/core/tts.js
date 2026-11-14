// ── Text-to-Speech ───────────────────────────────────────────────────────────
// Turns a reply string into a real spoken audio file JOJO can send as a
// WhatsApp voice note. Uses Microsoft Edge's neural TTS (free, no API key —
// same voices as the "Read Aloud" feature in the Edge browser) via the
// `msedge-tts` package, then remuxes to .ogg/Opus, which is what WhatsApp
// requires for a message to render as a playable voice note (not just a
// generic audio file attachment).
//
// WHY A REMUX, NOT A RE-ENCODE:
// Edge TTS's WEBM_24KHZ_16BIT_MONO_OPUS output format already IS Opus audio,
// just inside a WebM container instead of an Ogg container. ffmpeg with
// `-c:a copy` only swaps the container — no re-encode, no quality loss,
// and it's near-instant even on a slow machine.
//
// HONEST LIMITS:
//   - Requires `ffmpeg` on PATH (not an npm package — see WHATSAPP_CHANNEL.md
//     for a one-line install per OS). If it's missing, synthesizeVoiceNote()
//     throws with a clear message rather than silently failing.
//   - Edge TTS is an unofficial/free use of Microsoft's Read Aloud backend,
//     the same way Puter.js is an unofficial free wrapper for Claude — it
//     can rate-limit or change without notice. If it does, callers should
//     fall back to a text-only reply rather than blocking on voice.
//   - Very long replies make for a tedious voice note before they make for
//     a useful one — text is truncated to MAX_CHARS; send the full thing as
//     a text message alongside the voice note if that matters to you.

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Deep, natural male neural voices. Override with JOJO_TTS_VOICE in .env.
// Other solid male options: en-US-GuyNeural, en-US-EricNeural, en-GB-RyanNeural.
const DEFAULT_VOICE = process.env.JOJO_TTS_VOICE || 'en-US-ChristopherNeural';
const MAX_CHARS = Number(process.env.JOJO_TTS_MAX_CHARS || 1800);

/** Strip markdown/code noise that reads terribly out loud. */
function stripForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code block omitted, see the text reply) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function remuxToOgg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-i', inputPath, '-c:a', 'copy', outputPath]);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d; });
    ff.on('error', err => reject(new Error(
      `ffmpeg not found or failed to start (${err.message}). Install it — see WHATSAPP_CHANNEL.md.`
    )));
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Synthesize `rawText` into a WhatsApp-ready voice note.
 * Returns { path, cleanup } — caller MUST call cleanup() after sending
 * (deletes the temp dir), same pattern as a sandbox fork elsewhere in this
 * codebase — nothing here leaves files behind on its own.
 */
export async function synthesizeVoiceNote(rawText, { voice = DEFAULT_VOICE } = {}) {
  const text = stripForSpeech(rawText).slice(0, MAX_CHARS);
  if (!text) throw new Error('Nothing left to speak after cleaning the text.');

  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jojo-tts-'));
  const { audioFilePath: webmPath } = await tts.toFile(tmpDir, text);

  const oggPath = webmPath.replace(/\.webm$/, '.ogg');
  await remuxToOgg(webmPath, oggPath);
  await fs.unlink(webmPath).catch(() => {});

  return {
    path: oggPath,
    cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}),
  };
}

