// ── Distillation ─────────────────────────────────────────────────────────────
// Feature: turns trajectory_logger.js's captured examples into a LoRA
// fine-tune of a small local open-weights model, served locally via Ollama —
// see local_router.js for the other half (the confidence gate that decides
// whether a given turn actually USES it).
//
// ── PIPELINE ──────────────────────────────────────────────────────────────────
//   1. buildDataset(runId) — read trajectory_logger's shards for every skill
//      that QUALIFIES (see below), turn each captured trajectory into ONE
//      (context → final answer) training pair, write JSONL to
//      memory/distillation/runs/<runId>/dataset.jsonl.
//   2. train(runId)        — shell out to scripts/train_lora.py (Python:
//      transformers + peft). Trains an adapter, merges it into the base
//      model, saves a plain HF model directory. Long-running (minutes to
//      hours depending on hardware) — this file streams its log to disk and
//      returns once the subprocess exits, it doesn't block the caller's own
//      timeout expectations for a normal tool call for free.
//   3. exportToOllama(runId) — shell out to scripts/export_ollama_model.py
//      (merge check, GGUF convert, optional quantize, `ollama create`). The
//      resulting Ollama model is STAGED — nothing routes to it yet.
//   4. promote(runId)      — human-gated (see PROMOTION below). Only after
//      this does local_router.js treat the model as eligible for real
//      routing.
//
// ── WHY TEXT-ONLY, NOT TOOL-CALLING (deliberate scope limit) ─────────────────
// buildDataset() collapses each captured trajectory down to a single
// (context → FINAL text answer) pair. The tool calls inside a trajectory are
// rendered into the training PROMPT as read-only context ("here's what was
// tried and what happened"), never asked of the model as something to
// reproduce. Two independent reasons, not one:
//   - local_router.js never gives the local model a tool registry at serving
//     time. Training it to emit function-call syntax it can then never
//     actually invoke would just be teaching it to hallucinate tool use.
//   - Even setting that aside, a small fine-tuned adapter calling bash /
//     deploy / browser tools with none of the cloud model's judgement behind
//     it is a materially different risk profile than Claude doing the same
//     — out of scope for this feature, not an oversight. If a future version
//     wants tool-calling local inference, that's a new design conversation
//     (a real sandboxed tool surface for the local model, its own review),
//     not a natural extension of this file.
//
// ── WHAT QUALIFIES FOR A TRAINING RUN ─────────────────────────────────────────
// A skill's captured examples go into the next run's dataset once:
//   - skillLedger.getScore(name).status is 'active' or 'core' RIGHT NOW — the
//     same live bar trajectory_logger.js gated capture on, re-checked here
//     because a skill can regress between capture time and distill time.
//   - trajectoryLogger has at least MIN_EXAMPLES_TO_DISTILL captured examples
//     for it. An adapter trained on a handful of examples doesn't generalize
//     a pattern, it memorizes noise.
//   - the skill is not in skillExclude (defense in depth — it shouldn't have
//     been captured in the first place, but this file re-checks rather than
//     trusting that invariant blindly across a version gap).
// Every qualifying skill's examples are combined into ONE adapter per run,
// not one adapter per skill — Ollama serves one model at a time per name, and
// personal task volume tends to cluster into a handful of skills anyway.
//
// ── PROMOTION (human-gated — same pattern as apply_rollout / apply_skill_update
//    / apply_deployment elsewhere in this codebase; see distillation_tools.js) ──
// train() and exportToOllama() only ever produce a STAGED candidate — a named
// Ollama model sitting on disk that nothing routes to yet. promote() is the
// one call that flips a candidate to 'promoted', and — like apply_rollout —
// it refuses to do anything unless human_approved is explicitly true. The
// reasoning is the same reasoning that already governs every other
// consequential action here: whatever produced the adapter (this file, a
// training script, a merge/quantize step) has had zero human review of its
// actual behavior until this point. Approving a code diff or a deploy plan
// gets a human gate; trusting a self-trained model's own words on real future
// tasks deserves at least the same.

import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

export const DISTILL_DIR   = './memory/distillation';
export const RUNS_DIR       = path.join(DISTILL_DIR, 'runs');
export const MANIFEST_FILE  = path.join(DISTILL_DIR, 'manifest.json');

