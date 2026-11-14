// ── Blender Render Tools ────────────────────────────────────────────────────
// Gives Jojo real photoreal rendering by driving a LOCALLY INSTALLED copy of
// Blender headless via its Python API (bpy). This is genuinely different from
// the live Three.js holo-teacher: Blender's Cycles engine does real
// path-traced global illumination, so output images/video are actually
// photoreal — but rendering is NOT real-time (seconds to minutes per frame
// depending on GPU/samples), so this produces baked stills/video, not a
// live-navigable scene. Pair it with `show_rendered_teacher` (see
// blender_teacher_viewer.js) to narrate over the rendered output.
//
// REQUIRES: Blender installed locally (blender.org/download — free).
// Set BLENDER_PATH in .env if `blender` isn't on your system PATH, e.g.
//   BLENDER_PATH=C:\Program Files\Blender Foundation\Blender 4.2\blender.exe
//
// Tools:
//   blender_render_still      — one photoreal image, from a real asset file
//                                 (.glb/.gltf/.fbx/.obj/.blend) OR a built-in
//                                 procedural topic.
//   blender_render_turntable  — same, but a short orbiting mp4.

import fs   from 'fs/promises';
import fss  from 'fs';
import path from 'path';
import os   from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const OUTPUT_DIR = './output';
const RENDER_TIMEOUT = parseInt(process.env.BLENDER_TIMEOUT_MS || '600000'); // 10 min default

// ── locate the Blender executable ───────────────────────────────────────────
function candidatePaths() {
  const list = [];
  if (process.env.BLENDER_PATH) list.push(process.env.BLENDER_PATH);
  if (process.platform === 'win32') {
    list.push('blender'); // if on PATH
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    // common install dir, version-agnostic glob handled below
    list.push(path.join(pf, 'Blender Foundation'));
  } else if (process.platform === 'darwin') {
    list.push('blender');
    list.push('/Applications/Blender.app/Contents/MacOS/Blender');
  } else {
    list.push('blender');
    list.push('/usr/bin/blender');
    list.push('/snap/bin/blender');
  }
  return list;
}

let cachedBlenderExe = null;

async function findBlender() {
  if (cachedBlenderExe) return cachedBlenderExe;
  for (const candidate of candidatePaths()) {
    try {
      if (candidate === 'blender') {
        const checkCmd = process.platform === 'win32' ? 'where blender' : 'which blender';
        const { stdout } = await execAsync(checkCmd);
        if (stdout.trim()) { cachedBlenderExe = 'blender'; return cachedBlenderExe; }
        continue;
      }
      if (candidate.endsWith('Blender Foundation')) {
        // scan for "Blender X.Y" subfolder and blender.exe inside it
        if (fss.existsSync(candidate)) {
          const versions = fss.readdirSync(candidate).filter(d => d.startsWith('Blender'));
          for (const v of versions.sort().reverse()) {
            const exe = path.join(candidate, v, 'blender.exe');
            if (fss.existsSync(exe)) { cachedBlenderExe = exe; return cachedBlenderExe; }
          }
        }
        continue;
      }
      if (fss.existsSync(candidate)) { cachedBlenderExe = candidate; return cachedBlenderExe; }
    } catch { /* try next candidate */ }
  }
  return null;
}

function installInstructions() {
  const platform = process.platform;
  const lines = [
    'Error: Blender was not found on this system.',
    '',
    'Install it (free):',
  ];
  if (platform === 'win32') {
    lines.push(
      '  1. Download the Windows installer from https://www.blender.org/download/',
      '  2. Run it (default install location is fine).',
      '  3. Either add Blender\'s install folder to your system PATH, OR set BLENDER_PATH',
      '     in your .env file to the full path of blender.exe, e.g.:',
      '     BLENDER_PATH=C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
    );
  } else if (platform === 'darwin') {
    lines.push(
      '  brew install --cask blender',
      '  (or download the .dmg from https://www.blender.org/download/)',
    );
  } else {
    lines.push(
      '  sudo snap install blender --classic',
      '  (or: sudo apt install blender)',
    );
  }
  return lines.join('\n');
}

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

