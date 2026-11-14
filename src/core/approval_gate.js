// approval_gate.js — the "propose → hold pending → require human_approved=true
// → apply or dismiss" pattern, extracted once instead of reimplemented per file.
//
// Before this: healer.js, deploy.js, synthesis.js, and n8n.js each carried
// their own `this.pending = new Map()`, their own refusal string for a
// missing human_approved=true, their own "not found" message, their own
// cleanup-on-apply logic — four near-identical copies of the same ~15 lines,
// each free to drift slightly out of sync with the others over time (and
// each new irreversible-action tool would otherwise copy-paste a fifth).
//
// This collapses the MECHANISM into one audited, tested primitive, while
// deliberately leaving each subsystem's own domain logic and message wording
// where it belongs — in that subsystem:
//   - propose(record)      → subsystem decides WHAT goes pending and when
//   - apply(id, ok, fn)     → subsystem's `fn` decides what "applying" means
//     (write files, run a deployment, delete a workflow, ...)
//   - getContext(formatter) → subsystem decides exactly how to phrase what's
//     shown to the model/human (which tool-call incantation to quote, etc.)
//
// Only the boilerplate around those — approve-gating, not-found handling,
// pending-list eviction, cleanup-after-apply — lives here, once.

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export class ApprovalGate {
  /**
   * @param {string} [opts.idPrefix] - prefix for generated ids, e.g. 'fix', 'deploy', 'wf'
   * @param {string} [opts.kind] - human-readable noun used in default messages, e.g. 'fix', 'deployment'
   * @param {number} [opts.maxPending] - oldest entry is evicted once this many are queued
   */
  constructor({ idPrefix = 'req', kind = 'action', maxPending = 20 } = {}) {
    this.idPrefix = idPrefix;
    this.kind = kind;
    this.maxPending = maxPending;
    this.pending = new Map(); // id -> record
  }

  /** Queue a record for approval. Returns the full record (with id/createdAt
   *  attached) so the caller can format its own "here's what's pending" message.
   *  If `record` already carries its own `id` (some callers generate one
   *  earlier and reference it elsewhere before proposing — e.g. a deploy plan
   *  whose id is embedded in its own summary text), that id is used as the
   *  storage key rather than overwritten, so the key this is stored under and
   *  the id shown to the caller can never mismatch. */
  propose(record = {}) {
    if (this.pending.size >= this.maxPending) {
      const oldest = this.pending.keys().next().value;
      this.pending.delete(oldest);
    }
    const id = record.id || uid(this.idPrefix);
    const full = { ...record, id, createdAt: record.createdAt || new Date().toISOString() };
    this.pending.set(id, full);
    return full;
  }

  /**
   * Gate + execute. `executor(record)` only ever runs if humanApproved===true
   * AND a matching pending record exists — the two checks every one of the
   * four original implementations had to remember to both include.
   * @returns {{ok: boolean, message?: string, result?: any, record?: object}}
   */
  async apply(id, humanApproved, executor) {
    if (!humanApproved) {
      return {
        ok: false,
        message: `Refused: human_approved must be true. Show the human the full ${this.kind} details ` +
          `first, and only call this after they explicitly agree.`,
      };
    }
    const record = this.pending.get(id);
    if (!record) return { ok: false, message: `No pending ${this.kind} request with id "${id}".` };

    try {
      const result = await executor(record);
      this.pending.delete(id);
      return { ok: true, result, record };
    } catch (err) {
      // Deliberately NOT deleted on failure — a failed apply should stay
      // pending so the human can see what happened and retry/dismiss, not
      // silently vanish.
      return { ok: false, message: `Error applying ${this.kind}: ${err.message}`, record };
    }
  }

  /** Peek at a specific pending record without applying/dismissing it —
   *  needed by callers that must run async cleanup (e.g. removing on-disk
   *  scratch directories) using the record's own fields before dismissing. */
  get(id) {
    return this.pending.get(id);
  }

  /** `cleanup(record)` — optional, called (and awaited) BEFORE removal, only
   *  if a matching record exists. Lets callers that need async teardown
   *  (deleting scratch dirs, etc.) do it here instead of duplicating the
   *  "does this id even exist" check outside the gate. */
  async dismiss(id, cleanup) {
    const record = this.pending.get(id);
    if (!record) return `No pending ${this.kind} request with id "${id}".`;
    if (cleanup) {
      try { await cleanup(record); }
      catch { /* best-effort — a cleanup failure shouldn't block the actual dismiss */ }
    }
    this.pending.delete(id);
    return `Discarded pending ${this.kind} request [${id}].`;
  }

  list() {
    return [...this.pending.values()];
  }

  get size() {
    return this.pending.size;
  }

  /** `formatter(record) -> string` — one line per pending record, in
   *  whatever domain-specific wording the caller wants (tool-call syntax,
   *  which fields matter, etc). This class never invents that wording itself. */
  getContext(formatter) {
    if (!this.pending.size) return `(no pending ${this.kind} requests)`;
    const lines = [`${this.pending.size} pending ${this.kind} request(s) awaiting human approval:`];
    for (const record of this.pending.values()) lines.push(`  - ${formatter(record)}`);
    return lines.join('\n');
  }
}

