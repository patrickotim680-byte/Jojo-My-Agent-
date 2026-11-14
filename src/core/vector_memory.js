/**
 * VectorMemory — semantic-ish memory for Jojo.
 *
 * Puter's free API has no embeddings endpoint, so this no longer calls out
 * to any model for embeddings. Instead it uses a local, deterministic
 * hashing-trick embedding (bag-of-words → fixed-size vector, like the
 * classic "feature hashing" technique). It costs nothing, needs no network
 * call, and still supports cosine-similarity retrieval — but it's weaker
 * than a real trained embedding model: it catches shared vocabulary and
 * word overlap well, but won't understand synonyms or paraphrase the way
 * text-embedding-004 did (e.g. "car" and "automobile" won't be seen as
 * similar). Good enough for keyword-adjacent recall; not true semantic search.
 *
 * Categories
 * ──────────
 *   creator      – anything about the person who built / uses Jojo
 *   general      – catch-all facts and observations
 *   knowledge    – researched / synthesised topic summaries
 *   entity       – named people, places, organisations, things
 *   conversation – notable exchanges worth remembering
 *
 * Storage
 * ───────
 *   memory/vectors.json  – array of { id, text, embedding[], category,
 *                            timestamp, metadata{} }
 *   Embeddings are stripped from search results so the LLM never sees raw
 *   float arrays; only human-readable text is returned.
 */

import fs   from 'fs/promises';
import path from 'path';

const VECTORS_FILE = './memory/vectors.json';
const HASH_DIMS     = 256; // local embedding size — no external model needed

// ── helpers ───────────────────────────────────────────────────────────────────

/** Cosine similarity between two equal-length float arrays. */
function cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Simple string hash (djb2) → non-negative int. */
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

/** Tokenize into lowercase words + bigrams, so word order matters a little. */
function tokenize(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9']+/g) || [];
  const grams = [...words];
  for (let i = 0; i < words.length - 1; i++) grams.push(words[i] + '_' + words[i + 1]);
  return grams;
}

/** Tiny uid – timestamp + 5 random chars. */
function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── VectorMemory ──────────────────────────────────────────────────────────────

export class VectorMemory {
  /**
   * No arguments needed — embeddings are computed locally now. The `genAI`
   * param is still accepted (and ignored) so agent.js doesn't need to
   * change its constructor call.
   */
  constructor(_genAI) {
    this._entries = [];   // in-memory array; mirrored to disk
    this._ready   = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async init() {
    await fs.mkdir('./memory', { recursive: true });
    try {
      const raw = await fs.readFile(VECTORS_FILE, 'utf-8');
      this._entries = JSON.parse(raw);
    } catch {
      this._entries = [];
      await this._save();
    }
    this._ready = true;
  }

  // ── Core operations ───────────────────────────────────────────────────────

  /** Generate a local, deterministic HASH_DIMS-dim embedding for `text`. */
  async _embed(text) {
    const vec = new Array(HASH_DIMS).fill(0);
    for (const gram of tokenize(text)) {
      const idx  = djb2(gram) % HASH_DIMS;
      const sign = (djb2(gram + '_sign') % 2 === 0) ? 1 : -1; // spread bias across +/-
      vec[idx] += sign;
    }
    // L2-normalize so cosine similarity behaves consistently across lengths.
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }

  /** Persist current entries to disk. */
  async _save() {
    await fs.writeFile(VECTORS_FILE, JSON.stringify(this._entries, null, 2));
  }

  /**
   * Store text with its embedding.
   *
   * @param {string} text        – The content to remember.
   * @param {string} category    – One of: creator | general | knowledge | entity | conversation
   * @param {object} [metadata]  – Any extra key-value data to attach.
   * @returns {string} The new entry's id.
   */
  async store(text, category = 'general', metadata = {}) {
    const embedding = await this._embed(text);
    const entry = {
      id:        uid(),
      text,
      embedding,
      category,
      timestamp: new Date().toISOString(),
      metadata,
    };
    this._entries.push(entry);
    await this._save();
    return entry.id;
  }

  /**
   * Semantic search: embed `query` then rank stored entries by cosine similarity.
   *
   * @param {string}  query
   * @param {object}  opts
   * @param {number}  [opts.topK=5]       – Max results to return.
   * @param {string}  [opts.category]     – If set, restrict to that category.
   * @param {number}  [opts.minScore=0.3] – Drop results below this similarity.
   * @returns {Array<{id,text,category,timestamp,metadata,score}>}
   */
  async search(query, { topK = 5, category = null, minScore = 0.3 } = {}) {
    if (!this._entries.length) return [];

    const queryVec  = await this._embed(query);
    let   candidates = category
      ? this._entries.filter(e => e.category === category)
      : this._entries;

    const scored = candidates
      .map(e => ({ ...e, score: cosine(queryVec, e.embedding) }))
      .filter(e => e.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Strip raw embedding vectors from returned objects
    return scored.map(({ embedding, ...rest }) => rest);
  }

  /**
   * Delete an entry by id.
   * @returns {boolean} true if found and deleted.
   */
  async delete(id) {
    const before = this._entries.length;
    this._entries = this._entries.filter(e => e.id !== id);
    if (this._entries.length < before) {
      await this._save();
      return true;
    }
    return false;
  }

  // ── Creator context (injected into system prompt) ─────────────────────────

  /**
   * Return a compact text block summarising what Jojo knows about its creator.
   * Called every turn so it's kept brief (≤ 300 tokens).
   */
  getCreatorContext() {
    const creator = this._entries
      .filter(e => e.category === 'creator')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 15);   // most recent 15 creator facts

    if (!creator.length) return '(nothing stored about creator yet)';
    return creator.map((e, i) => `${i + 1}. ${e.text}`).join('\n');
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats() {
    const cats = {};
    for (const e of this._entries) cats[e.category] = (cats[e.category] || 0) + 1;
    return { total: this._entries.length, byCategory: cats };
  }

  /** For CLI display. */
  show() {
    const stats = this.getStats();
    console.log(`\n🧠  Vector Memory: ${stats.total} entries`);
    for (const [cat, n] of Object.entries(stats.byCategory)) {
      console.log(`   · ${cat}: ${n}`);
    }
    console.log('');
  }
}