// ── procedural topic library (built with real Blender primitives + Cycles
//    PBR/subsurface/glass shaders — a genuine step up in per-pixel realism
//    over the flat WebGL wireframe scenes, via true path-traced lighting.
//    NOTE: these are still parametric shapes, not sculpted medical-grade
//    geometry. For true sculpted anatomy, pass `asset_path` to a real
//    licensed .glb/.fbx/.blend model instead — see tool description. ──────
const PROCEDURAL_TOPICS = new Set(['engine', 'heart', 'dna', 'blackhole', 'atom']);

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

function buildProceduralPython(topic, focus) {
  // Returns a bpy snippet that builds the requested topic and returns the
  // Blender object name to frame the camera on (or None for a wide shot).
  const common = `
def add_material(obj, color, metallic=0.0, roughness=0.4, transmission=0.0, emission_strength=0.0):
    mat = bpy.data.materials.new(name=obj.name + "_mat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if "Transmission Weight" in bsdf.inputs:
        bsdf.inputs["Transmission Weight"].default_value = transmission
    elif "Transmission" in bsdf.inputs:
        bsdf.inputs["Transmission"].default_value = transmission
    if emission_strength > 0:
        bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    obj.data.materials.append(mat)
    return mat
`;

  let build = '';
  let focusVar = 'None';

  if (topic === 'engine') {
    build = `
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0))
block = bpy.context.active_object
block.scale = (1.3, 1.6, 0.9)
block.name = "engineBlock"
add_material(block, (0.15,0.15,0.17), metallic=0.9, roughness=0.35)

bpy.ops.mesh.primitive_cylinder_add(radius=0.18, depth=0.45, location=(-0.4, 0.15, 0.55))
piston1 = bpy.context.active_object
piston1.name = "piston1"
add_material(piston1, (0.7,0.72,0.75), metallic=1.0, roughness=0.15)

bpy.ops.mesh.primitive_cylinder_add(radius=0.18, depth=0.45, location=(0.4, 0.15, 0.55))
piston2 = bpy.context.active_object
piston2.name = "piston2"
add_material(piston2, (0.7,0.72,0.75), metallic=1.0, roughness=0.15)

bpy.ops.mesh.primitive_cylinder_add(radius=0.1, depth=1.3, rotation=(0,1.5708,0), location=(0,0,-0.6))
crank = bpy.context.active_object
crank.name = "crankshaft"
add_material(crank, (0.6,0.6,0.65), metallic=1.0, roughness=0.1)
`;
    focusVar = focus && ['engineBlock','piston1','piston2','crankshaft'].includes(focus) ? `"${focus}"` : '"engineBlock"';
  } else if (topic === 'heart') {
    build = `
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.9, location=(0,0,0))
outer = bpy.context.active_object
outer.scale = (1,1.25,1)
outer.name = "heartOuter"
add_material(outer, (0.55,0.05,0.08), roughness=0.3, transmission=0.05)

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.32, location=(-0.32,0.42,0.1))
la = bpy.context.active_object; la.name = "leftAtrium"
add_material(la, (0.15,0.35,0.75), roughness=0.35)

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.32, location=(0.32,0.42,0.1))
ra = bpy.context.active_object; ra.name = "rightAtrium"
add_material(ra, (0.35,0.5,0.85), roughness=0.35)

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.4, location=(-0.32,-0.3,0.1))
lv = bpy.context.active_object; lv.name = "leftVentricle"
add_material(lv, (0.65,0.08,0.1), roughness=0.3)

bpy.ops.mesh.primitive_uv_sphere_add(radius=0.4, location=(0.32,-0.3,0.1))
rv = bpy.context.active_object; rv.name = "rightVentricle"
add_material(rv, (0.6,0.15,0.15), roughness=0.3)

bpy.ops.mesh.primitive_cylinder_add(radius=0.15, depth=0.7, location=(0,1.0,0))
aorta = bpy.context.active_object; aorta.name = "aorta"
add_material(aorta, (0.75,0.55,0.5), roughness=0.4)
`;
    focusVar = focus && ['heartOuter','leftAtrium','rightAtrium','leftVentricle','rightVentricle','aorta'].includes(focus) ? `"${focus}"` : '"heartOuter"';
  } else if (topic === 'dna') {
    build = `
import math
strandA = []
strandB = []
for i in range(30):
    t = i/29
    angle = t*math.pi*6
    y = 3.2*(t-0.5)
    ax, az = math.cos(angle)*0.9, math.sin(angle)*0.9
    bx, bz = math.cos(angle+math.pi)*0.9, math.sin(angle+math.pi)*0.9
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.06, location=(ax,y,az))
    sa = bpy.context.active_object; sa.name = f"strandA_{i}"
    add_material(sa, (0.1,0.7,0.85), metallic=0.3, roughness=0.3)
    strandA.append(sa)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.06, location=(bx,y,bz))
    sb = bpy.context.active_object; sb.name = f"strandB_{i}"
    add_material(sb, (0.9,0.5,0.15), metallic=0.3, roughness=0.3)
    strandB.append(sb)

bpy.ops.mesh.primitive_cone_add(radius1=0.12, depth=0.3, location=(0,0,1.3))
helicase = bpy.context.active_object
helicase.name = "helicase"
add_material(helicase, (0.95,0.85,0.2), emission_strength=1.5)
`;
    focusVar = focus === 'helicase' ? '"helicase"' : '"strandA_15"';
  } else if (topic === 'blackhole') {
    build = `
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(0,0,0))
sing = bpy.context.active_object
sing.name = "singularity"
add_material(sing, (0,0,0), roughness=0.0)

bpy.ops.mesh.primitive_torus_add(major_radius=1.6, minor_radius=0.35, location=(0,0,0))
disk = bpy.context.active_object
disk.name = "accretionDisk"
disk.rotation_euler = (1.55, 0, 0)
add_material(disk, (1.0,0.45,0.1), emission_strength=4.0, roughness=0.5)

bpy.ops.mesh.primitive_torus_add(major_radius=0.62, minor_radius=0.02, location=(0,0,0))
horizon = bpy.context.active_object
horizon.name = "eventHorizon"
add_material(horizon, (1.0,0.7,0.3), emission_strength=2.0)
`;
    focusVar = focus && ['singularity','accretionDisk','eventHorizon'].includes(focus) ? `"${focus}"` : '"accretionDisk"';
  } else if (topic === 'atom') {
    build = `
import random, math
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.35, location=(0,0,0))
nucleus = bpy.context.active_object
nucleus.name = "nucleus"
add_material(nucleus, (0.9,0.3,0.35), roughness=0.3, emission_strength=0.5)

shells = [1.3, 1.9, 2.4]
for idx, r in enumerate(shells):
    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=0.02, location=(0,0,0))
    ring = bpy.context.active_object
    ring.name = f"shell{idx+1}"
    ring.rotation_euler = (idx*0.8, idx*0.5, 0)
    add_material(ring, (0.2,0.8,0.95), emission_strength=1.2)
    angle = idx*2.1
    ex, ey = math.cos(angle)*r, math.sin(angle)*r
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(ex,ey,0))
    e = bpy.context.active_object
    e.name = f"electron{idx+1}"
    add_material(e, (0.4,0.9,1.0), emission_strength=2.0)
`;
    focusVar = focus && ['nucleus','shell1','shell2','shell3'].includes(focus) ? `"${focus}"` : '"nucleus"';
  }

  return common + build + `\nFOCUS_NAME = ${focusVar}\n`;
}