const MIN_EXAMPLES_TO_DISTILL = parseInt(process.env.DISTILL_MIN_EXAMPLES || '25');
// Surfaced via getContext() as a nudge; never triggers training on its own —
// see the "periodic" note in dueForRetrain() below.
const RETRAIN_EVERY_N_NEW     = parseInt(process.env.DISTILL_RETRAIN_EVERY_N_NEW || '50');

const DEFAULT_BASE_MODEL = process.env.DISTILL_BASE_MODEL || 'Qwen/Qwen2.5-1.5B-Instruct';
const PYTHON_BIN         = process.env.DISTILL_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function newRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `run-${ts}`;
}

/** Render one captured trajectory record (see trajectory_logger.js's
 *  sanitizeTurns shape) into a single training pair. Tool calls/results
 *  become read-only context text; only the LAST model text turn becomes the
 *  target the adapter is trained to produce. Returns null if the record has
 *  no final text turn to learn from (shouldn't normally happen, but a
 *  malformed/older shard entry should never crash a whole build). */
function recordToTrainingPair(record) {
  const turns = record.turns || [];
  let finalText = null;
  const contextLines = [];

  for (const turn of turns) {
    for (const part of turn.parts || []) {
      if (part.functionCall) {
        const argsPreview = JSON.stringify(part.functionCall.args || {}).slice(0, 300);
        contextLines.push(`[used tool ${part.functionCall.name} with args ${argsPreview}]`);
      } else if (part.functionResponse) {
        const res = String(part.functionResponse.response?.result ?? '').slice(0, 300);
        contextLines.push(`[tool result: ${res}]`);
      } else if (part.text != null && turn.role === 'model') {
        finalText = part.text; // last model text turn wins
      }
    }
  }
  if (!finalText) return null;

  const system =
    `You are a fast local assistant for the "${record.skill}" task. ` +
    `Answer directly and concisely, the way this task has been handled successfully before.`;

  const userContent = contextLines.length
    ? `${record.user_message}\n\n[prior steps taken for this kind of task, for context only]\n${contextLines.join('\n')}`
    : record.user_message;

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent },
      { role: 'assistant', content: finalText },
    ],
  };
}

export class Distillation {
  constructor({ trajectoryLogger, skillLedger, skillExclude } = {}) {
    this.trajectoryLogger = trajectoryLogger;
    this.skillLedger      = skillLedger;
    // Default to the same exclusion set trajectory_logger.js uses, unless the
    // caller (agent.js) passes its actual live instance's set explicitly.
    this.skillExclude = skillExclude
      || trajectoryLogger?.skillExclude
      || new Set();
    this._manifest = null;
  }

  async init() {
    await fs.mkdir(RUNS_DIR, { recursive: true });
    await this._loadManifest();
  }

  async _loadManifest() {
    try {
      const raw = await fs.readFile(MANIFEST_FILE, 'utf-8');
      this._manifest = JSON.parse(raw);
    } catch {
      this._manifest = { runs: [], promotedModel: null, meta: { version: '1.0.0' } };
    }
    return this._manifest;
  }

  async _saveManifest() {
    await fs.writeFile(MANIFEST_FILE, JSON.stringify(this._manifest, null, 2), 'utf-8');
  }

  _run(runId) {
    return this._manifest.runs.find(r => r.id === runId) || null;
  }

  // ── Candidate skills ─────────────────────────────────────────────────────

  /** Every skill trajectory_logger has captured examples for, annotated with
   *  whether it currently qualifies for the next training run. Read-only —
   *  safe to call as often as you like (e.g. for a status tool). */
  async candidateSkills() {
    if (!this.trajectoryLogger || !this.skillLedger) return [];
    const summary = await this.trajectoryLogger.summary(); // { skill: { count, ... } }
    const out = [];
    for (const [name, info] of Object.entries(summary)) {
      if (this.skillExclude.has(name)) continue;
      const scoreInfo = this.skillLedger.getScore(name);
      const scoreOk = scoreInfo.status === 'active' || scoreInfo.status === 'core';
      out.push({
        name,
        capturedCount: info.count,
        score: scoreInfo.score,
        status: scoreInfo.status,
        qualifies: scoreOk && info.count >= MIN_EXAMPLES_TO_DISTILL,
      });
    }
    return out.sort((a, b) => b.capturedCount - a.capturedCount);
  }

