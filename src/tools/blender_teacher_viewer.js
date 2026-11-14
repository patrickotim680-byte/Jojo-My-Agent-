// ── Rendered Teacher Viewer ─────────────────────────────────────────────────
// Plays back real Blender-rendered photoreal images/video (from
// blender_render_still / blender_render_turntable) narrated with synchronized
// TTS, using the same HUD look and pause/repeat/back/next controls as the
// live show_holo_narrator tool. Unlike the live WebGL scene, camera angles
// here are BAKED IN at render time (Blender isn't running live), so this
// mode trades live re-navigation for true photoreal visuals.
//
// Typical flow: call blender_render_still (or _turntable) once per narration
// beat with the right `focus`, then pass the resulting file paths + narration
// lines here as `segments`.
//
// Tool:
//   show_rendered_teacher — segments: [{ text, media_path, media_type? }]

import fs   from 'fs/promises';
import fss  from 'fs';
import path from 'path';
import { exec } from 'child_process';

const OUTPUT_DIR = './output';

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

function openFile(filepath) {
  const opener =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32'  ? 'start' :
    'xdg-open';
  exec(`${opener} "${path.resolve(filepath)}"`);
}

function guessMediaType(p) {
  const ext = path.extname(p).toLowerCase();
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  return 'image';
}

function toFileUrl(p) {
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return 'file:///' + resolved.replace(/^\/+/, '');
}

function buildViewerHtml(segments) {
  const dataJson = JSON.stringify(segments);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JOJO — Rendered Teacher</title>
<style>
  html, body { margin:0; height:100%; background:#000; overflow:hidden; font-family: 'Segoe UI', system-ui, sans-serif; }
  #media { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:#000; }
  #media img, #media video { max-width:100%; max-height:100%; object-fit:contain; transition:opacity .4s ease; }
  #hud { position:fixed; inset:0; pointer-events:none; color:#8ff5ff; }
  #hud .corner { position:absolute; font-size:11px; letter-spacing:2px; opacity:.7; text-shadow:0 0 6px #00e5ff; }
  #tl { top:16px; left:16px; } #tr { top:16px; right:16px; text-align:right; }
  #br { bottom:16px; right:16px; text-align:right; }
  #caption {
    position:fixed; left:50%; bottom:96px; transform:translateX(-50%);
    max-width:72%; text-align:center; font-size:18px; color:#c8faff;
    text-shadow:0 0 10px #00e5ff; min-height:24px; pointer-events:none;
    background:rgba(0,0,0,.35); padding:8px 16px; border-radius:10px;
  }
  #progress { position:fixed; left:50%; bottom:80px; transform:translateX(-50%);
    display:flex; gap:6px; pointer-events:none; }
  #progress .dot { width:7px; height:7px; border-radius:50%; background:#0ff3; border:1px solid #0ff8; }
  #progress .dot.active { background:#22e8ff; box-shadow:0 0 8px #00e5ff; }
  #panel {
    position:fixed; left:50%; bottom:16px; transform:translateX(-50%);
    display:flex; gap:8px; pointer-events:auto;
  }
  #panel button {
    background:rgba(0,229,255,.15); border:1px solid #0ff8; color:#aef6ff;
    padding:10px 16px; border-radius:20px; cursor:pointer; font-size:13px; letter-spacing:1px;
  }
  #panel button:hover { background:rgba(0,229,255,.3); }
</style>
</head>
<body>
<div id="media"></div>
<div id="hud">
  <div class="corner" id="tl">JOJO // RENDERED-TEACHER<br>STATUS: <span id="statusTxt">IDLE</span></div>
  <div class="corner" id="tr">BLENDER PHOTOREAL PLAYBACK</div>
  <div class="corner" id="br">SEGMENT <span id="segTxt">0/0</span></div>
</div>
<div id="caption"></div>
<div id="progress"></div>
<div id="panel">
  <button id="playPause">⏸ PAUSE</button>
  <button id="repeat">⟲ REPEAT</button>
  <button id="prev">⏮ BACK</button>
  <button id="next">⏭ NEXT</button>
</div>

<script>
var SEGMENTS = ${dataJson};
var statusTxt = document.getElementById('statusTxt');
var segTxt = document.getElementById('segTxt');
var caption = document.getElementById('caption');
var progressEl = document.getElementById('progress');
var mediaEl = document.getElementById('media');
var segIndex = 0, paused = false, speaking = false;

function buildDots() {
  progressEl.innerHTML = '';
  SEGMENTS.forEach(function () {
    var d = document.createElement('div');
    d.className = 'dot';
    progressEl.appendChild(d);
  });
}
function updateDots() {
  var dots = progressEl.children;
  for (var i=0;i<dots.length;i++) dots[i].className = 'dot' + (i === segIndex ? ' active' : '');
  segTxt.textContent = (SEGMENTS.length ? segIndex+1 : 0) + '/' + SEGMENTS.length;
}