function buildImportPython(assetPath, focus) {
  const ext = path.extname(assetPath).toLowerCase();
  const p = pyStr(assetPath.replace(/\\/g, '/'));
  let importCall;
  if (ext === '.glb' || ext === '.gltf') importCall = `bpy.ops.import_scene.gltf(filepath=${p})`;
  else if (ext === '.fbx') importCall = `bpy.ops.import_scene.fbx(filepath=${p})`;
  else if (ext === '.obj') importCall = `bpy.ops.wm.obj_import(filepath=${p})`;
  else if (ext === '.blend') importCall = `
with bpy.data.libraries.load(${p}, link=False) as (data_from, data_to):
    data_to.objects = data_from.objects
for obj in data_to.objects:
    if obj is not None:
        bpy.context.collection.objects.link(obj)
`;
  else throw new Error(`Unsupported asset type "${ext}". Use .glb, .gltf, .fbx, .obj, or .blend.`);

  const focusExpr = focus ? pyStr(focus) : 'None';
  return `
before = set(o.name for o in bpy.data.objects)
${importCall}
imported = [o for o in bpy.data.objects if o.name not in before]
FOCUS_NAME = ${focusExpr}
if FOCUS_NAME is None and imported:
    FOCUS_NAME = imported[0].name
`;
}