  /** Whether enough NEW examples have piled up since the last run to make
   *  another one worthwhile. This is a nudge for the system prompt / a
   *  status tool, not a scheduler — nothing in this file ever calls train()
   *  on its own. Kicking off a real training subprocess (CPU/GPU time,
   *  minutes to hours) is always an explicit tool call. */
  async dueForRetrain() {
    if (!this._manifest) await this._loadManifest();
    const candidates = await this.candidateSkills();
    const totalCaptured = candidates.reduce((s, c) => s + (c.qualifies ? c.capturedCount : 0), 0);
    const lastRun = this._manifest.runs[this._manifest.runs.length - 1];
    const sinceLast = lastRun ? totalCaptured - (lastRun.totalExamples || 0) : totalCaptured;
    return { due: sinceLast >= RETRAIN_EVERY_N_NEW, newSinceLastRun: sinceLast, totalCaptured };
  }

  // ── 1. Dataset ───────────────────────────────────────────────────────────

  async buildDataset(runId = newRunId()) {
    const candidates = (await this.candidateSkills()).filter(c => c.qualifies);
    if (!candidates.length) {
      return { ok: false, error: `No skill has ${MIN_EXAMPLES_TO_DISTILL}+ qualifying captured examples yet.` };
    }

    const pairs = [];
    for (const c of candidates) {
      const records = await this.trajectoryLogger.readShard(c.name);
      for (const record of records) {
        const pair = recordToTrainingPair(record);
        if (pair) pairs.push(pair);
      }
    }
    if (!pairs.length) return { ok: false, error: 'Candidate skills had shards but no usable trajectories in them.' };

    const runDir = path.join(RUNS_DIR, runId);
    await fs.mkdir(runDir, { recursive: true });
    const datasetPath = path.join(runDir, 'dataset.jsonl');
    await fs.writeFile(datasetPath, pairs.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8');

    const run = {
      id: runId,
      createdAt: new Date().toISOString(),
      skills: candidates.map(c => c.name),
      totalExamples: pairs.length,
      datasetPath,
      baseModel: DEFAULT_BASE_MODEL,
      status: 'dataset_built', // dataset_built → trained → staged → promoted (or 'retired')
    };
    this._manifest.runs.push(run);
    await this._saveManifest();

    return { ok: true, run };
  }

  // ── 2. Train (Python subprocess) ────────────────────────────────────────

  /** Spawns scripts/train_lora.py. Streams stdout/stderr to
   *  <runDir>/train.log and resolves once the process exits — this can take
   *  a long time (CPU-only training on a laptop can genuinely be hours for
   *  a few hundred examples), so callers with a tool-call timeout should
   *  treat this as a background-ish operation, not an instant reply. */
  async train(runId, { epochs, pythonBin = PYTHON_BIN } = {}) {
    const run = this._run(runId);
    if (!run) return { ok: false, error: `Unknown run id "${runId}". Call buildDataset() first.` };

    const runDir  = path.join(RUNS_DIR, runId);
    const outDir  = path.join(runDir, 'model');
    const logPath = path.join(runDir, 'train.log');
    const scriptPath = path.resolve('./scripts/train_lora.py');

    const args = [
      scriptPath,
      '--dataset', path.resolve(run.datasetPath),
      '--base-model', run.baseModel,
      '--output-dir', path.resolve(outDir),
    ];
    if (epochs) args.push('--epochs', String(epochs));

    const result = await this._spawnLogged(pythonBin, args, logPath);
    if (!result.ok) {
      run.status = 'train_failed';
      await this._saveManifest();
      return { ok: false, error: `Training failed (exit ${result.code}). See ${logPath}.`, logPath };
    }

    run.status = 'trained';
    run.mergedModelDir = outDir;
    run.trainedAt = new Date().toISOString();
    await this._saveManifest();
    return { ok: true, run, logPath };
  }

  // ── 3. Export to Ollama (Python subprocess: merge check + GGUF + create) ──

  async exportToOllama(runId, { modelName, pythonBin = PYTHON_BIN } = {}) {
    const run = this._run(runId);
    if (!run) return { ok: false, error: `Unknown run id "${runId}".` };
    if (run.status !== 'trained' && run.status !== 'staged') {
      return { ok: false, error: `Run "${runId}" is not trained yet (status: ${run.status}). Call train() first.` };
    }

    const name = modelName || `jojo-local-${runId}`;
    const runDir  = path.join(RUNS_DIR, runId);
    const logPath = path.join(runDir, 'export.log');
    const scriptPath = path.resolve('./scripts/export_ollama_model.py');

    const args = [
      scriptPath,
      '--model-dir', path.resolve(run.mergedModelDir),
      '--ollama-name', name,
      '--work-dir', path.resolve(path.join(runDir, 'gguf')),
    ];

    const result = await this._spawnLogged(pythonBin, args, logPath);
    if (!result.ok) {
      return { ok: false, error: `Export failed (exit ${result.code}). See ${logPath}.`, logPath };
    }

    run.status = 'staged';
    run.ollamaModelName = name;
    run.stagedAt = new Date().toISOString();
    await this._saveManifest();
    return { ok: true, run, logPath };
  }

  // ── 4. Promotion (human-gated) ──────────────────────────────────────────

  /** Flip a staged run's model to be the one local_router.js is allowed to
   *  route real turns to. Refuses outright without human_approved: true —
   *  no different in kind from apply_rollout / apply_skill_update elsewhere
   *  in this codebase, and this is the step where a self-trained model
   *  starts actually talking to the user unsupervised. */
  async promote(runId, { humanApproved = false } = {}) {
    if (!humanApproved) {
      return { ok: false, error: 'Refused: promote() requires human_approved: true. Show the run\'s dataset/skills/eval to the human first.' };
    }
    const run = this._run(runId);
    if (!run) return { ok: false, error: `Unknown run id "${runId}".` };
    if (run.status !== 'staged') {
      return { ok: false, error: `Run "${runId}" is not staged (status: ${run.status}). Call exportToOllama() first.` };
    }

    const previous = this._manifest.promotedModel;
    run.status = 'promoted';
    run.promotedAt = new Date().toISOString();
    this._manifest.promotedModel = {
      runId, modelName: run.ollamaModelName, skills: run.skills, promotedAt: run.promotedAt,
    };
    await this._saveManifest();
    return { ok: true, promoted: this._manifest.promotedModel, previous };
  }

  /** Rollback — also human-gated, for the same reason apply_skill_update
   *  archives-before-write instead of silently overwriting. */
  async retire({ humanApproved = false } = {}) {
    if (!humanApproved) return { ok: false, error: 'Refused: retire() requires human_approved: true.' };
    const previous = this._manifest.promotedModel;
    if (!previous) return { ok: false, error: 'No model is currently promoted.' };
    this._manifest.promotedModel = null;
    const run = this._run(previous.runId);
    if (run) run.status = 'retired';
    await this._saveManifest();
    return { ok: true, retired: previous };
  }

  getPromotedModel() {
    return this._manifest?.promotedModel || null;
  }

  listRuns() {
    return this._manifest?.runs || [];
  }

  // ── System-prompt context ───────────────────────────────────────────────

  getContext() {
    const promoted = this.getPromotedModel();
    const lines = [];
    lines.push(promoted
      ? `- Locally promoted model: "${promoted.modelName}" (skills: ${promoted.skills.join(', ')}, promoted ${promoted.promotedAt}) — local_router.js may route matching turns to it.`
      : '- No local model promoted yet — every turn goes to the cloud model.');
    const runs = this.listRuns();
    if (runs.length) {
      const last = runs[runs.length - 1];
      lines.push(`- Last training run: ${last.id} (${last.status}, ${last.totalExamples} examples, skills: ${last.skills.join(', ')}).`);
    }
    return lines.join('\n');
  }

  // ── internals ────────────────────────────────────────────────────────────

  async _spawnLogged(cmd, args, logPath) {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const logStream = await fs.open(logPath, 'a');
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { shell: false });
      child.stdout.on('data', d => logStream.write(d));
      child.stderr.on('data', d => logStream.write(d));
      child.on('error', async (err) => {
        await logStream.write(`\n[spawn error] ${err.message}\n`);
        await logStream.close();
        resolve({ ok: false, code: null, error: err.message });
      });
      child.on('close', async (code) => {
        await logStream.close();
        resolve({ ok: code === 0, code });
      });
    });
  }
}

