// ── Unreal Engine Tools ──────────────────────────────────────────────────────
// Gives Jojo the ability to drive a LOCALLY INSTALLED copy of Unreal Engine —
// building, packaging, and running commandlets against real .uproject files.
// This mirrors blender_tools.js: Jojo does not ship or embed Unreal itself,
// it shells out to a real Epic Games Launcher (or source-built) install on
// this machine.
//
// REQUIRES: Unreal Engine installed locally via the Epic Games Launcher
// (epicgames.com/store/download — free) or built from source.
// Set UNREAL_PATH in .env if auto-detection fails, pointing at the engine
// ROOT install folder, e.g.:
//   UNREAL_PATH=C:\Program Files\Epic Games\UE_5.4
//
// Tools:
//   unreal_open_editor        — launch the full editor GUI on a .uproject
//   unreal_generate_projectfiles — regenerate the Visual Studio solution
//   unreal_build_project      — compile a project's C++ (UnrealBuildTool)
//   unreal_run_commandlet     — run a headless editor commandlet
//   unreal_package_project    — cook + package a shippable build (RunUAT)

import fs   from 'fs/promises';
import fss  from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const BUILD_TIMEOUT   = parseInt(process.env.UNREAL_BUILD_TIMEOUT_MS   || '1800000'); // 30 min
const PACKAGE_TIMEOUT = parseInt(process.env.UNREAL_PACKAGE_TIMEOUT_MS || '3600000'); // 60 min

// ── locate the Unreal Engine root install folder ────────────────────────────
function candidateRoots() {
  const list = [];
  if (process.env.UNREAL_PATH) list.push(process.env.UNREAL_PATH);
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    list.push(path.join(pf, 'Epic Games'));
  } else if (process.platform === 'darwin') {
    list.push('/Users/Shared/Epic Games');
  } else {
    list.push(path.join(process.env.HOME || '', 'UnrealEngine'));
  }
  return list;
}

let cachedRoot = null;

async function findEngineRoot() {
  if (cachedRoot) return cachedRoot;
  for (const candidate of candidateRoots()) {
    try {
      if (!fss.existsSync(candidate)) continue;
      // direct hit: candidate itself is an engine root (has Engine/Binaries)
      if (fss.existsSync(path.join(candidate, 'Engine', 'Binaries'))) {
        cachedRoot = candidate; return cachedRoot;
      }
      // Epic Games folder: scan for UE_5.x subfolders, prefer newest
      const versions = fss.readdirSync(candidate).filter(d => d.startsWith('UE_'));
      for (const v of versions.sort().reverse()) {
        const root = path.join(candidate, v);
        if (fss.existsSync(path.join(root, 'Engine', 'Binaries'))) {
          cachedRoot = root; return cachedRoot;
        }
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

function exePaths(root) {
  const win = process.platform === 'win32';
  return {
    editor:      path.join(root, 'Engine', 'Binaries', 'Win64', win ? 'UnrealEditor.exe' : 'UnrealEditor'),
    editorCmd:   path.join(root, 'Engine', 'Binaries', 'Win64', win ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor-Cmd'),
    buildBat:    path.join(root, 'Engine', 'Build', 'BatchFiles', win ? 'Build.bat' : 'Build.sh'),
    genProjBat:  path.join(root, 'Engine', 'Build', 'BatchFiles', win ? 'GenerateProjectFiles.bat' : 'GenerateProjectFiles.sh'),
    runUatBat:   path.join(root, 'Engine', 'Build', 'BatchFiles', win ? 'RunUAT.bat' : 'RunUAT.sh'),
  };
}

function installInstructions() {
  const platform = process.platform;
  const lines = [
    'Error: Unreal Engine was not found on this system.',
    '',
    'Install it (free, requires a free Epic Games account):',
    '  1. Download the Epic Games Launcher: https://www.epicgames.com/store/download',
    '  2. In the launcher: Unreal Engine tab -> Library -> "+" -> install the latest 5.x.',
  ];
  if (platform === 'win32') {
    lines.push(
      '  3. Also install Visual Studio 2022 with the "Game development with C++" workload',
      '     (pulls in the Windows SDK + Unreal VS integration automatically).',
      '  4. If auto-detection still fails, set UNREAL_PATH in your .env to the engine root, e.g.:',
      '     UNREAL_PATH=C:\\Program Files\\Epic Games\\UE_5.4',
    );
  } else if (platform === 'darwin') {
    lines.push('  3. Install Xcode from the App Store (required to compile).');
  } else {
    lines.push('  3. On Linux, Unreal Engine requires building from source via the Epic Games GitHub (requires linking your GitHub account to Epic).');
  }
  return lines.join('\n');
}

async function ensureProjectExists(projectPath) {
  if (!fss.existsSync(projectPath) || !projectPath.endsWith('.uproject')) {
    throw new Error(`"${projectPath}" is not a valid path to a .uproject file.`);
  }
}

function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out')); }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(-8000), stderr: stderr.slice(-4000) });
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── tool: unreal_open_editor ─────────────────────────────────────────────────
const unrealOpenEditor = {
  name: 'unreal_open_editor',
  declaration: {
    name: 'unreal_open_editor',
    description: 'Launch the full Unreal Editor GUI on a given .uproject file. Use when the person wants to actually work in the editor (build levels, place assets, blueprint logic) rather than run a headless command.',
    parameters: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Full path to the .uproject file to open.' },
      },
      required: ['project_path'],
    },
  },
  async execute({ project_path }) {
    const root = await findEngineRoot();
    if (!root) return { error: installInstructions() };
    await ensureProjectExists(project_path);
    const { editor } = exePaths(root);
    if (!fss.existsSync(editor)) return { error: `Editor binary not found at ${editor}` };
    spawn(editor, [project_path], { detached: true, stdio: 'ignore' }).unref();
    return { status: 'launched', editor, project_path };
  },
};

// ── tool: unreal_generate_projectfiles ───────────────────────────────────────
const unrealGenerateProjectFiles = {
  name: 'unreal_generate_projectfiles',
  declaration: {
    name: 'unreal_generate_projectfiles',
    description: 'Regenerate the Visual Studio solution (.sln) for a project after adding/removing C++ source files.',
    parameters: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Full path to the .uproject file.' },
      },
      required: ['project_path'],
    },
  },
  async execute({ project_path }) {
    const root = await findEngineRoot();
    if (!root) return { error: installInstructions() };
    await ensureProjectExists(project_path);
    const { genProjBat } = exePaths(root);
    const result = await runCmd(genProjBat, [project_path], BUILD_TIMEOUT);
    return result;
  },
};

// ── tool: unreal_build_project ───────────────────────────────────────────────
const unrealBuildProject = {
  name: 'unreal_build_project',
  declaration: {
    name: 'unreal_build_project',
    description: 'Compile a project\'s C++ code via UnrealBuildTool. Run this after editing C++ source before opening/packaging.',
    parameters: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Full path to the .uproject file.' },
        target:       { type: 'string', description: 'Build target name, usually "<ProjectName>Editor".' },
        configuration:{ type: 'string', description: 'Development, DebugGame, or Shipping.', enum: ['Development', 'DebugGame', 'Shipping'] },
        platform:     { type: 'string', description: 'Target platform, e.g. Win64.' },
      },
      required: ['project_path', 'target'],
    },
  },
  async execute({ project_path, target, configuration = 'Development', platform = 'Win64' }) {
    const root = await findEngineRoot();
    if (!root) return { error: installInstructions() };
    await ensureProjectExists(project_path);
    const { buildBat } = exePaths(root);
    const result = await runCmd(buildBat, [target, platform, configuration, project_path, '-waitmutex'], BUILD_TIMEOUT);
    return result;
  },
};