function buildFullScript({ sceneSetupPy, mode, resolutionX, resolutionY, samples, engine, outputPath, frames }) {
  return `
import bpy, math, mathutils

# ── clear default scene ──────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

${sceneSetupPy}

# ── frame everything / compute focus point ──────────────────────────────
def world_bbox_center_and_radius(objs):
    import mathutils
    pts = []
    for o in objs:
        if o.type != 'MESH':
            continue
        for corner in o.bound_box:
            pts.append(o.matrix_world @ mathutils.Vector(corner))
    if not pts:
        return mathutils.Vector((0,0,0)), 2.0
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    center = mathutils.Vector(((min(xs)+max(xs))/2, (min(ys)+max(ys))/2, (min(zs)+max(zs))/2))
    radius = max(max(xs)-min(xs), max(ys)-min(ys), max(zs)-min(zs)) / 2.0
    return center, max(radius, 0.5)

all_objs = [o for o in bpy.data.objects if o.type == 'MESH']
scene_center, scene_radius = world_bbox_center_and_radius(all_objs)

focus_obj = bpy.data.objects.get(FOCUS_NAME) if 'FOCUS_NAME' in dir() else None
if focus_obj is not None:
    target_center, target_radius = world_bbox_center_and_radius([focus_obj])
    dist = max(target_radius * 3.2, 1.6)
    look_at = target_center
else:
    dist = scene_radius * 3.0
    look_at = scene_center

# ── camera ────────────────────────────────────────────────────────────────
cam_data = bpy.data.cameras.new("Camera")
cam_obj = bpy.data.objects.new("Camera", cam_data)
bpy.context.collection.objects.link(cam_obj)
bpy.context.scene.camera = cam_obj

cam_empty = bpy.data.objects.new("CamPivot", None)
cam_empty.location = look_at
bpy.context.collection.objects.link(cam_empty)
cam_obj.location = look_at + mathutils.Vector((dist*0.8, -dist*1.1, dist*0.5))
cam_obj.parent = cam_empty

direction = look_at - cam_obj.matrix_world.translation
cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

# ── three-point studio lighting ──────────────────────────────────────────
def add_area_light(name, location, energy, size, color=(1,1,1)):
    ldata = bpy.data.lights.new(name=name, type='AREA')
    ldata.energy = energy
    ldata.size = size
    ldata.color = color
    lobj = bpy.data.objects.new(name, ldata)
    lobj.location = location
    bpy.context.collection.objects.link(lobj)
    direction = look_at - lobj.location
    lobj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    return lobj

key_dist = max(dist, scene_radius*2.5)
add_area_light("KeyLight",  look_at + mathutils.Vector((key_dist, -key_dist, key_dist*1.3)), energy=max(400, key_dist*180), size=key_dist*0.6)
add_area_light("FillLight", look_at + mathutils.Vector((-key_dist*0.9, -key_dist*0.4, key_dist*0.5)), energy=max(150, key_dist*70), size=key_dist*0.8, color=(0.8,0.9,1.0))
add_area_light("RimLight",  look_at + mathutils.Vector((0, key_dist, key_dist*0.6)), energy=max(200, key_dist*100), size=key_dist*0.4, color=(0.6,0.9,1.0))

# ── world background (soft gradient, no external HDRI file needed) ──────
world = bpy.context.scene.world
world.use_nodes = True
bg = world.node_tree.nodes.get("Background")
bg.inputs[0].default_value = (0.01, 0.02, 0.03, 1.0)
bg.inputs[1].default_value = 0.6

# ── render settings ───────────────────────────────────────────────────────
scene = bpy.context.scene
scene.render.engine = ${pyStr(engine)}
scene.render.resolution_x = ${resolutionX}
scene.render.resolution_y = ${resolutionY}
scene.render.film_transparent = False
if scene.render.engine == 'CYCLES':
    scene.cycles.samples = ${samples}
    scene.cycles.use_denoising = True
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'CUDA'
        scene.cycles.device = 'GPU'
    except Exception:
        scene.cycles.device = 'CPU'
else:
    try:
        scene.eevee.taa_render_samples = ${samples}
    except Exception:
        pass

${frames}

print("JOJO_RENDER_DONE:${pyStr(outputPath).slice(1, -1)}")
`;
}

