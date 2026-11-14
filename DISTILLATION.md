# Local Distillation (Jojo Trains a Piece of Itself, Permanently, On You)

`learning.js`'s own header draws the contrast this feature closes: unlike Claude's offline batch
updates weeks/months apart, Jojo learns immediately within a session — but until now that only
ever meant writing JSON to `memory/`. This feature adds the other half: routine, well-worn tasks
get distilled into a real LoRA fine-tune of a small local model, served via Ollama, so they can be
answered instantly, for free, offline — with everything else still going to the cloud model.

Three files, one pipeline:

- **`src/core/trajectory_logger.js`** — watches the same turns `agent.js` already logs, and for
  ones that finished a loaded skill with a clean success AND that skill has an earned track record
  (not a fluke first try), writes the full trajectory to disk. Score-gated, redacted, size-capped.
- **`src/core/distillation.js`** — turns the accumulated log into training data, runs the actual
  LoRA training subprocess, exports the result to Ollama, and gates putting it into real routing
  behind explicit human approval.
- **`src/core/local_router.js`** — the confidence gate. Decides, per turn, whether the promoted
  local model is trusted to answer, or whether the turn falls through to the cloud model as normal.

## The pipeline, end to end

```
captured trajectories (trajectory_logger.js, automatic, passive)
        │
        ▼
build_distillation_dataset   — writes memory/distillation/runs/<id>/dataset.jsonl
        │
        ▼
train_local_model            — scripts/train_lora.py (Python: transformers + peft)
        │                       trains a LoRA adapter, merges it, saves a plain HF model dir
        ▼
export_local_model_to_ollama — scripts/export_ollama_model.py
        │                       merged model → GGUF (llama.cpp convert script) → optional
        │                       quantize → `ollama create` → STAGED, nothing routes to it yet
        ▼
promote_local_model          — HUMAN-GATED. Only after explicit approval does local_router.js
                                start routing matching turns to it.
```

Every stage above is its own tool (`distillation_tools.js`), independently inspectable —
`distillation_status` at any point shows what's captured, what qualifies, and what's promoted.

## What qualifies for a training run

A skill's captured trajectories go into the next dataset once:

- `skillLedger.getScore(name).status` is `'active'` or `'core'` **right now** — re-checked at
  distill time, not just at capture time, since a skill can regress in between.
- At least `DISTILL_MIN_EXAMPLES` (default 25) trajectories have been captured for it.
- It isn't in the exclusion list (see below).

All qualifying skills' examples go into **one** adapter per run, not one per skill — Ollama serves
one model at a time per name, and personal task volume tends to cluster into a handful of skills
anyway.

## Why the local model never gets tools

`buildDataset()` collapses every captured trajectory down to a single (context → final text
answer) training pair. Tool calls inside a trajectory become read-only context text in the
prompt — never something the model is trained to reproduce. Two reasons:

1. `local_router.js` never hands the local model a tool registry at serving time. Training it to
   emit function-call syntax it can then never invoke would just teach it to hallucinate tool use.
2. Even setting that aside: a small fine-tuned adapter calling `bash_execute` / `deploy_apply` /
   browser tools with none of the cloud model's judgement behind it is a materially different risk
   profile than Claude doing the same. That's a separate design conversation with its own review,
   not a natural next step from this file.

Local answers are text-only completions for a small, closed set of previously-successful patterns —
nothing more.

## Exclusion list (defense in depth)

`trajectory_logger.js`'s `DEFAULT_SKILL_EXCLUDE` — seeded from the same tool surface `agent.js`'s
own IDENTITY prompt already treats as high-stakes — is never captured in the first place:

```js
['aircrack', 'nmap', 'deploy', 'n8n', 'monetization', 'stripe', 'browser-irreversible']
```

`distillation.js` re-checks this same set at dataset-build time (a skill shouldn't have been
captured if it's excluded, but this doesn't trust that invariant blindly across a version gap), and
`local_router.js` re-checks it a third time at routing time, against the *promoted* model's actual
trained skill list. Three independent checks of the same boundary, on purpose.

## The confidence gate (`local_router.js`)

A turn only ever gets routed locally when **all** of the following hold — any single miss falls
through to the cloud model:

1. A model is promoted and Ollama answers a ping.
2. The message keyword-matches one of the promoted model's trained skills (cheap heuristic, same
   "free, heuristic-only" style as `reasoning.js`'s `classify()` — no model call).
3. That skill isn't in the exclusion list.
4. The local model itself replies with `CONFIDENCE: high` as the first line of its answer (a
   self-report from a small model with none of the cloud model's judgement behind it — treat it as
   a weak signal, not a guarantee). `medium`, `low`, missing, or malformed all fall back to cloud.

