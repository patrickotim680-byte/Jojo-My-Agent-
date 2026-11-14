// ── Distillation Tools ───────────────────────────────────────────────────────
// Exposes distillation.js as callable tools. Context carries { distillation }
// — the shared Distillation instance — injected by the agent, same wiring
// pattern as { skillLedger } in skill_tools.js / { rollout } in
// rollout_tools.js.
//
// Five stages, five tools, each independently inspectable (same granularity
// as skill_tools.js's log/review/list/apply split):
//   distillation_status        — read-only: candidates, last run, promoted model
//   build_distillation_dataset — writes a training JSONL from captured trajectories
//   train_local_model          — runs the actual LoRA training subprocess (slow)
//   export_local_model_to_ollama — merge/GGUF/quantize/`ollama create` (slow)
//   promote_local_model        — HARD RULE, see below
//   retire_local_model         — HARD RULE, see below
//
// HARD RULE (also stated in agent.js IDENTITY): promote_local_model and
// retire_local_model must only be called after the human has explicitly said
// yes in chat — never speculatively, never inferred, never chained straight
// from build/train/export in the same turn. This is the same standard
// apply_skill_update and apply_rollout already hold themselves to, applied
// here to something with a materially higher blast radius: once promoted, a
// self-trained model starts answering real user turns unsupervised (see
// local_router.js).

