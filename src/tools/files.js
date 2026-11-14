import fs from 'fs/promises';
import path from 'path';

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (bytes < 1024)       return `${bytes}B`;
  if (bytes < 1024 ** 2)  return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}

async function walkDir(dir, prefix, depth, maxDepth) {
  if (depth > maxDepth) return `${prefix}… (max depth)`;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { return `${prefix}[${e.message}]`; }

  const lines = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const last  = i === entries.length - 1;
    const conn  = last ? '└── ' : '├── ';
    const child = prefix + (last ? '    ' : '│   ');
    if (entry.isDirectory()) {
      lines.push(`${prefix}${conn}${entry.name}/`);
      const sub = await walkDir(path.join(dir, entry.name), child, depth + 1, maxDepth);
      if (sub) lines.push(sub);
    } else {
      lines.push(`${prefix}${conn}${entry.name}`);
    }
  }
  return lines.join('\n');
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const FILE_TOOLS = [

  // ── read_file ────────────────────────────────────────────────────────────────
  {
    name: 'read_file',
    declaration: {
      name: 'read_file',
      description:
        'Read a file and return its content with line numbers. ' +
        'Optionally provide start_line / end_line to read a slice.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'File path' },
          start_line: { type: 'number', description: 'First line to return (1-indexed, optional)' },
          end_line:   { type: 'number', description: 'Last line to return (inclusive, optional)' },
        },
        required: ['path'],
      },
    },
    async execute({ path: fp, start_line, end_line }) {
      try {
        const raw   = await fs.readFile(fp, 'utf-8');
        const lines = raw.split('\n');
        const s     = start_line ? start_line - 1 : 0;
        const e     = end_line   ? end_line       : lines.length;
        return lines.slice(s, e).map((l, i) => `${s + i + 1}\t${l}`).join('\n');
      } catch (err) { return `Error: ${err.message}`; }
    },
  },

  // ── write_file ───────────────────────────────────────────────────────────────
  {
    name: 'write_file',
    declaration: {
      name: 'write_file',
      description: 'Write (or overwrite) a file. Creates parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Destination path' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    async execute({ path: fp, content }) {
      try {
        await fs.mkdir(path.dirname(fp), { recursive: true });
        await fs.writeFile(fp, content, 'utf-8');
        return `Written ${fmtSize(Buffer.byteLength(content))} to ${fp}`;
      } catch (err) { return `Error: ${err.message}`; }
    },
  },

  // ── edit_file ────────────────────────────────────────────────────────────────
  {
    name: 'edit_file',
    declaration: {
      name: 'edit_file',
      description:
        'Replace an exact unique string in a file with a new string. ' +
        'old_string must appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path:       { type: 'string', description: 'File to edit' },
          old_string: { type: 'string', description: 'Exact text to replace' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async execute({ path: fp, old_string, new_string }) {
      try {
        const content = await fs.readFile(fp, 'utf-8');
        const escaped = old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const count   = (content.match(new RegExp(escaped, 'g')) || []).length;
        if (count === 0) return `Error: string not found in ${fp}`;
        if (count > 1)   return `Error: string appears ${count}× — be more specific`;
        await fs.writeFile(fp, content.replace(old_string, new_string), 'utf-8');
        return `Edited ${fp}`;
      } catch (err) { return `Error: ${err.message}`; }
    },
  },

  // ── list_directory ───────────────────────────────────────────────────────────
  {
    name: 'list_directory',
    declaration: {
      name: 'list_directory',
      description: 'List files and subdirectories. Set recursive=true for a tree view.',
      parameters: {
        type: 'object',
        properties: {
          path:      { type: 'string',  description: 'Directory to list (default: ".")' },
          recursive: { type: 'boolean', description: 'Tree view (default false)' },
        },
      },
    },
    async execute({ path: dp = '.', recursive = false }) {
      try {
        if (recursive) {
          const tree = await walkDir(dp, '', 0, 4);
          return `${dp}/\n${tree}`;
        }
        const entries = await fs.readdir(dp, { withFileTypes: true });
        const lines = await Promise.all(entries.map(async e => {
          const icon = e.isDirectory() ? '📁' : '📄';
          try {
            const st   = await fs.stat(path.join(dp, e.name));
            const size = e.isFile() ? ` (${fmtSize(st.size)})` : '';
            return `${icon} ${e.name}${size}`;
          } catch { return `${icon} ${e.name}`; }
        }));
        return `${dp}/\n${lines.join('\n')}`;
      } catch (err) { return `Error: ${err.message}`; }
    },
  },
];