async function runBlenderScript(pythonCode) {
  const blenderExe = await findBlender();
  if (!blenderExe) return { error: installInstructions() };

  await ensureOutputDir();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jojo-blender-'));
  const scriptPath = path.join(tmpDir, 'render.py');
  await fs.writeFile(scriptPath, pythonCode, 'utf-8');

  const quoted = blenderExe.includes(' ') ? `"${blenderExe}"` : blenderExe;
  const command = `${quoted} --background --factory-startup --python "${scriptPath}"`;

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: RENDER_TIMEOUT,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    if (err.killed) {
      return { error: `Blender render timed out after ${RENDER_TIMEOUT / 1000}s. Try fewer samples, a smaller resolution, or 'EEVEE' instead of 'CYCLES'.` };
    }
    return { error: `Blender error (exit ${err.code ?? '?'}): ${String(err.stderr || err.stdout || err.message).trim()}` };
  }
}

function resolveResolution(resolution) {
  const map = { low: [960, 540], medium: [1280, 720], high: [1920, 1080] };
  return map[resolution] || map.medium;
}

// ── shared param schema pieces ──────────────────────────────────────────────
const commonProps = {
  topic: {
    type: 'string',
    enum: ['engine', 'heart', 'dna', 'blackhole', 'atom'],
    description: 'A built-in procedural topic to render (no asset file needed). Omit this if using asset_path instead.',
  },
  asset_path: {
    type: 'string',
    description: 'Path to a real 3D model file to render instead of a procedural topic (.glb, .gltf, .fbx, .obj, or .blend). Use this for true sculpted/photoreal assets.',
  },
  focus: {
    type: 'string',
    description: 'Name of the part/object to frame the camera on. For procedural topics use the part names from show_holo_narrator (e.g. "crankshaft", "leftVentricle"). For asset_path, use the object name inside the file, or omit to auto-frame the whole model.',
  },
  engine: {
    type: 'string',
    enum: ['CYCLES', 'EEVEE'],
    description: 'CYCLES = real path-traced photoreal (slower). EEVEE = fast real-time-ish PBR rasterizer (much faster, still realistic). Default: CYCLES.',
  },
  samples: {
    type: 'number',
    description: 'Render quality (Cycles samples / Eevee TAA samples). Higher = cleaner but slower. Default: 64.',
  },
  resolution: {
    type: 'string',
    enum: ['low', 'medium', 'high'],
    description: 'Output resolution: low=960x540 (fast), medium=1280x720, high=1920x1080 (slow). Default: medium.',
  },
};