export const DISTILLATION_TOOLS = [

  // ── distillation_status ───────────────────────────────────────────────────
  {
    name: 'distillation_status',
    declaration: {
      name: 'distillation_status',
      description:
        'Read-only. Shows which skills currently have enough captured trajectories to be worth a ' +
        'training run, whether enough NEW examples have piled up since the last run to make another ' +
        'one worthwhile, the most recent run\'s status, and which model (if any) is currently promoted ' +
        'for real local routing. Call this before build_distillation_dataset so you know whether it\'s ' +
        'actually worth doing yet.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { distillation }) {
      if (!distillation) return 'Distillation engine unavailable.';
      const candidates = await distillation.candidateSkills();
      const due = await distillation.dueForRetrain();
      const runs = distillation.listRuns();
      const promoted = distillation.getPromotedModel();

      const lines = [];
      lines.push(candidates.length
        ? candidates.map(c => `- ${c.name}: ${c.capturedCount} captured (score ${c.score?.toFixed?.(2) ?? 'n/a'}, ${c.status})${c.qualifies ? ' ✅ qualifies' : ''}`).join('\n')
        : '(no skill has any captured trajectories yet)');
      lines.push(`New qualifying examples since last run: ${due.newSinceLastRun} (retrain suggested at ${process.env.DISTILL_RETRAIN_EVERY_N_NEW || 50}+)${due.due ? ' — READY' : ''}`);
      lines.push(runs.length
        ? `Last run: ${runs[runs.length - 1].id} — ${runs[runs.length - 1].status} (${runs[runs.length - 1].totalExamples} examples: ${runs[runs.length - 1].skills.join(', ')})`
        : 'No training runs yet.');
      lines.push(promoted
        ? `Promoted model: "${promoted.modelName}" (skills: ${promoted.skills.join(', ')}, since ${promoted.promotedAt})`
        : 'No model currently promoted — every turn still goes to the cloud model.');

      return lines.join('\n');
    },
  },

  // ── build_distillation_dataset ────────────────────────────────────────────
  {
    name: 'build_distillation_dataset',
    declaration: {
      name: 'build_distillation_dataset',
      description:
        'Writes a fresh LoRA training dataset (JSONL) to disk from every skill\'s captured trajectories ' +
        'that currently qualifies (see distillation_status). This only writes a file — it does not train ' +
        'anything and has no other side effect, so it\'s safe to call without asking first. Returns a ' +
        'run_id to pass into train_local_model next.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { distillation }) {
      if (!distillation) return 'Distillation engine unavailable.';
      const result = await distillation.buildDataset();
      if (!result.ok) return `Not ready: ${result.error}`;
      return `Dataset built. run_id=${result.run.id} — ${result.run.totalExamples} examples from skills: ${result.run.skills.join(', ')}. Next: train_local_model(run_id="${result.run.id}").`;
    },
  },

  // ── train_local_model ──────────────────────────────────────────────────────
  {
    name: 'train_local_model',
    declaration: {
      name: 'train_local_model',
      description:
        'Runs the actual LoRA training subprocess (scripts/train_lora.py) for a run produced by ' +
        'build_distillation_dataset. This can genuinely take minutes to hours depending on the machine\'s ' +
        'hardware — warn the user before calling this on anything but a small dataset, and don\'t assume ' +
        'it finished quickly. Produces a merged local model directory, not yet exported or routable.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'The run_id returned by build_distillation_dataset.' },
          epochs: { type: 'integer', description: 'Optional. Training epochs — defaults to the script\'s own default if omitted.' },
        },
        required: ['run_id'],
      },
    },
    async execute({ run_id, epochs }, { distillation }) {
      if (!distillation) return 'Distillation engine unavailable.';
      const result = await distillation.train(run_id, { epochs });
      if (!result.ok) return `Training failed: ${result.error}`;
      return `Training complete for ${run_id}. Merged model at ${result.run.mergedModelDir}. Next: export_local_model_to_ollama(run_id="${run_id}").`;
    },
  },

  // ── export_local_model_to_ollama ──────────────────────────────────────────
  {
    name: 'export_local_model_to_ollama',
    declaration: {
      name: 'export_local_model_to_ollama',
      description:
        'Converts a trained run\'s merged model to GGUF and registers it with Ollama (scripts/' +
        'export_ollama_model.py — requires Ollama and a llama.cpp checkout, see DISTILLATION.md). The ' +
        'resulting model is STAGED only — nothing routes real turns to it until promote_local_model is ' +
        'called AND approved by the human.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'The run_id from train_local_model.' },
          model_name: { type: 'string', description: 'Optional Ollama model name. Defaults to "jojo-local-<run_id>".' },
        },
        required: ['run_id'],
      },
    },
    async execute({ run_id, model_name }, { distillation }) {
      if (!distillation) return 'Distillation engine unavailable.';
      const result = await distillation.exportToOllama(run_id, { modelName: model_name });
      if (!result.ok) return `Export failed: ${result.error}`;
      return `Staged as Ollama model "${result.run.ollamaModelName}". Nothing routes to it yet. Show the user the run\'s dataset/skills, then call promote_local_model only once they explicitly approve.`;
    },
  },

  // ── promote_local_model ───────────────────────────────────────────────────
  {
    name: 'promote_local_model',
    declaration: {
      name: 'promote_local_model',
      description:
        'Makes a staged local model the one local_router.js may route real turns to. HARD RULE: only ' +
        'call this after the human has explicitly approved doing so, having seen which skills/how many ' +
        'examples the model was trained on. Never call it speculatively, never infer approval, never ' +
        'chain straight from export_local_model_to_ollama into this in the same turn.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'The run_id from export_local_model_to_ollama.' },
          human_approved: { type: 'boolean', description: 'Must be true — set only after the human explicitly said yes to this specific run.' },
        },
        required: ['run_id', 'human_approved'],
      },
    },
    async execute({ run_id, human_approved }, { distillation }) {
      if (!distillation) return 'Distillation engine unavailable.';
      const result = await distillation.promote(run_id, { humanApproved: !!human_approved });
      if (!result.ok) return result.error;
      return `Promoted "${result.promoted.modelName}" (skills: ${result.promoted.skills.join(', ')}). Local routing is now active for matching turns.`;
    },
  },

  // ── retire_local_model ────────────────────────────────────────────────────
  {
    name: 'retire_local_model',
    declaration: {
      name: 'retire_local_model',
      description:
        'Rolls back the currently promoted local model — every turn goes back to the cloud model only. ' +
        'HARD RULE: same as promote_local_model, only call this after explicit human approval.',
      parameters: {
        type: 'object',
        properties: {
          human_approved: { type: 'boolean', description: 'Must be true.' },
        },
        required: ['human_approved'],
      },
    },
    async execute({ human_approved }, { distillation }) {
      if (!distillation) return 'Distillation engine unavailable.';
      const result = await distillation.retire({ humanApproved: !!human_approved });
      if (!result.ok) return result.error;
      return `Retired "${result.retired.modelName}". All turns now go to the cloud model until a new model is promoted.`;
    },
  },

  // ── list_distillation_runs ────────────────────────────────────────────────
  {
    name: 'list_distillation_runs',
    declaration: {
      name: 'list_distillation_runs',
      description: 'Read-only. Full history of training runs — dataset size, skills, status, timestamps.',
      parameters: { type: 'object', properties: {} },
    },
    async execute(_args, { distillation }) {
      if (!distillation) return 'Distillation engine unavailable.';
      const runs = distillation.listRuns();
      if (!runs.length) return 'No training runs yet.';
      return runs.map(r => `- ${r.id} [${r.status}] ${r.totalExamples} examples, skills: ${r.skills.join(', ')}, created ${r.createdAt}`).join('\n');
    },
  },
];

