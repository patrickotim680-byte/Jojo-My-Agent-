// ── Holo Narrator / 3D Teacher Tool ────────────────────────────────────────
// Gives Jojo a real-time 3D holographic explainer that can teach concepts by
// building a scene, narrating it with synchronized camera moves and part
// highlighting, and accepting live interruptions ("stop", "repeat", "zoom
// into the valve", "go back", "next") via voice or typed text — JARVIS-HUD
// style. Runs entirely client-side (Three.js + Web Speech API), no external
// render farm / GPU / Blender install required.
//
// Tool:
//   show_holo_narrator — writes the HUD to ./output and opens it.
//     scene:    which built-in 3D scene to load
//               ('engine' | 'heart' | 'dna' | 'blackhole' | 'atom' | 'generic')
//     segments: ordered narration script — each item is spoken aloud while
//               the camera/highlight follow along:
//                 { text, target?, camera? }
//               target  — name of a part in the scene to focus/highlight
//                         (see PART NAMES below)
//               camera  — 'orbit' | 'zoom' | 'cutaway' | 'default'
//     narration: legacy single-line quick narrate (used if segments omitted)
//
//   PART NAMES per scene (pass as `target` to focus the camera on it):
//     engine:    engineBlock, piston1, piston2, crankshaft, valve
//     heart:     heartOuter, leftAtrium, rightAtrium, leftVentricle,
//                rightVentricle, aorta
//     dna:       strandA, strandB, helicase
//     blackhole: singularity, eventHorizon, accretionDisk, grid
//     atom:      nucleus, shell1, shell2, shell3
//     generic:   core
//
//   Once open, the user can interrupt naturally — by voice (🎙 button) or by
//   typing — with commands like: "stop", "continue", "repeat", "go back",
//   "next", "zoom in", "zoom out", "zoom into <part>", "slower", "faster".

import fs   from 'fs/promises';
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

function buildHoloHtml(scene, segments) {
  const dataJson = JSON.stringify({ scene, segments });
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>JOJO — Holo Teacher</title>
<style>
  html, body { margin:0; height:100%; background:#000; overflow:hidden; font-family: 'Segoe UI', system-ui, sans-serif; }
  #scene3d { position:fixed; inset:0; }
  #hud { position:fixed; inset:0; pointer-events:none; color:#8ff5ff; }
  #hud .corner { position:absolute; font-size:11px; letter-spacing:2px; opacity:.7; text-shadow:0 0 6px #00e5ff; }
  #tl { top:16px; left:16px; } #tr { top:16px; right:16px; text-align:right; }
  #bl { bottom:16px; left:16px; } #br { bottom:16px; right:16px; text-align:right; }
  #label {
    position:fixed; top:16px; left:50%; transform:translateX(-50%);
    font-size:13px; letter-spacing:3px; color:#aef6ff; text-shadow:0 0 8px #00e5ff;
    pointer-events:none; text-transform:uppercase;
  }
  #caption {
    position:fixed; left:50%; bottom:96px; transform:translateX(-50%);
    max-width:72%; text-align:center; font-size:18px; color:#c8faff;
    text-shadow:0 0 10px #00e5ff; min-height:24px; pointer-events:none;
  }
  #progress { position:fixed; left:50%; bottom:80px; transform:translateX(-50%);
    display:flex; gap:6px; pointer-events:none; }
  #progress .dot { width:7px; height:7px; border-radius:50%; background:#0ff3; border:1px solid #0ff8; }
  #progress .dot.active { background:#22e8ff; box-shadow:0 0 8px #00e5ff; }
  #panel {
    position:fixed; left:50%; bottom:16px; transform:translateX(-50%);
    display:flex; gap:8px; pointer-events:auto; flex-wrap:wrap; justify-content:center; max-width:90vw;
  }
  #panel input {
    width:340px; max-width:50vw; background:rgba(0,20,30,.6); border:1px solid #0ff3;
    color:#eafdff; padding:10px 14px; border-radius:20px; outline:none; font-size:14px;
  }
  #panel button {
    background:rgba(0,229,255,.15); border:1px solid #0ff8; color:#aef6ff;
    padding:10px 16px; border-radius:20px; cursor:pointer; font-size:13px; letter-spacing:1px;
  }
  #panel button:hover { background:rgba(0,229,255,.3); }
  #panel button.on { background:rgba(0,229,255,.5); }
  #scenePicker { position:fixed; top:16px; left:50%; transform:translateX(-50%) translateY(28px);
    display:flex; gap:6px; pointer-events:auto; }
  #scenePicker button { font-size:10px; padding:5px 10px; border-radius:12px;
    background:rgba(0,20,30,.5); border:1px solid #0ff3; color:#8ff5ff; cursor:pointer; letter-spacing:1px; }
  #scenePicker button.active { background:rgba(0,229,255,.35); }
