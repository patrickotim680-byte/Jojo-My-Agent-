import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';

const DIR = './skills';

// ── SkillsSystem ──────────────────────────────────────────────────────────────
// Mirrors how skills actually work for Claude: every skill's name + trigger
// description is always visible in the system prompt (cheap, always-on
// routing), but the FULL SKILL.md body is only pulled into context when a
// skill is actually relevant for the current task. The model does that by
// calling the real `read_file` tool on the skill's path — the same tool it
// already uses for everything else, no special machinery required.
//
// The previous version of this file injected every loaded skill's entire
// content into every single turn regardless of relevance. For Jojo's bundled
// skills (docx/pptx/xlsx run 300-600+ lines each) that meant ~90KB of mostly
// irrelevant instructions on every message, and it silently broke the
// project's own documented "~300 lines" budget (skills/README.md) the
// moment a real skill was dropped in. Progressive disclosure — metadata
// always on, full body on demand — is both cheaper and is the actual
// mechanism real Claude skills rely on, so that's what this implements.
//
// Two on-disk formats are supported:
//   skills/my-skill.md          — flat file (frontmatter optional)
//   skills/my-skill/SKILL.md    — skill folder (scripts/assets live
//                                  alongside; this is the format used by
//                                  every bundled skill: docx, pdf, pptx, …)

const GENERATED_SUBDIR = '_generated';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Turn a proposed skill name into a safe, filesystem-friendly slug — no path
 *  traversal, no spaces, lowercase, hyphen-separated. */
function slugify(name) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

/** Minimal frontmatter reader for SKILL.md's hand-authored, flat-scalar
 *  YAML (name/description/license/etc). Not a general YAML parser — the
 *  files this reads never use nesting, lists, or multi-line values. */
function parseFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) meta[key] = val;
  }
  return { meta, body: raw.slice(match[0].length) };
}

/** Fallback "description" for flat .md skills with no frontmatter: first
 *  non-empty line, heading markers stripped. */
