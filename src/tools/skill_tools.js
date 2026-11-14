// ── Skill Ledger Tools ────────────────────────────────────────────────────────
// Turns Skills from static files into a self-improving loop:
//
//   log_skill_outcome        — record whether a skill's instructions worked
//   review_skill_performance — analyze the log, propose a SKILL.md revision (never writes to disk)
//   list_skill_proposals     — see what's pending approval
//   apply_skill_update       — write an approved proposal to disk (archives the old version first)
//
// HARD RULE (also stated in agent.js IDENTITY): apply_skill_update must only
// be called after the human has explicitly approved the changelog shown to
// them in chat. review_skill_performance never modifies files by itself —
// it only ever returns a proposal for a human to look at.
//
// Capability Synthesis & Natural Selection — a separate, ungated mechanism:
//
//   synthesize_skill  — write a brand-new SKILL.md under skills/_generated/ from a
//                        problem just solved. No approval gate needed: it can only
//                        create new skills or rewrite the agent's own prior synthesized
//                        ones, and refuses outright to touch a hand-authored skill name.
//   list_skill_scores — audit the live scoreboard (score/status) for every skill.
//
// Scoring/retirement itself has no dedicated tool — it's computed live by
// SkillLedger.getScore() off the same log_skill_outcome entries every time
// skills.getContext() builds the system prompt. See skill_ledger.js.

import fs from 'fs/promises';
import path from 'path';
import { DEFAULT_MODEL } from '../core/puter_client.js';

