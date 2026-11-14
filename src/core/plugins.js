// ── Plugin Manager ───────────────────────────────────────────────────────────
//
// Loads local plugins from ./plugins — the same idea as Claude Code plugins:
// a self-contained folder (or single file) that can add new tools, new REPL
// slash commands, and/or bundle its own MCP server(s), without touching core
// source. See plugins/README.md for the author-facing docs and
// plugins/example-plugin/ for a real, working reference.
//
// Two on-disk formats (mirrors skills.js's flat-file / folder duality):
//   plugins/my-plugin.js            — flat file, `export default { ... }`
//   plugins/my-plugin/plugin.json   — folder: static metadata (+ optional
//     plugins/my-plugin/index.js      index.js for tools/commands; a plugin
//                                      can be manifest-only if it just bundles
//                                      an MCP server, with no custom code)
//
// Plugin shape (whatever plugin.json and/or the JS module's default export
// provide, merged — the JS module's fields win on key collision):
//   {
//     name, version, description,
//     tools:      [ { name, declaration, execute } ],   // exact src/tools/*.js shape
//     commands:   [ { name, description, prompt } ],    // REPL slash commands
//     mcpServers: { "server-name": { command/args/env | type/url/headers } },
//   }
//
// Enable/disable state lives in plugins.json at the project root (gitignored,
// auto-created on first plugin_disable/enable — absence just means
// "everything enabled", so a fresh install needs no setup).

import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execAsync = promisify(exec);

const DIR           = './plugins';
const MANIFEST_FILE = './plugins.json';

export class PluginManager {
  constructor() {
    this.plugins  = new Map(); // name → { path, version, description, tools, commands, mcpServers, enabled, error }
    this._disabled = new Set();
  }

  async init() {
    await fs.mkdir(DIR, { recursive: true });
    this._disabled = await this._loadDisabledSet();
    await this.load();
  }

  async reload() {
    this._disabled = await this._loadDisabledSet();
    await this.load();
  }

  async _loadDisabledSet() {
    try {
      const raw = await fs.readFile(MANIFEST_FILE, 'utf-8');
      const json = JSON.parse(raw);
      return new Set(Array.isArray(json.disabled) ? json.disabled : []);
    } catch {
      return new Set();
    }
  }

  async _saveDisabledSet() {
    await fs.writeFile(MANIFEST_FILE, JSON.stringify({ disabled: [...this._disabled] }, null, 2) + '\n', 'utf-8');
  }

  async load() {
    this.plugins.clear();
    let entries;
    try {
      entries = await fs.readdir(DIR, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'README.md') continue;
      try {
        if (entry.isDirectory()) {
          await this._loadFolderPlugin(entry.name);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
          await this._loadFilePlugin(entry.name);
        }
      } catch (err) {
        const fallbackName = entry.name.replace(/\.js$/, '');
        this.plugins.set(fallbackName, {
          path: path.join(DIR, entry.name), version: '0.0.0', description: '',
          tools: [], commands: [], mcpServers: {}, enabled: false, error: err.message,
        });
      }
    }
  }