</style>
</head>
<body>
<div id="scene3d"></div>
<div id="hud">
  <div class="corner" id="tl">JOJO // HOLO-TEACHER<br>STATUS: <span id="statusTxt">IDLE</span></div>
  <div class="corner" id="tr">REALTIME AUDIO SYNC<br>WebGL · Web Speech API</div>
  <div class="corner" id="bl">CORE FREQ: <span id="freqTxt">0</span> Hz</div>
  <div class="corner" id="br">SEGMENT <span id="segTxt">0/0</span></div>
</div>
<div id="label">Loading…</div>
<div id="scenePicker"></div>
<div id="caption"></div>
<div id="progress"></div>
<div id="panel">
  <button id="playPause">⏸ PAUSE</button>
  <button id="repeat">⟲ REPEAT</button>
  <button id="prev">⏮ BACK</button>
  <button id="next">⏭ NEXT</button>
  <button id="mic">🎙 VOICE</button>
  <input id="text" placeholder="Type a command or ask JOJO to zoom / explain something..." />
  <button id="send">SEND</button>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
var DATA = ${dataJson};

// ---------- Three.js base scene ----------
var scene = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 200);
camera.position.set(0, 0, 7);
var camLookAt = new THREE.Vector3(0,0,0);

var renderer = new THREE.WebGLRenderer({ antialias:true, alpha:true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById('scene3d').appendChild(renderer.domElement);

var ambient = new THREE.AmbientLight(0x224455, 1.2);
scene.add(ambient);

addEventListener('resize', function () {
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- scene registry ----------
var SCENES = {};
var currentSceneObj = null; // { root, parts, cutawayTargets, update(t) }

function clearScene() {
  if (currentSceneObj && currentSceneObj.root) scene.remove(currentSceneObj.root);
  currentSceneObj = null;
}

function makeWire(geo, color, opacity) {
  var mat = new THREE.MeshBasicMaterial({ color: color, wireframe: true, transparent: true, opacity: opacity == null ? 0.85 : opacity });
  return new THREE.Mesh(geo, mat);
}
function makeSolid(geo, color, opacity) {
  var mat = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: opacity == null ? 0.9 : opacity });
  return new THREE.Mesh(geo, mat);
}

// -- generic (default holographic core) --
SCENES.generic = function () {
  var root = new THREE.Group();
  var core = makeWire(new THREE.IcosahedronGeometry(1.4, 3), 0x22e8ff, 0.85);
  root.add(core);
  var inner = makeWire(new THREE.IcosahedronGeometry(0.9, 1), 0x8ff5ff, 0.5);
  root.add(inner);
  var rings = [];
  for (var i=0;i<3;i++){
    var ring = makeWire(new THREE.TorusGeometry(2+i*0.5, 0.01, 8, 128), 0x00e5ff, 0.35);
    ring.rotation.x = Math.PI/2 + i*0.3;
    ring.rotation.y = i*0.4;
    root.add(ring); rings.push(ring);
  }
  var pCount = 500;
  var pGeo = new THREE.BufferGeometry();
  var positions = new Float32Array(pCount*3);
  for (var i=0;i<pCount;i++){
    var r = 3 + Math.random()*3, th = Math.random()*Math.PI*2, ph = Math.acos((Math.random()*2)-1);
    positions[i*3]=r*Math.sin(ph)*Math.cos(th); positions[i*3+1]=r*Math.sin(ph)*Math.sin(th); positions[i*3+2]=r*Math.cos(ph);
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(positions,3));
  var particles = new THREE.Points(pGeo, new THREE.PointsMaterial({ color:0x66f0ff, size:0.02, transparent:true, opacity:0.6 }));
  root.add(particles);
  scene.add(root);
  return {
    root: root,
    parts: { core: core },
    outerParts: [],
    update: function (t, pulse) {
      core.scale.setScalar(1+pulse*0.25); inner.scale.setScalar(1+pulse*0.4);
      core.rotation.y += 0.003+pulse*0.01; core.rotation.x += 0.001; inner.rotation.y -= 0.004;
      rings.forEach(function(ring,i){ ring.scale.setScalar(1+pulse*0.15+Math.sin(t*2+i)*0.02); ring.rotation.z += 0.002+i*0.001+pulse*0.005; ring.material.opacity = 0.25+pulse*0.4; });
      particles.rotation.y += 0.0006;
    }
  };
};

// -- engine --
SCENES.engine = function () {
  var root = new THREE.Group();
  var block = makeWire(new THREE.BoxGeometry(2.6, 3.2, 1.8), 0x22e8ff, 0.35);
  root.add(block);
  var crankshaft = makeSolid(new THREE.CylinderGeometry(0.18,0.18,2.2,16), 0x8ff5ff, 0.9);
  crankshaft.rotation.z = Math.PI/2;
  crankshaft.position.y = -1.2;
  root.add(crankshaft);
  var piston1 = makeSolid(new THREE.CylinderGeometry(0.35,0.35,0.7,20), 0x66f0ff, 0.9);
  piston1.position.set(-0.7, 0.3, 0);
  root.add(piston1);
  var piston2 = makeSolid(new THREE.CylinderGeometry(0.35,0.35,0.7,20), 0x66f0ff, 0.9);
  piston2.position.set(0.7, 0.3, 0);
  root.add(piston2);
  var valve = makeSolid(new THREE.CylinderGeometry(0.08,0.08,0.6,10), 0xff8844, 0.9);
  valve.position.set(-0.7, 1.5, 0);
  root.add(valve);
  scene.add(root);
  return {
    root: root,
    parts: { engineBlock: block, piston1: piston1, piston2: piston2, crankshaft: crankshaft, valve: valve },
    outerParts: [block],
    update: function (t) {
      crankshaft.rotation.x += 0.05;
      piston1.position.y = 0.3 + Math.sin(t*3)*0.5;
      piston2.position.y = 0.3 + Math.sin(t*3+Math.PI)*0.5;
      valve.position.y = 1.5 + Math.max(0, Math.sin(t*3))*0.2;
    }
  };
};

// -- heart --
SCENES.heart = function () {
  var root = new THREE.Group();
  var outer = makeWire(new THREE.SphereGeometry(1.6, 24, 24), 0xff5566, 0.28);
  outer.scale.set(1, 1.2, 1);
  root.add(outer);
  function chamber(x,y,color){ var m = makeSolid(new THREE.SphereGeometry(0.55,16,16), color, 0.85); m.position.set(x,y,0.2); root.add(m); return m; }
  var leftAtrium = chamber(-0.55, 0.7, 0x22e8ff);
  var rightAtrium = chamber(0.55, 0.7, 0x66f0ff);
  var leftVentricle = chamber(-0.55, -0.5, 0xff6688);
  var rightVentricle = chamber(0.55, -0.5, 0xff8899);
  var aorta = makeSolid(new THREE.CylinderGeometry(0.2,0.25,1.2,16), 0xaef6ff, 0.85);
  aorta.position.set(0, 1.7, 0);
  root.add(aorta);
  scene.add(root);
  return {
    root: root,
    parts: { heartOuter: outer, leftAtrium: leftAtrium, rightAtrium: rightAtrium, leftVentricle: leftVentricle, rightVentricle: rightVentricle, aorta: aorta },
    outerParts: [outer],
    update: function (t) {
      var beat = Math.max(0, Math.sin(t*2.2));
      root.scale.setScalar(1 + beat*0.08);
      leftAtrium.scale.setScalar(1 + Math.max(0,Math.sin(t*2.2+0.6))*0.15);
      rightAtrium.scale.setScalar(1 + Math.max(0,Math.sin(t*2.2+0.6))*0.15);
      leftVentricle.scale.setScalar(1 + beat*0.2);
      rightVentricle.scale.setScalar(1 + beat*0.2);
    }
  };
};

// -- dna --
SCENES.dna = function () {
  var root = new THREE.Group();
  var strandA = new THREE.Group(), strandB = new THREE.Group(), pairs = new THREE.Group();
  var N = 34, radius = 1.1, height = 5;
  for (var i=0;i<N;i++){
    var t0 = i/(N-1);
    var angle = t0 * Math.PI * 6;
    var y = height*(t0-0.5);
    var ax = Math.cos(angle)*radius, az = Math.sin(angle)*radius;
    var bx = Math.cos(angle+Math.PI)*radius, bz = Math.sin(angle+Math.PI)*radius;
    var sa = makeSolid(new THREE.SphereGeometry(0.09,8,8), 0x22e8ff, 0.9); sa.position.set(ax,y,az); strandA.add(sa);
    var sb = makeSolid(new THREE.SphereGeometry(0.09,8,8), 0xff8844, 0.9); sb.position.set(bx,y,bz); strandB.add(sb);
    if (i % 2 === 0) {
      var mid = new THREE.Vector3((ax+bx)/2,y,(az+bz)/2);
      var dist = Math.sqrt((ax-bx)*(ax-bx)+(az-bz)*(az-bz));
      var rung = makeSolid(new THREE.CylinderGeometry(0.03,0.03,dist,6), 0x8ff5ff, 0.6);
      rung.position.copy(mid);
      rung.lookAt(new THREE.Vector3(bx,y,bz));
      rung.rotateX(Math.PI/2);
      pairs.add(rung);
    }
  }
  root.add(strandA, strandB, pairs);
  var helicase = makeSolid(new THREE.ConeGeometry(0.25,0.5,12), 0xffee66, 0.95);
  root.add(helicase);
  scene.add(root);
  return {
    root: root,
    parts: { strandA: strandA, strandB: strandB, helicase: helicase },
    outerParts: [],
    update: function (t) {
      root.rotation.y += 0.004;
      var travel = (Math.sin(t*0.3)*0.5+0.5);
      helicase.position.y = height*(travel-0.5);
      helicase.position.x = Math.cos(travel*Math.PI*6)*radius*1.3;
      helicase.position.z = Math.sin(travel*Math.PI*6)*radius*1.3;
    }
  };
};

// -- blackhole --
SCENES.blackhole = function () {
  var root = new THREE.Group();
  var singularity = makeSolid(new THREE.SphereGeometry(0.5,24,24), 0x000000, 1.0);
  root.add(singularity);
  var eventHorizon = makeWire(new THREE.TorusGeometry(0.62, 0.015, 8, 64), 0xff8844, 0.9);
  eventHorizon.rotation.x = Math.PI/2.1;
  root.add(eventHorizon);
  var accretionDisk = makeWire(new THREE.TorusGeometry(1.6, 0.5, 8, 64), 0x22e8ff, 0.4);
  accretionDisk.rotation.x = Math.PI/2.1;
  root.add(accretionDisk);
  var gridGeo = new THREE.PlaneGeometry(8,8,40,40);
  var posAttr = gridGeo.attributes.position;
  for (var i=0;i<posAttr.count;i++){
    var x = posAttr.getX(i), y = posAttr.getY(i);
    var d = Math.sqrt(x*x+y*y);
    posAttr.setZ(i, -1.6/(d+0.6));
  }
  gridGeo.computeVertexNormals();
  var grid = new THREE.Mesh(gridGeo, new THREE.MeshBasicMaterial({ color:0x0a3a4a, wireframe:true, transparent:true, opacity:0.5 }));
  grid.rotation.x = Math.PI/2.4;
  grid.position.y = -1.5;
  root.add(grid);
  scene.add(root);
  return {
    root: root,
    parts: { singularity: singularity, eventHorizon: eventHorizon, accretionDisk: accretionDisk, grid: grid },
    outerParts: [],
    update: function (t) {
      accretionDisk.rotation.z += 0.01;
      eventHorizon.rotation.z -= 0.006;
    }
  };
};

// -- atom --
SCENES.atom = function () {
  var root = new THREE.Group();
  var nucleus = new THREE.Group();
  for (var i=0;i<7;i++){
    var particle = makeSolid(new THREE.SphereGeometry(0.16,10,10), i%2===0 ? 0xff6688 : 0xaef6ff, 0.9);
    var a = Math.random()*Math.PI*2, r = Math.random()*0.25;
    particle.position.set(Math.cos(a)*r, Math.sin(a)*r, (Math.random()-0.5)*0.3);
    nucleus.add(particle);
  }
  root.add(nucleus);
  var shells = [], electrons = [];
  var shellData = [{ r:1.3, tilt:0 }, { r:1.9, tilt:1.0 }, { r:2.4, tilt:2.0 }];
  var shellNames = ['shell1','shell2','shell3'];
  var parts = { nucleus: nucleus };
  shellData.forEach(function (s, idx) {
    var ring = makeWire(new THREE.TorusGeometry(s.r, 0.008, 8, 96), 0x22e8ff, 0.5);
    ring.rotation.x = s.tilt;
    root.add(ring); shells.push(ring);
    parts[shellNames[idx]] = ring;
    var e = makeSolid(new THREE.SphereGeometry(0.09,10,10), 0x66f0ff, 0.95);
    root.add(e); electrons.push({ mesh: e, r: s.r, tilt: s.tilt, speed: 0.6+idx*0.3, phase: idx*2 });
  });
  scene.add(root);
  return {
    root: root,
    parts: parts,
    outerParts: [],
    update: function (t) {
      nucleus.rotation.y += 0.01;
      electrons.forEach(function (el) {
        var a = t*el.speed + el.phase;
        var x = Math.cos(a)*el.r, y0 = Math.sin(a)*el.r;
        var y = y0*Math.cos(el.tilt), z = y0*Math.sin(el.tilt);
        el.mesh.position.set(x,y,z);
      });
    }
  };
};

function loadScene(name) {
  clearScene();
  var builder = SCENES[name] || SCENES.generic;
  currentSceneObj = builder();
  document.getElementById('label').textContent = (name || 'generic').toUpperCase() + ' — HOLOGRAPHIC MODEL';
  buildScenePicker(name);
}

function buildScenePicker(active) {
  var el = document.getElementById('scenePicker');
  el.innerHTML = '';
  Object.keys(SCENES).forEach(function (name) {
    var b = document.createElement('button');
    b.textContent = name;
    if (name === active) b.className = 'active';
    b.onclick = function () { loadScene(name); };
    el.appendChild(b);
  });
}

// ---------- camera control ----------
var camDefaultPos = new THREE.Vector3(0,0,7);
var camTargetPos = camDefaultPos.clone();
var camTargetLook = new THREE.Vector3(0,0,0);
var cutawayActive = false;

function focusOn(part) {
  if (!part) { resetCamera(); return; }
  var worldPos = new THREE.Vector3();
  part.getWorldPosition(worldPos);
  var dir = worldPos.clone().normalize();
  if (dir.lengthSq() < 0.0001) dir.set(0,0,1);
  camTargetPos = worldPos.clone().add(dir.multiplyScalar(2.4)).add(new THREE.Vector3(0,0,1));
  camTargetLook = worldPos.clone();
}
function resetCamera() {
  camTargetPos = camDefaultPos.clone();
  camTargetLook = new THREE.Vector3(0,0,0);
}
function setCutaway(on) {
  cutawayActive = on;
  if (!currentSceneObj) return;
  (currentSceneObj.outerParts || []).forEach(function (m) {
    m.material.opacity = on ? 0.08 : (m.userData.baseOpacity != null ? m.userData.baseOpacity : 0.35);
  });
}

// ---------- highlight ----------
var highlightedMesh = null, highlightBaseColor = null;
function highlight(part) {
  if (highlightedMesh && highlightBaseColor != null) highlightedMesh.material.color.setHex(highlightBaseColor);
  highlightedMesh = null;
  if (!part || !part.material || !part.material.color) return;
  highlightBaseColor = part.material.color.getHex();
  highlightedMesh = part;
}

// ---------- narration / segment playback ----------
var statusTxt = document.getElementById('statusTxt');
var freqTxt = document.getElementById('freqTxt');
var segTxt = document.getElementById('segTxt');
var caption = document.getElementById('caption');
var progressEl = document.getElementById('progress');
var speaking = false, paused = false, pulse = 0;
var rate = 1.0;
var segments = DATA.segments || [];
var segIndex = 0;

function buildProgressDots() {
  progressEl.innerHTML = '';
  segments.forEach(function (s, i) {
    var d = document.createElement('div');
    d.className = 'dot' + (i === segIndex ? ' active' : '');
    progressEl.appendChild(d);
  });
}
function updateProgressDots() {
  var dots = progressEl.children;
  for (var i=0;i<dots.length;i++) dots[i].className = 'dot' + (i === segIndex ? ' active' : '');
  segTxt.textContent = (segments.length ? segIndex+1 : 0) + '/' + segments.length;
}

function speakText(text, onEnd) {
  window.speechSynthesis.cancel();
  var utter = new SpeechSynthesisUtterance(text);
  utter.rate = rate; utter.pitch = 1.0;
  utter.onstart = function () { speaking = true; statusTxt.textContent = 'NARRATING'; };
  utter.onend = function () { speaking = false; statusTxt.textContent = 'IDLE'; if (onEnd) onEnd(); };
  utter.onboundary = function (e) {
    var upto = text.slice(0, e.charIndex + (e.charLength||0) + 20);
    caption.textContent = upto.length < text.length ? upto + '…' : text;
  };
  window.speechSynthesis.speak(utter);
}

function playSegment(i) {
  if (!segments.length) return;
  if (i < 0) i = 0;
  if (i >= segments.length) i = segments.length - 1;
  segIndex = i;
  paused = false;
  document.getElementById('playPause').textContent = '⏸ PAUSE';
  var seg = segments[segIndex];
  updateProgressDots();
  setCutaway(seg.camera === 'cutaway');
  if (seg.target && currentSceneObj && currentSceneObj.parts[seg.target]) {
    focusOn(currentSceneObj.parts[seg.target]);
    highlight(currentSceneObj.parts[seg.target]);
  } else if (seg.camera === 'default' || seg.camera === 'orbit' || !seg.target) {
    resetCamera();
    highlight(null);
  }
  caption.textContent = '';
  speakText(seg.text, function () {
    if (!paused && segIndex === i && segIndex < segments.length - 1) {
      playSegment(segIndex + 1);
    }
  });
}

function togglePause() {
  if (!segments.length) return;
  if (speaking && !paused) {
    window.speechSynthesis.cancel();
    paused = true;
    statusTxt.textContent = 'PAUSED';
    document.getElementById('playPause').textContent = '▶ RESUME';
  } else {
    paused = false;
    document.getElementById('playPause').textContent = '⏸ PAUSE';
    playSegment(segIndex);
  }
}

// ---------- command parsing (voice + text) ----------
function handleCommand(raw) {
  var cmd = (raw || '').trim().toLowerCase();
  if (!cmd) return;
  if (cmd.indexOf('stop') !== -1 || cmd.indexOf('pause') !== -1) {
    window.speechSynthesis.cancel(); paused = true; statusTxt.textContent = 'PAUSED';
    document.getElementById('playPause').textContent = '▶ RESUME'; return;
  }
  if (cmd.indexOf('continue') !== -1 || cmd.indexOf('resume') !== -1) { paused = false; playSegment(segIndex); return; }
  if (cmd.indexOf('repeat') !== -1 || cmd === 'again') { playSegment(segIndex); return; }
  if (cmd.indexOf('back') !== -1 || cmd.indexOf('previous') !== -1) { playSegment(segIndex - 1); return; }
  if (cmd.indexOf('next') !== -1 || cmd.indexOf('skip') !== -1) { playSegment(segIndex + 1); return; }
  if (cmd.indexOf('zoom out') !== -1) { resetCamera(); return; }
  if (cmd.indexOf('zoom in') !== -1 && cmd.indexOf('zoom into') === -1) {
    if (highlightedMesh) focusOn(highlightedMesh); return;
  }
  if (cmd.indexOf('zoom into') !== -1 || cmd.indexOf('zoom to') !== -1 || cmd.indexOf('show me the') !== -1 || cmd.indexOf('show ') === 0) {
    var q = cmd.replace('zoom into','').replace('zoom to','').replace('show me the','').replace('show','').trim();
    if (currentSceneObj) {
      var keys = Object.keys(currentSceneObj.parts);
      for (var i=0;i<keys.length;i++){
        if (keys[i].toLowerCase().indexOf(q) !== -1 || q.indexOf(keys[i].toLowerCase()) !== -1) {
          focusOn(currentSceneObj.parts[keys[i]]); highlight(currentSceneObj.parts[keys[i]]); return;
        }
      }
    }
    return;
  }
  if (cmd.indexOf('slower') !== -1) { rate = Math.max(0.5, rate - 0.2); playSegment(segIndex); return; }
  if (cmd.indexOf('faster') !== -1) { rate = Math.min(2.0, rate + 0.2); playSegment(segIndex); return; }
  // fallback: treat as free text to narrate immediately (adhoc mode)
  paused = false;
  speakText(raw, function () {});
}

// ---------- UI wiring ----------
document.getElementById('playPause').onclick = togglePause;
document.getElementById('repeat').onclick = function () { playSegment(segIndex); };
document.getElementById('prev').onclick = function () { playSegment(segIndex - 1); };
document.getElementById('next').onclick = function () { playSegment(segIndex + 1); };
document.getElementById('send').onclick = function () {
  var el = document.getElementById('text');
  if (el.value.trim()) { handleCommand(el.value.trim()); el.value = ''; }
};
document.getElementById('text').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('send').click();
});