async function generateProposal(genAI, { skillName, currentBody, ledgerSummary }) {
  const model = genAI.getGenerativeModel({
    model: process.env.PUTER_MODEL || DEFAULT_MODEL,
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  });

  const prompt = `You are revising an AI agent's skill file based on real usage history.

Skill name: ${skillName}

Usage history since last revision:
- Total logged uses: ${ledgerSummary.total}
- Successes: ${ledgerSummary.success}
- Failures: ${ledgerSummary.failure}
- Corrections needed: ${ledgerSummary.correction}

Recent failure/correction notes (what went wrong in practice):
${ledgerSummary.recentIssues.length ? ledgerSummary.recentIssues.map(s => `- ${s}`).join('\n') : '(none logged — if there are no failures, propose only minor clarity tightening, or say no change is needed)'}

Current full SKILL.md content (including any frontmatter):
---
${currentBody.slice(0, 12000)}
---

Propose a revision that fixes the specific failure patterns above without bloating the file
or removing content unrelated to the issues found. If the history shows no real problems,
it is fine to propose no changes.

Respond ONLY with valid JSON, no markdown fences, no extra prose:
{
  "needs_change": <true or false>,
  "changelog": ["short bullet describing change 1", "change 2", "..."],
  "confidence": "LOW or MEDIUM or HIGH",
  "new_body": "the FULL revised file content, ready to write as-is to SKILL.md (only meaningful if needs_change is true; otherwise repeat the current content unchanged)"
}`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().replace(/```json\n?|```/g, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Non-JSON response while proposing skill revision: ${raw.slice(0, 200)}`);
  }
}

export const SKILL_TOOLS = [

  // ── log_skill_outcome ────────────────────────────────────────────────────────
  {
    name: 'log_skill_outcome',
    declaration: {
      name: 'log_skill_outcome',
      description:
        'Record whether a loaded skill\'s instructions worked for the task just completed. ' +
        'Call this once after finishing (or failing) any task where you read and followed a ' +
        'skill\'s SKILL.md — this is what lets the skill improve itself over time. ' +
        'Use outcome="success" if the instructions worked as written, "failure" if they led you ' +
        'astray or produced a bad result, "correction" if they mostly worked but you had to deviate ' +
        'or fix something the instructions got wrong.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Name of the skill folder, e.g. "docx", "pptx", "xlsx".' },
          outcome:    { type: 'string', enum: ['success', 'failure', 'correction'] },
          task:       { type: 'string', description: 'One-line description of what you were trying to do.' },
          note:       { type: 'string', description: 'What worked, what didn\'t, or what you had to change. Be specific — this is what a future revision will be based on.' },
        },
        required: ['skill_name', 'outcome'],
      },
    },

    async execute({ skill_name, outcome, task = '', note = '' }, { skillLedger }) {
      if (!skillLedger) return 'Skill ledger unavailable.';
      const entry = await skillLedger.logOutcome(skill_name, { outcome, task, note });
      return `Logged: ${skill_name} → ${outcome} (${entry.timestamp}).`;
    },
  },

  // ── review_skill_performance ─────────────────────────────────────────────────
  {
    name: 'review_skill_performance',
    declaration: {
      name: 'review_skill_performance',
      description:
        'Analyze a skill\'s logged usage history and propose a revision to its SKILL.md. ' +
        'This NEVER writes to disk — it only returns a proposed changelog + full new file content ' +
        'for you to summarize and show the human. You must get explicit human approval before ' +
        'calling apply_skill_update with the returned proposal_id.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Name of the skill to review, e.g. "docx".' },
        },
        required: ['skill_name'],
      },
    },

    async execute({ skill_name }, { skillLedger, skills, genAI }) {
      if (!skillLedger || !skills) return 'Skill ledger or skills system unavailable.';

      const skill = skills.get(skill_name);
      if (!skill) return `No loaded skill named "${skill_name}". Loaded skills: ${[...skills.skills.keys()].join(', ') || '(none)'}`;

      const summary = skillLedger.summarize(skill_name);
      if (!summary.total) {
        return `No usage has been logged for "${skill_name}" yet — nothing to base a revision on. Use log_skill_outcome after using it a few times first.`;
      }

      let currentBody;
      try {
        currentBody = await fs.readFile(skill.path, 'utf-8');
      } catch (err) {
        return `Could not read ${skill.path}: ${err.message}`;
      }

      let proposal;
      try {
        proposal = await generateProposal(genAI, { skillName: skill_name, currentBody, ledgerSummary: summary });
      } catch (err) {
        return `Failed to generate proposal: ${err.message}`;
      }

      if (!proposal.needs_change) {
        return `Reviewed "${skill_name}" (${summary.total} logged uses, ${summary.failure} failures, ${summary.correction} corrections). No revision needed — the model found no clear pattern of failure to fix.`;
      }

      const saved = await skillLedger.addProposal(skill_name, {
        changelog: proposal.changelog || [],
        new_body: proposal.new_body,
        confidence: proposal.confidence || 'LOW',
        based_on_entries: summary.total,
      });

      const changelogText = (proposal.changelog || []).map(c => `  - ${c}`).join('\n') || '  (no changelog given)';

      return (
        `Proposal ${saved.id} for "${skill_name}" (confidence: ${saved.confidence}, based on ${summary.total} logged uses, ` +
        `${summary.failure} failures / ${summary.correction} corrections):\n${changelogText}\n\n` +
        `Show this changelog to the user and ask if they approve. Only call apply_skill_update with ` +
        `proposal_id="${saved.id}" if they explicitly say yes.`
      );
    },
  },

  // ── list_skill_proposals ─────────────────────────────────────────────────────
  {
    name: 'list_skill_proposals',
    declaration: {
      name: 'list_skill_proposals',
      description: 'List pending (not yet approved/applied) revision proposals for a skill, or all skills if skill_name is omitted.',
      parameters: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Optional. Name of one skill to check. Omit to list pending proposals across all skills.' },
        },
      },
    },

    async execute({ skill_name }, { skillLedger }) {
      if (!skillLedger) return 'Skill ledger unavailable.';

      const names = skill_name ? [skill_name] : Object.keys(skillLedger.data.skills);
      const lines = [];
      for (const name of names) {
        const pending = skillLedger.pendingProposals(name);
        for (const p of pending) {
          lines.push(`- ${p.id} [${name}] (${p.confidence}, ${p.timestamp}): ${(p.changelog || []).join('; ') || '(no changelog)'}`);
        }
      }
      return lines.length ? lines.join('\n') : 'No pending proposals.';
    },
  },

  // ── apply_skill_update ───────────────────────────────────────────────────────
  {
    name: 'apply_skill_update',
    declaration: {
      name: 'apply_skill_update',
      description:
        'Write an already-approved skill revision to disk, archiving the previous SKILL.md first. ' +
        'ONLY call this after the human has explicitly approved the changelog that review_skill_performance ' +
        'returned for this exact proposal_id — never call this speculatively or without a clear human "yes".',
      parameters: {
        type: 'object',
        properties: {
          skill_name:   { type: 'string', description: 'Name of the skill, matching what review_skill_performance used.' },
          proposal_id:  { type: 'string', description: 'The proposal id returned by review_skill_performance.' },
          human_approved: { type: 'boolean', description: 'Must be true — confirms the human explicitly approved this in chat.' },
        },
        required: ['skill_name', 'proposal_id', 'human_approved'],
      },
    },

    async execute({ skill_name, proposal_id, human_approved }, { skillLedger, skills }) {
      if (!skillLedger || !skills) return 'Skill ledger or skills system unavailable.';
      if (!human_approved) return 'Refused: human_approved must be true. Do not call this tool without explicit human approval shown in the conversation.';

      const proposal = skillLedger.getProposal(skill_name, proposal_id);
      if (!proposal) return `No proposal "${proposal_id}" found for skill "${skill_name}".`;
      if (proposal.status !== 'pending') return `Proposal ${proposal_id} is already "${proposal.status}" — nothing to do.`;

      const skill = skills.get(skill_name);
      if (!skill) return `No loaded skill named "${skill_name}".`;

      // Archive current version before overwriting.
      const skillDir = path.dirname(skill.path);
      const historyDir = path.join(skillDir, '.history');
      await fs.mkdir(historyDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(historyDir, `${stamp}-SKILL.md`);

      try {
        const current = await fs.readFile(skill.path, 'utf-8');
        await fs.writeFile(archivePath, current, 'utf-8');
        await fs.writeFile(skill.path, proposal.new_body, 'utf-8');
      } catch (err) {
        return `Failed to apply update: ${err.message}`;
      }

      await skillLedger.setProposalStatus(skill_name, proposal_id, 'applied');
      await skillLedger.logOutcome(skill_name, {
        outcome: 'success',
        task: 'skill self-revision',
        note: `Applied proposal ${proposal_id}. Previous version archived at ${archivePath}.`,
      });

      await skills.load(); // reload so the new body is live immediately

      return `Applied proposal ${proposal_id} to ${skill.path}. Previous version archived at ${archivePath}. Skill reloaded.`;
    },
  },

  // ── synthesize_skill (Capability Synthesis) ──────────────────────────────────
  // Unlike apply_skill_update above, this needs NO human approval gate — it can
  // only ever create a brand-new skill or re-write one of the agent's own prior
  // synthesized skills. It refuses outright to touch a hand-authored skill name.
  {
    name: 'synthesize_skill',
    declaration: {
      name: 'synthesize_skill',
      description:
        'Write a brand-new SKILL.md from a problem you just solved that had no existing matching ' +
        'skill. Call this AFTER successfully completing a genuinely novel, reusable task — not for ' +
        'one-off trivia. Saved under skills/_generated/, tagged synthesized + confidence:"unverified", ' +
        'and goes live immediately, but starts on probation: it needs a few real logged uses ' +
        '(via log_skill_outcome) before it is trusted, and is auto-retired (hidden, never deleted) if ' +
        'it keeps failing. This can never overwrite a hand-authored skill — pick a different name if one ' +
        'already exists with that slug.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Short slug for the new skill, e.g. "retry-flaky-api-calls". Lowercase, hyphenated.',
          },
          description: {
            type: 'string',
            description:
              'One or two sentences describing WHEN this skill applies — this is the always-on trigger ' +
              'text shown in every system prompt, so make it specific rather than generic.',
          },
          body: {
            type: 'string',
            description:
              'Full SKILL.md instructions body (markdown) — the actual reusable steps/strategy that ' +
              'worked, written so a future you (with no memory of this conversation) could follow it cold.',
          },
          source_task: {
            type: 'string',
            description: 'One-line description of the task this was extracted from, for audit purposes.',
          },
        },
        required: ['name', 'description', 'body'],
      },
    },

    async execute({ name, description, body, source_task = '' }, { skills, skillLedger }) {
      if (!skills) return 'Skills system unavailable.';

      let path_, slug;
      try {
        ({ path: path_, slug } = await skills.synthesize(name, { description, body, sourceTask: source_task }));
      } catch (err) {
        return `Could not synthesize skill: ${err.message}`;
      }

      if (skillLedger) {
        await skillLedger.registerSkill(slug, { synthesized: true, isProtected: false });
      }

      return (
        `New skill "${slug}" written to ${path_} and loaded — status: probation (unverified). ` +
        `Use log_skill_outcome after you actually use it again to build up its track record; ` +
        `it will be promoted to active/core on a good record or auto-retired on a poor one.`
      );
    },
  },

  // ── list_skill_scores (Natural Selection audit) ──────────────────────────────
  {
    name: 'list_skill_scores',
    declaration: {
      name: 'list_skill_scores',
      description:
        'Show the full scoreboard for every skill, hand-authored and synthesized: use counts, ' +
        'weighted score, and live status (core / active / probation / retired). Use this to audit ' +
        'the natural-selection system, including any skills currently hidden from the prompt for ' +
        'poor performance — nothing is ever deleted, only hidden.',
      parameters: { type: 'object', properties: {} },
    },

    async execute(_args, { skillLedger }) {
      if (!skillLedger) return 'Skill ledger unavailable.';
      const board = skillLedger.scoreboard();
      if (!board.length) return 'No skills registered yet.';

      return board.map(s => {
        const kind = s.protected ? 'hand-authored, immune to retirement' : 'synthesized';
        const pct  = s.score === null ? 'n/a' : `${Math.round(s.score * 100)}%`;
        return `- ${s.name} [${s.status}] (${kind}): ${s.total} logged use(s), ${pct} weighted score`;
      }).join('\n');
    },
  },

];