  async _loadFilePlugin(fileName) {
    const name = fileName.replace(/\.js$/, '');
    const fullPath = path.resolve(DIR, fileName);
    const mod = await import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`); // cache-bust so reload picks up edits
    const manifest = mod.default || mod;
    this._register(manifest.name || name, fullPath, manifest);
  }

  async _loadFolderPlugin(dirName) {
    const dirPath = path.join(DIR, dirName);
    let manifestMeta = {};
    try {
      const raw = await fs.readFile(path.join(dirPath, 'plugin.json'), 'utf-8');
      manifestMeta = JSON.parse(raw);
    } catch { /* plugin.json is optional if index.js exports everything itself */ }

    const entryFile = manifestMeta.main || 'index.js';
    const fullPath = path.resolve(dirPath, entryFile);

    let modExports = {};
    try {
      await fs.access(fullPath);
      const mod = await import(`${pathToFileURL(fullPath).href}?t=${Date.now()}`);
      modExports = mod.default || mod;
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`failed to load ${entryFile}: ${err.message}`);
      // no entry file — fine for a manifest-only plugin (e.g. one that only bundles an MCP server)
    }

    const manifest = { ...manifestMeta, ...modExports };
    const hasContent = manifest.tools?.length || manifest.commands?.length ||
      (manifest.mcpServers && Object.keys(manifest.mcpServers).length) || manifestMeta.name;
    if (!hasContent) throw new Error('empty plugin — no plugin.json metadata and no index.js exports found');

    this._register(manifest.name || dirName, fullPath, manifest);
  }

  _register(name, fullPath, manifest) {
    const enabled = !this._disabled.has(name);
    this.plugins.set(name, {
      path: fullPath,
      version: manifest.version || '0.0.0',
      description: manifest.description || '(no description)',
      tools: Array.isArray(manifest.tools) ? manifest.tools : [],
      commands: Array.isArray(manifest.commands) ? manifest.commands : [],
      mcpServers: (manifest.mcpServers && typeof manifest.mcpServers === 'object') ? manifest.mcpServers : {},
      enabled,
      error: null,
    });
  }

  // ── State changes ─────────────────────────────────────────────────────────

  async enable(name) {
    this._disabled.delete(name);
    await this._saveDisabledSet();
    await this.load();
    return this.plugins.get(name) || null;
  }

  async disable(name) {
    this._disabled.add(name);
    await this._saveDisabledSet();
    await this.load();
    return this.plugins.get(name) || null;
  }

  /** Install a plugin from a git URL (cloned) or a local directory (copied)
   *  into ./plugins/<name>. Caller (plugin_tools.js) gates this behind
   *  explicit human approval — it runs whatever code the plugin contains. */
  async install({ source, name }) {
    if (!source || !source.trim()) throw new Error('source is required (git URL or local directory path).');
    const isGit = /^(https?:\/\/|git@)/.test(source) || source.trim().endsWith('.git');
    const targetName = (name || path.basename(source.replace(/\.git$/, '')))
      .trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!targetName) throw new Error('Could not derive a plugin folder name — pass one explicitly.');

    const dest = path.join(DIR, targetName);
    try {
      await fs.access(dest);
      throw new Error(`plugins/${targetName} already exists — pick a different name or remove it first.`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // ENOENT is the expected/good case here
    }

    if (isGit) {
      await execAsync(`git clone --depth 1 "${source}" "${dest}"`, { timeout: 60_000 });
    } else {
      await fs.mkdir(dest, { recursive: true });
      await fs.cp(source, dest, { recursive: true });
    }

    await this.load();
    const loaded = this.plugins.get(targetName);
    if (!loaded || loaded.error) {
      return { name: targetName, ok: false, error: loaded?.error || 'installed, but not recognized as a valid plugin (needs plugin.json and/or index.js).' };
    }
    return { name: targetName, ok: true, tools: loaded.tools.map(t => t.name), commands: loaded.commands.map(c => c.name) };
  }

  // ── Aggregation for agent.js / ToolRegistry ───────────────────────────────

  getTools() {
    const out = [];
    for (const p of this.plugins.values()) {
      if (!p.enabled || p.error) continue;
      out.push(...p.tools);
    }
    return out;
  }

  /** Merged MCP server configs bundled by every *enabled* plugin, namespaced
   *  as "<plugin>:<server>" so two plugins can't silently collide, and so a
   *  plugin can never overwrite a server the human configured by hand in
   *  mcp_servers.json (McpManager.init merges user config first). */
  getMcpServers() {
    const merged = {};
    for (const [pluginName, p] of this.plugins.entries()) {
      if (!p.enabled || p.error) continue;
      for (const [srvName, srvCfg] of Object.entries(p.mcpServers)) {
        merged[`${pluginName}:${srvName}`] = srvCfg;
      }
    }
    return merged;
  }

  getCommand(cmdName) {
    for (const p of this.plugins.values()) {
      if (!p.enabled) continue;
      const found = p.commands.find(c => c.name === cmdName);
      if (found) return found;
    }
    return null;
  }

  listCommands() {
    const out = [];
    for (const [pname, p] of this.plugins.entries()) {
      if (!p.enabled) continue;
      for (const c of p.commands) out.push({ ...c, plugin: pname });
    }
    return out;
  }

  // ── Context for the system prompt (mirrors SkillsSystem.getContext()) ────

  getContext() {
    if (!this.plugins.size) return '(no plugins installed — drop a file or folder into ./plugins/, or use plugin_install)';
    const rows = [];
    for (const [name, p] of this.plugins.entries()) {
      if (p.error) { rows.push(`- ${name}: FAILED to load — ${p.error}`); continue; }
      if (!p.enabled) { rows.push(`- ${name} v${p.version} [disabled]`); continue; }
      const toolNames = p.tools.map(t => t.name).join(', ') || '(no tools)';
      const cmdNames  = p.commands.map(c => `/${c.name}`).join(', ');
      rows.push(`- ${name} v${p.version} — ${p.description}\n  Tools: ${toolNames}${cmdNames ? `\n  Commands: ${cmdNames}` : ''}`);
    }
    return rows.join('\n');
  }

  list() {
    console.log(chalk.cyan('\n🧩  Plugins:\n'));
    if (!this.plugins.size) {
      console.log(chalk.gray('  (none — drop a file/folder into ./plugins/, or ask Jojo to plugin_install one)\n'));
      return;
    }
    for (const [name, p] of this.plugins.entries()) {
      if (p.error) {
        console.log(chalk.white(`  · ${name}`) + chalk.red('  [failed]') + chalk.gray(`  ${p.error}`));
        continue;
      }
      const status = p.enabled ? chalk.green('  [enabled]') : chalk.gray('  [disabled]');
      console.log(chalk.white(`  · ${name} v${p.version}`) + status + chalk.gray(`  — ${p.description}`));
      p.tools.forEach(t => console.log(chalk.gray(`      tool:    ${t.name}`)));
      p.commands.forEach(c => console.log(chalk.gray(`      command: /${c.name}`)));
      if (Object.keys(p.mcpServers).length) console.log(chalk.gray(`      mcp:     ${Object.keys(p.mcpServers).join(', ')}`));
    }
    console.log('');
  }
}