// ---------- voice recognition (optional, gated behind button press) ----------
var recognition = null, listening = false;
var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.onresult = function (e) {
    var res = e.results[e.results.length - 1];
    if (res.isFinal) handleCommand(res[0].transcript);
  };
  recognition.onend = function () { if (listening) recognition.start(); };
}
document.getElementById('mic').onclick = function () {
  if (!recognition) { alert('Voice recognition is not supported in this browser — use the text box instead.'); return; }
  listening = !listening;
  this.className = listening ? 'on' : '';
  if (listening) recognition.start(); else recognition.stop();
};

// ---------- animation loop ----------
var t = 0;
function animate() {
  requestAnimationFrame(animate);
  t += 0.01;
  var target = speaking ? (0.5 + Math.sin(t*14)*0.5) : 0.15;
  pulse += (target - pulse) * 0.15;
  freqTxt.textContent = Math.round(pulse*440 + 220);

  if (currentSceneObj && currentSceneObj.update) currentSceneObj.update(t, pulse);
  if (highlightedMesh && highlightedMesh.material && highlightedMesh.material.color) {
    var glow = 0.6 + Math.sin(t*6)*0.4;
    highlightedMesh.material.color.setHSL(0.5, 1, Math.min(0.85, 0.4 + glow*0.3));
  }

  camera.position.lerp(camTargetPos, 0.06);
  camLookAt.lerp(camTargetLook, 0.06);
  camera.lookAt(camLookAt);

  renderer.render(scene, camera);
}
animate();