// ── tool: unreal_run_commandlet ──────────────────────────────────────────────
const unrealRunCommandlet = {
  name: 'unreal_run_commandlet',
  declaration: {
    name: 'unreal_run_commandlet',
    description: 'Run a headless editor commandlet against a project (e.g. ResavePackages to migrate/upgrade assets when remastering an older project, or a custom commandlet).',
    parameters: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Full path to the .uproject file.' },
        commandlet:   { type: 'string', description: 'Commandlet name, e.g. "ResavePackages".' },
        extra_args:   { type: 'array', items: { type: 'string' }, description: 'Additional CLI flags.' },
      },
      required: ['project_path', 'commandlet'],
    },
  },
  async execute({ project_path, commandlet, extra_args = [] }) {
    const root = await findEngineRoot();
    if (!root) return { error: installInstructions() };
    await ensureProjectExists(project_path);
    const { editorCmd } = exePaths(root);
    const args = [project_path, `-run=${commandlet}`, ...extra_args];
    const result = await runCmd(editorCmd, args, BUILD_TIMEOUT);
    return result;
  },
};

// ── tool: unreal_package_project ─────────────────────────────────────────────
const unrealPackageProject = {
  name: 'unreal_package_project',
  declaration: {
    name: 'unreal_package_project',
    description: 'Cook and package a project into a shippable build via RunUAT BuildCookRun. This produces the final playable executable.',
    parameters: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: 'Full path to the .uproject file.' },
        platform:     { type: 'string', description: 'Target platform, e.g. Win64.' },
        configuration:{ type: 'string', description: 'Development or Shipping.', enum: ['Development', 'Shipping'] },
        output_dir:   { type: 'string', description: 'Folder to place the packaged build in.' },
      },
      required: ['project_path', 'output_dir'],
    },
  },
  async execute({ project_path, platform = 'Win64', configuration = 'Development', output_dir }) {
    const root = await findEngineRoot();
    if (!root) return { error: installInstructions() };
    await ensureProjectExists(project_path);
    const { runUatBat } = exePaths(root);
    const args = [
      'BuildCookRun',
      `-project=${project_path}`,
      '-noP4', '-cook', '-build', '-stage', '-package', '-archive',
      `-archivedirectory=${output_dir}`,
      `-platform=${platform}`,
      `-clientconfig=${configuration}`,
    ];
    await fs.mkdir(output_dir, { recursive: true });
    const result = await runCmd(runUatBat, args, PACKAGE_TIMEOUT);
    return result;
  },
};

export const UNREAL_TOOLS = [
  unrealOpenEditor,
  unrealGenerateProjectFiles,
  unrealBuildProject,
  unrealRunCommandlet,
  unrealPackageProject,
];