function firstLine(body) {
  const line = body.split('\n').find(l => l.trim().length);
  return (line || '').replace(/^#+\s*/, '').trim();
}

export class SkillsSystem {
  constructor() {
    this.skills = new Map(); // name → { path, description, body }
  }

  async init() {
    await fs.mkdir(DIR, { recursive: true });
    await this.load();
  }

  async load() {
    this.skills.clear();
    let entries;
    try {
      entries = await fs.readdir(DIR, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === GENERATED_SUBDIR) {
        // Container for agent-synthesized skills — handled separately below,
        // never treated as a skill folder itself.
        continue;

      } else if (entry.isDirectory()) {
        // Skill folder — look for SKILL.md inside
        const skillPath = path.join(DIR, entry.name, 'SKILL.md');
        try {
          const raw = await fs.readFile(skillPath, 'utf-8');
          const { meta, body } = parseFrontmatter(raw);
          this.skills.set(entry.name, {
            path: skillPath,
            description: meta.description || firstLine(body) || '(no description)',
            body,
            synthesized: meta.synthesized === 'true',
          });
        } catch { /* no SKILL.md — skip */ }

      } else if (entry.name.endsWith('.md') && entry.name !== 'README.md') {
        // Flat .md file
        const skillPath = path.join(DIR, entry.name);
        const raw = await fs.readFile(skillPath, 'utf-8');
        const { meta, body } = parseFrontmatter(raw);
        const name = meta.name || path.basename(entry.name, '.md');
        this.skills.set(name, {
          path: skillPath,
          description: meta.description || firstLine(body) || '(no description)',
          body,
          synthesized: meta.synthesized === 'true',
        });
      }
    }

    // Capability Synthesis — agent-written skills live in skills/_generated/<name>/SKILL.md.
    // Always tagged synthesized, regardless of frontmatter, since folder location is the
    // structural source of truth.
    const generatedDir = path.join(DIR, GENERATED_SUBDIR);
    let generatedEntries;
    try {
      generatedEntries = await fs.readdir(generatedDir, { withFileTypes: true });
    } catch {
      generatedEntries = [];
    }
    for (const entry of generatedEntries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(generatedDir, entry.name, 'SKILL.md');
      try {
        const raw = await fs.readFile(skillPath, 'utf-8');
        const { meta, body } = parseFrontmatter(raw);
        this.skills.set(entry.name, {
          path: skillPath,
          description: meta.description || firstLine(body) || '(no description)',
          body,
          synthesized: true,
        });
      } catch { /* no SKILL.md — skip */ }
    }
  }

  /**
   * Capability Synthesis — write a brand-new skill the agent extracted from
   * solving a novel problem. Lands in skills/_generated/<slug>/SKILL.md,
   * tagged synthesized: true, confidence: unverified. Never overwrites a
   * hand-authored skill of the same name — only ever creates new skills or
   * revises its own previously-synthesized ones (re-synthesis is how a
   * probation skill can be tightened after a correction, same spirit as
   * apply_skill_update but self-service since nothing curated is at risk).
   * Reloads the skills map before returning so the new skill is live
   * immediately. Returns { path, slug }.
   */
  async synthesize(name, { description, body, sourceTask = '', confidence = 'unverified' } = {}) {
    const slug = slugify(name);
    if (!slug) throw new Error(`Invalid skill name: "${name}"`);
    if (!description || !description.trim()) throw new Error('description is required.');
    if (!body || !body.trim()) throw new Error('body is required.');

    const existing = this.skills.get(slug);
    if (existing && !existing.synthesized) {
      throw new Error(`"${slug}" is a hand-authored skill — synthesis cannot overwrite it. Choose a different name.`);
    }

    const dir = path.join(DIR, GENERATED_SUBDIR, slug);
    await fs.mkdir(dir, { recursive: true });
    const skillPath = path.join(dir, 'SKILL.md');

    const frontmatterLines = [
      '---',
      `name: ${slug}`,
      `description: ${description.replace(/\r?\n/g, ' ').trim()}`,
      `synthesized: true`,
      `confidence: ${confidence}`,
      `created: ${new Date().toISOString()}`,
    ];
    if (sourceTask && sourceTask.trim()) {
      frontmatterLines.push(`source_task: ${sourceTask.replace(/\r?\n/g, ' ').trim().slice(0, 200)}`);
    }
    frontmatterLines.push('---', '');

    const content = frontmatterLines.join('\n') + body.trim() + '\n';
    await fs.writeFile(skillPath, content, 'utf-8');

    await this.load(); // reload so it's live immediately

    return { path: skillPath, slug };
  }

  /**
   * Lightweight, always-on context injected into the system prompt: name +
   * trigger description + on-disk path for every loaded skill — never the
   * full body. The model loads a skill's full instructions itself, via the
   * existing read_file tool, only once it has decided that skill applies.
   *
   * @param {import('./skill_ledger.js').SkillLedger} [ledger] — when passed,
   *   each skill gets a live status badge and skills the ledger has judged
   *   'retired' (a synthesized skill with a poor track record — hand-authored
   *   skills are immune) are hidden from this listing entirely. The file
   *   itself is never deleted — see skill_ledger.js.
   */
  getContext(ledger = null) {
    if (!this.skills.size) {
      return '(no skills installed — drop a skills/<name>/SKILL.md folder in)';
    }

    const rows = [];
    for (const [name, s] of this.skills.entries()) {
      let badge = '';
      if (ledger) {
        const score = ledger.getScore(name);
        if (score.status === 'retired') continue; // hidden, not deleted
        if (score.status === 'core')       badge = ' ⭐ [core — consistently reliable]';
        else if (s.synthesized && score.status === 'probation') badge = ' 🌱 [synthesized — unverified, on probation]';
        else if (s.synthesized)            badge = ' [synthesized]';
      } else if (s.synthesized) {
        badge = ' [synthesized]';
      }
      rows.push(`### ${name}${badge}\n${s.description}\nFull instructions: ${s.path}`);
    }

    if (!rows.length) {
      return '(every skill is currently retired for poor performance — see list_skill_scores)';
    }

    return `${rows.join('\n\n')}

When a task matches one of the descriptions above, call read_file on that
skill's path BEFORE doing the work — don't guess at the workflow from the
name alone. Any scripts/templates a skill bundles live next to its SKILL.md
(e.g. skills/docx/scripts/...); use list_directory to see what's available
there.

[synthesized] skills were written by you, not a human — verify they still apply
before trusting them blindly. 🌱 = new/unproven (needs a few logged uses via
log_skill_outcome before it's trusted), ⭐ = core (proven reliable, prefer it
over a similar lower-scoring skill). A synthesized skill that keeps failing is
retired automatically and stops appearing here — hand-authored skills are never
retired. Use list_skill_scores to audit the full picture, including anything
currently hidden.`;
  }

  /** Full record ({ path, description, body }) for one loaded skill, by
   *  name — for callers that want to act on a skill directly rather than
   *  relying on the model calling read_file itself. */
  get(name) {
    return this.skills.get(name) || null;
  }

  list(ledger = null) {
    console.log(chalk.cyan('\n🎯  Loaded Skills:\n'));
    if (!this.skills.size) {
      console.log(chalk.gray('  (none — add a SKILL.md folder to ./skills/)\n'));
    } else {
      this.skills.forEach((s, name) => {
        let tag = '';
        if (ledger) {
          const score = ledger.getScore(name);
          if (score.status === 'retired') tag = chalk.red(' [retired — hidden from prompt]');
          else if (score.status === 'core') tag = chalk.yellow(' [core]');
          else if (s.synthesized && score.status === 'probation') tag = chalk.green(' [probation]');
          else if (s.synthesized) tag = chalk.gray(' [synthesized]');
        } else if (s.synthesized) {
          tag = chalk.gray(' [synthesized]');
        }
        console.log(chalk.white(`  · ${name}`) + tag + chalk.gray(`  — ${s.path}`));
      });
      console.log('');
    }
  }
}