// ---------- boot ----------
loadScene(DATA.scene || 'generic');
buildProgressDots();
updateProgressDots();
if (segments.length) {
  setTimeout(function () { playSegment(0); }, 700);
} else {
  statusTxt.textContent = 'IDLE';
}
</script>
</body>
</html>`;
}

export const HOLO_NARRATOR_TOOLS = [
  {
    name: 'show_holo_narrator',
    declaration: {
      name: 'show_holo_narrator',
      description:
        'Opens an interactive, real-time 3D holographic teacher (WebGL scene + synchronized text-to-speech), JARVIS-style. Give it a built-in scene (engine, heart, dna, blackhole, atom, or generic) and an ordered script of narration segments; each segment is spoken aloud while the camera automatically focuses/zooms on the named part and highlights it. The user can interrupt live by voice or text with commands like "stop", "repeat", "go back", "next", "zoom into <part>", "slower", "faster".',
      parameters: {
        type: 'object',
        properties: {
          scene: {
            type: 'string',
            enum: ['engine', 'heart', 'dna', 'blackhole', 'atom', 'generic'],
            description: 'Which built-in 3D scene to load. Use "generic" for topics without a dedicated model (shows a holographic core instead).',
          },
          segments: {
            type: 'array',
            description: 'Ordered narration script. Each item is spoken while the camera focuses on `target` (a part name from the scene) with the given `camera` behavior.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The line of narration to speak for this segment.' },
                target: { type: 'string', description: 'Name of the part in the scene to focus the camera on and highlight (see tool description for part names per scene). Optional.' },
                camera: { type: 'string', enum: ['orbit', 'zoom', 'cutaway', 'default'], description: 'Camera behavior for this segment. "cutaway" fades the outer shell (engine block / heart outer wall) to reveal internals. Optional.' },
              },
              required: ['text'],
            },
          },
          narration: {
            type: 'string',
            description: 'Legacy: a single line to narrate immediately (used only if `segments` is omitted).',
          },
        },
      },
    },
    async execute(args = {}) {
      await ensureOutputDir();
      var scene = args.scene || 'generic';
      var segments = Array.isArray(args.segments) && args.segments.length
        ? args.segments
        : (args.narration ? [{ text: args.narration }] : []);
      const filename = `holo_teacher_${Date.now().toString(36)}.html`;
      const filepath = path.join(OUTPUT_DIR, filename);
      await fs.writeFile(filepath, buildHoloHtml(scene, segments), 'utf-8');
      openFile(filepath);
      return `✅ Holo-teacher online → ${path.resolve(filepath)} (scene: ${scene}, ${segments.length} segment(s))`;
    },
  },
];