This is deliberately asymmetric: local only wins when it's cheap **and** clearly sure. A wrong
"confident" answer reaching the user silently is worse than one extra cloud call.

## Promotion is human-gated, same as everywhere else in this codebase

`train()` and `exportToOllama()` only ever produce a **staged** candidate. `promote_local_model`
is the one call that makes `local_router.js` start using it for real, and — like `apply_rollout`,
`apply_skill_update`, and `apply_deployment` — it refuses to run without `human_approved: true`.
Nothing about a training script's output has been reviewed by a human until this point; the same
standard already applied to a code diff or a deploy plan applies here, arguably more so, since
what's being approved is "trust this model's own words on real future tasks."

`retire_local_model` (also human-gated) is the rollback — flips back to cloud-only routing.

"Periodic" retraining is a nudge, not a scheduler: `distillation_status` reports when enough new
examples have piled up since the last run (`DISTILL_RETRAIN_EVERY_N_NEW`, default 50) to make
another run worthwhile, but nothing in this codebase ever kicks off a training subprocess — real
CPU/GPU time, minutes to hours — without an explicit tool call.

## One-time setup (Windows)

1. **Python deps** — a venv is recommended, but the system Python works too:
   ```
   pip install --break-system-packages torch transformers peft accelerate datasets
   ```
   No GPU required. If `torch.cuda.is_available()` is false, `train_lora.py` trains on CPU
   automatically — slower, but this is a small-model, small-dataset job by design (see
   `distillation.js`'s header), not a foundation-model training run.

2. **Ollama** — install from https://ollama.com/download/windows, confirm `ollama` is on PATH.

3. **llama.cpp, for its convert script only** — no build/compile needed for this part:
   ```
   git clone https://github.com/ggml-org/llama.cpp
   ```
   Set `LLAMA_CPP_DIR` to the checkout path (or pass `--llama-cpp-dir` directly).

4. **(Optional) quantization** — to shrink the exported model, grab a prebuilt
   `llama-*-bin-win-*.zip` from llama.cpp's GitHub Releases (no build required) and set
   `LLAMA_QUANTIZE_BIN` to `llama-quantize.exe` inside it. Without this, export just uses the
   full-precision (f16) GGUF — larger on disk, works the same otherwise.

5. **Base model** — defaults to `Qwen/Qwen2.5-1.5B-Instruct` (Apache 2.0, small enough for CPU
   training and llama.cpp conversion). Override with `DISTILL_BASE_MODEL` if you'd rather use
   something else — anything `transformers` + llama.cpp's convert script both support works.

## Env vars

| Var | Default | Meaning |
|---|---|---|
| `DISTILL_MIN_EXAMPLES` | `25` | Captured trajectories a skill needs before it qualifies |
| `DISTILL_RETRAIN_EVERY_N_NEW` | `50` | New qualifying examples before `distillation_status` flags "ready" |
| `DISTILL_BASE_MODEL` | `Qwen/Qwen2.5-1.5B-Instruct` | Base model for training |
| `DISTILL_PYTHON` | `python` (Windows) / `python3` | Interpreter `distillation.js` shells out to |
| `LLAMA_CPP_DIR` | — | Path to a llama.cpp checkout (convert script) |
| `LLAMA_QUANTIZE_BIN` | — | Path to `llama-quantize(.exe)`, optional |
| `OLLAMA_HOST` | `http://localhost:11434` | Where `local_router.js` looks for Ollama |
| `LOCAL_ROUTER_TIMEOUT_MS` | `15000` | Local generation timeout before falling back to cloud |
| `DISTILL_MAX_TRAJECTORIES_PER_SKILL` | `4000` | (trajectory_logger.js) shard rotation size |
| `DISTILL_MAX_FIELD_CHARS` | `20000` | (trajectory_logger.js) per-field truncation before redaction |

## Honest limits

- Keyword-trigger matching in `local_router.js` is not intent understanding — it will occasionally
  miss something it could have handled (harmless: falls back to cloud) but the confidence gate is
  what keeps a bad match from actually mattering.
- The local model's self-reported confidence has no calibration guarantee. Treat local answers as
  "probably fine for a routine, previously-seen pattern," never as verified.
- `trajectory_logger.js`'s `redact()` is a best-effort regex scrub for credential-shaped strings,
  not a secret scanner — review `memory/trajectories/` yourself before trusting it as a training
  corpus for anything you'd mind seeing again.
- CPU training is genuinely slow. This is meant to run unattended (kick it off, walk away), not
  interactively.