function renderMedia(seg) {
  mediaEl.innerHTML = '';
  if (!seg.media_path) return;
  if (seg.media_type === 'video') {
    var v = document.createElement('video');
    v.src = seg.media_path;
    v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
    mediaEl.appendChild(v);
  } else {
    var img = document.createElement('img');
    img.src = seg.media_path;
    mediaEl.appendChild(img);
  }
}

function speakText(text, onEnd) {
  window.speechSynthesis.cancel();
  var utter = new SpeechSynthesisUtterance(text);
  utter.onstart = function () { speaking = true; statusTxt.textContent = 'NARRATING'; };
  utter.onend = function () { speaking = false; statusTxt.textContent = 'IDLE'; if (onEnd) onEnd(); };
  utter.onboundary = function (e) {
    var upto = text.slice(0, e.charIndex + (e.charLength||0) + 20);
    caption.textContent = upto.length < text.length ? upto + '…' : text;
  };
  window.speechSynthesis.speak(utter);
}

function playSegment(i) {
  if (!SEGMENTS.length) return;
  if (i < 0) i = 0;
  if (i >= SEGMENTS.length) i = SEGMENTS.length - 1;
  segIndex = i; paused = false;
  document.getElementById('playPause').textContent = '⏸ PAUSE';
  var seg = SEGMENTS[segIndex];
  updateDots();
  renderMedia(seg);
  caption.textContent = '';
  speakText(seg.text, function () {
    if (!paused && segIndex === i && segIndex < SEGMENTS.length - 1) playSegment(segIndex + 1);
  });
}

function togglePause() {
  if (!SEGMENTS.length) return;
  if (speaking && !paused) {
    window.speechSynthesis.cancel(); paused = true; statusTxt.textContent = 'PAUSED';
    document.getElementById('playPause').textContent = '▶ RESUME';
  } else {
    paused = false;
    document.getElementById('playPause').textContent = '⏸ PAUSE';
    playSegment(segIndex);
  }
}

document.getElementById('playPause').onclick = togglePause;
document.getElementById('repeat').onclick = function () { playSegment(segIndex); };
document.getElementById('prev').onclick = function () { playSegment(segIndex - 1); };
document.getElementById('next').onclick = function () { playSegment(segIndex + 1); };

buildDots();
updateDots();
if (SEGMENTS.length) setTimeout(function () { playSegment(0); }, 400);
</script>
</body>
</html>`;
}

export const BLENDER_VIEWER_TOOLS = [
  {
    name: 'show_rendered_teacher',
    declaration: {
      name: 'show_rendered_teacher',
      description:
        'Plays back real Blender-rendered photoreal images/video with synchronized narration (TTS) and the usual pause/repeat/back/next controls. ' +
        'Use this after generating visuals with blender_render_still / blender_render_turntable — pass the rendered file path(s) alongside each narration line. ' +
        'Camera framing is baked into each rendered file (no live re-navigation), in exchange for true photoreal quality.',
      parameters: {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            description: 'Ordered narration script. Each item is spoken while its media (a Blender-rendered image or video) is shown.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Narration line for this segment.' },
                media_path: { type: 'string', description: 'File path to the rendered image (.png) or video (.mp4) to display for this segment (from blender_render_still/_turntable).' },
                media_type: { type: 'string', enum: ['image', 'video'], description: 'Optional; auto-detected from file extension if omitted.' },
              },
              required: ['text', 'media_path'],
            },
          },
        },
        required: ['segments'],
      },
    },
    async execute(args = {}) {
      await ensureOutputDir();
      const segments = Array.isArray(args.segments) ? args.segments : [];
      for (const seg of segments) {
        if (seg.media_path && !fss.existsSync(seg.media_path)) {
          return `Error: media file not found: "${seg.media_path}". Render it first with blender_render_still or blender_render_turntable.`;
        }
      }
      const prepared = segments.map(seg => ({
        text: seg.text,
        media_path: seg.media_path ? toFileUrl(seg.media_path) : null,
        media_type: seg.media_type || (seg.media_path ? guessMediaType(seg.media_path) : 'image'),
      }));
      const filename = `rendered_teacher_${Date.now().toString(36)}.html`;
      const filepath = path.join(OUTPUT_DIR, filename);
      await fs.writeFile(filepath, buildViewerHtml(prepared), 'utf-8');
      openFile(filepath);
      return `✅ Rendered-teacher playback online → ${path.resolve(filepath)} (${segments.length} segment(s))`;
    },
  },
];