export const BLENDER_TOOLS = [
  {
    name: 'blender_render_still',
    declaration: {
      name: 'blender_render_still',
      description:
        'Renders ONE real photoreal image using a locally-installed Blender (Cycles path-traced global illumination — an actual production renderer, not a live WebGL scene). ' +
        'Use topic for a quick built-in procedural scene, or asset_path to render a real licensed 3D model (.glb/.gltf/.fbx/.obj/.blend) for true sculpted-quality visuals. ' +
        'This is NOT real-time — rendering can take from several seconds to a few minutes. Requires Blender installed locally (see tool error message for install instructions if missing).',
      parameters: {
        type: 'object',
        properties: commonProps,
      },
    },
    async execute(args = {}) {
      try {
        const { topic, asset_path, focus, engine = 'CYCLES', samples = 64, resolution = 'medium' } = args;
        if (!topic && !asset_path) return 'Error: provide either `topic` (built-in scene) or `asset_path` (a real model file).';
        if (topic && !PROCEDURAL_TOPICS.has(topic)) return `Error: unknown topic "${topic}". Use one of: ${[...PROCEDURAL_TOPICS].join(', ')}.`;
        if (asset_path && !fss.existsSync(asset_path)) return `Error: asset file not found at "${asset_path}".`;

        const [resX, resY] = resolveResolution(resolution);
        await ensureOutputDir();
        const outName = `blender_still_${Date.now().toString(36)}.png`;
        const outPath = path.resolve(OUTPUT_DIR, outName);

        const sceneSetupPy = asset_path ? buildImportPython(asset_path, focus) : buildProceduralPython(topic, focus);
        const framesPy = `
scene.render.filepath = ${pyStr(outPath.replace(/\\/g, '/'))}
bpy.ops.render.render(write_still=True)
`;
        const script = buildFullScript({
          sceneSetupPy, mode: 'still',
          resolutionX: resX, resolutionY: resY, samples, engine,
          outputPath: outPath, frames: framesPy,
        });

        const result = await runBlenderScript(script);
        if (result.error) return result.error;
        if (!fss.existsSync(outPath)) {
          return `Blender ran but no output file was produced. Blender log:\n${(result.stdout || '').slice(-2000)}\n${(result.stderr || '').slice(-2000)}`;
        }
        return `✅ Photoreal render complete → ${outPath}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },

  {
    name: 'blender_render_turntable',
    declaration: {
      name: 'blender_render_turntable',
      description:
        'Renders a short orbiting turntable VIDEO (mp4) of a scene using a locally-installed Blender (Cycles photoreal or Eevee). ' +
        'Same topic/asset_path/focus options as blender_render_still. Rendering many frames is slow — keep samples/resolution modest unless you have a strong GPU and time to spare.',
      parameters: {
        type: 'object',
        properties: {
          ...commonProps,
          seconds: { type: 'number', description: 'Length of the turntable orbit in seconds at 24fps (default: 4 = 96 frames).' },
        },
      },
    },
    async execute(args = {}) {
      try {
        const { topic, asset_path, focus, engine = 'EEVEE', samples = 32, resolution = 'medium', seconds = 4 } = args;
        if (!topic && !asset_path) return 'Error: provide either `topic` (built-in scene) or `asset_path` (a real model file).';
        if (topic && !PROCEDURAL_TOPICS.has(topic)) return `Error: unknown topic "${topic}". Use one of: ${[...PROCEDURAL_TOPICS].join(', ')}.`;
        if (asset_path && !fss.existsSync(asset_path)) return `Error: asset file not found at "${asset_path}".`;

        const [resX, resY] = resolveResolution(resolution);
        const totalFrames = Math.max(12, Math.round(seconds * 24));
        await ensureOutputDir();
        const outName = `blender_turntable_${Date.now().toString(36)}.mp4`;
        const outPath = path.resolve(OUTPUT_DIR, outName);

        const sceneSetupPy = asset_path ? buildImportPython(asset_path, focus) : buildProceduralPython(topic, focus);
        const framesPy = `
scene.render.filepath = ${pyStr(outPath.replace(/\\/g, '/'))}
scene.render.image_settings.file_format = 'FFMPEG'
scene.render.ffmpeg.format = 'MPEG4'
scene.render.ffmpeg.codec = 'H264'
scene.frame_start = 1
scene.frame_end = ${totalFrames}
cam_empty.rotation_mode = 'XYZ'
cam_empty.keyframe_insert(data_path="rotation_euler", index=2, frame=1)
cam_empty.rotation_euler[2] = 6.28318
cam_empty.keyframe_insert(data_path="rotation_euler", index=2, frame=${totalFrames})
for fc in cam_empty.animation_data.action.fcurves:
    for kp in fc.keyframe_points:
        kp.interpolation = 'LINEAR'
bpy.ops.render.render(animation=True)
`;
        const script = buildFullScript({
          sceneSetupPy, mode: 'turntable',
          resolutionX: resX, resolutionY: resY, samples, engine,
          outputPath: outPath, frames: framesPy,
        });

        const result = await runBlenderScript(script);
        if (result.error) return result.error;
        if (!fss.existsSync(outPath)) {
          return `Blender ran but no video file was produced. Blender log:\n${(result.stdout || '').slice(-2000)}\n${(result.stderr || '').slice(-2000)}`;
        }
        return `✅ Photoreal turntable render complete → ${outPath}`;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    },
  },
];

