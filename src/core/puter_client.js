/**
 * puter_client.js — multi-provider fallback chain.
 *
 * Filename/exports kept stable on purpose (`PuterAI`, `DEFAULT_MODEL`) — every
 * other file in the codebase imports only those two names, so none of them
 * need to change.
 *
 * Tries providers in order until one works. Default order:
 *   gemini → nvidia → puter (Claude) → openai
 * A provider is only attempted if its credential is actually set in .env —
 * missing ones are skipped silently, not treated as failures. Within a
 * provider, transient errors (timeouts, 429/5xx, dropped connections) retry
 * with backoff; permanent errors (bad key, quota exhausted) fail fast and
 * move to the next provider instead of wasting a slow connection retrying
 * something that can't succeed.
 *
 * Override order/models via .env:
 *   PROVIDER_ORDER=gemini,nvidia,puter,openai
 *   GEMINI_MODEL / NVIDIA_MODEL / PUTER_MODEL / OPENAI_MODEL
 *
 * Why gemini → nvidia → puter → openai by default: Gemini's free tier is the
 * most generous when its key works; NVIDIA NIM is genuinely free with no
 * known key-rollout issues (open-weight models only); Puter reaches real
 * Claude for free but with tighter quota; OpenAI has no meaningful free tier
 * as of 2026, so it's last — only useful once you've added billing.
 *
 * Everything below gemini uses one shared conversion path, because Puter,
 * OpenAI, and NVIDIA NIM all speak the same OpenAI-compatible chat-completions
 * wire format. Gemini gets its own native path via @google/genai for best
 * quality/perf when it's available.
 */

import { GoogleGenAI } from '@google/genai';

// ── Single source of truth for the default model ────────────────────────────
export const DEFAULT_MODEL = 'gemini-2.5-flash';

// ── Weak-network resilience ─────────────────────────────────────────────
const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || '2', 10); // per-provider — kept
                                                                          // low since the chain
                                                                          // itself is the outer
                                                                          // retry mechanism now
const RETRY_BASE_MS = parseInt(process.env.GEMINI_RETRY_BASE_MS || '800', 10);

function isTransient(err) {
  const status = err?.status ?? err?.code;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const msg = String(err?.message || '').toLowerCase();
  return ['timeout', 'timed out', 'econnreset', 'econnrefused', 'enotfound',
    'fetch failed', 'network', 'socket hang up'].some(s => msg.includes(s));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES || !isTransient(err)) throw err;
      const backoff = RETRY_BASE_MS * 2 ** attempt + Math.random() * 300;
      console.error(`[${label}] transient failure, retrying in ${Math.round(backoff)}ms (${attempt + 1}/${MAX_RETRIES})…`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// Google's raw error messages sometimes embed a full JSON blob, which prints
// as several ugly wrapped red lines in the terminal. Pull just the readable
// part out and cap length, so failures stay a single short line.
function cleanMessage(err) {
  let msg = err?.message || String(err);
  const m = msg.match(/"message"\s*:\s*"([^"]+)"/);
  if (m) msg = m[1];
  return msg.length > 180 ? msg.slice(0, 180) + '…' : msg;
}

// ═══════════════════════════════════════════════════════════════════════
// Shared conversion: Gemini Content[] history ⇄ OpenAI-style messages
// (used by nvidia / puter / openai — all OpenAI-compatible wire format)
// ═══════════════════════════════════════════════════════════════════════

function geminiHistoryToOpenAI(history = [], systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  let pendingIds = [];
  for (const turn of history) {
    const parts = turn.parts || [];
    const calls = parts.filter(p => p.functionCall);
    const responses = parts.filter(p => p.functionResponse);
    const text = parts.filter(p => p.text != null).map(p => p.text).join('');
    if (calls.length) {
      const tool_calls = calls.map((p, i) => ({
        id: `call_${messages.length}_${i}`,
        type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
      }));
      pendingIds = tool_calls.map(tc => tc.id);
      messages.push({ role: 'assistant', content: text || null, tool_calls });
    } else if (responses.length) {
      responses.forEach((p, i) => {
        messages.push({
          role: 'tool',
          tool_call_id: pendingIds[i] || `call_unmatched_${i}`,
          content: String(p.functionResponse.response?.result ?? ''),
        });
      });
      pendingIds = [];
    } else {
      const hasImage = parts.some(p => p.inlineData);
      messages.push({
        role: turn.role === 'model' ? 'assistant' : 'user',
        content: hasImage ? (text || '[image omitted for this provider]') : text,
      });
    }
  }
  return messages;
}

function toOpenAITools(functionDeclarations) {
  if (!functionDeclarations?.length) return undefined;
  return functionDeclarations.map(fn => ({
    type: 'function',
    function: { name: fn.name, description: fn.description || '', parameters: fn.parameters || { type: 'object', properties: {} } },
  }));
}

function normalizeOpenAIResponse(res) {
  if (typeof res === 'string') return { text: res, functionCalls: [] };
  const msg = res.message || res.choices?.[0]?.message || res;
  const text = typeof msg?.content === 'string' ? msg.content : '';
  const rawCalls = msg?.tool_calls || [];
  const functionCalls = rawCalls.map(tc => {
    let args = {};
    try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {}); }
    catch { /* leave {} on malformed JSON rather than throw */ }
    return { name: tc.function.name, args };
  });
  return { text, functionCalls };
}

async function callOpenAICompatible({ baseUrl, apiKey, model, messages, tools, temperature, maxTokens }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools, temperature, max_tokens: maxTokens }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function callPuter({ model, messages, tools, temperature, maxTokens }) {
  const token = process.env.PUTER_AUTH_TOKEN;
  if (!token) { const e = new Error('PUTER_AUTH_TOKEN not set'); e.status = 401; throw e; }
  const { init } = await import('@heyputer/puter.js/src/init.cjs');
  const puter = init(token);
  return puter.ai.chat(messages, { model, tools, temperature, max_tokens: maxTokens });
}

// ═══════════════════════════════════════════════════════════════════════
// Gemini native path (own format — best quality/perf when the key works)
// ═══════════════════════════════════════════════════════════════════════

let _genAI = null;
function getGenAI() {
  if (_genAI) return _genAI;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { const e = new Error('GEMINI_API_KEY not set'); e.status = 401; throw e; }
  _genAI = new GoogleGenAI({ apiKey });
  return _genAI;
}

function remapToolsForGemini(tools) {
  if (!tools) return undefined;
  return tools.map(t => ({
    functionDeclarations: (t.functionDeclarations || []).map(d => ({
      name: d.name,
      description: d.description,
      parametersJsonSchema: d.parameters, // native Gemini SDK wants this key for plain JSON Schema
    })),
  }));
}

async function callGeminiNative({ model, geminiHistory, message, systemInstruction, geminiTools, temperature, maxTokens }) {
  const chat = getGenAI().chats.create({
    model,
    history: geminiHistory,
    config: {
      systemInstruction,
      tools: remapToolsForGemini(geminiTools),
      temperature,
      maxOutputTokens: maxTokens,
    },
  });
  const res = await chat.sendMessage({ message });
  const calls = res.functionCalls;
  return {
    text: res.text ?? '',
    functionCalls: calls && calls.length ? calls.map(c => ({ name: c.name, args: c.args || {} })) : [],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Provider chain
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_ORDER = ['gemini', 'nvidia', 'puter', 'openai'];

function configuredProviders() {
  const order = (process.env.PROVIDER_ORDER || DEFAULT_ORDER.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const have = {
    gemini: !!process.env.GEMINI_API_KEY,
    nvidia: !!process.env.NVIDIA_API_KEY,
    puter:  !!process.env.PUTER_AUTH_TOKEN,
    openai: !!process.env.OPENAI_API_KEY,
  };
  return order.filter(name => have[name]);
}

async function callProvider(name, ctx) {
  const { geminiHistory, message, systemInstruction, geminiTools, openaiTools, temperature, maxTokens } = ctx;

  if (name === 'gemini') {
    return callGeminiNative({
      model: process.env.GEMINI_MODEL || DEFAULT_MODEL,
      geminiHistory, message, systemInstruction, geminiTools, temperature, maxTokens,
    });
  }

  const messages = geminiHistoryToOpenAI(
    [...geminiHistory, { role: 'user', parts: typeof message === 'string' ? [{ text: message }] : message }],
    systemInstruction
  );

  if (name === 'nvidia') {
    return normalizeOpenAIResponse(await callOpenAICompatible({
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: process.env.NVIDIA_API_KEY,
      model: process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct',
      messages, tools: openaiTools, temperature, maxTokens,
    }));
  }
  if (name === 'puter') {
    return normalizeOpenAIResponse(await callPuter({
      model: process.env.PUTER_MODEL || 'claude-fable-5',
      messages, tools: openaiTools, temperature, maxTokens,
    }));
  }
  if (name === 'openai') {
    return normalizeOpenAIResponse(await callOpenAICompatible({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages, tools: openaiTools, temperature, maxTokens,
    }));
  }
  throw new Error(`Unknown provider "${name}"`);
}

async function runChain(ctx) {
  let providers = configuredProviders();
  if (!providers.length) {
    throw new Error(
      'No provider configured. Set at least one of GEMINI_API_KEY, NVIDIA_API_KEY, PUTER_AUTH_TOKEN, ' +
      'OPENAI_API_KEY in .env (bash scripts/set_key.sh helps for GEMINI_API_KEY).'
    );
  }

  // Reorders, never restricts — a preferred provider that's down/unconfigured
  // just falls through to the rest of the normal order, same as any other
  // failure. This is how conductor.js's "prefer Claude for code" and the
  // REPL's `model` command's manual pin both work — neither ever narrows
  // resilience, only nudges which provider gets tried first.
  if (ctx.preferredProvider && providers.includes(ctx.preferredProvider)) {
    providers = [ctx.preferredProvider, ...providers.filter(p => p !== ctx.preferredProvider)];
  }

  const failures = [];
  for (const name of providers) {
    try {
      const result = await withRetry(() => callProvider(name, ctx), name);
      if (failures.length) console.error(`[providers] recovered via ${name}.`);
      return { ...result, provider: name };
    } catch (err) {
      failures.push(`${name}: ${cleanMessage(err)}`);
      console.error(`[providers] ${name} unavailable (${cleanMessage(err)}) — trying next…`);
    }
  }
  throw new Error(`All providers failed: ${failures.join(' | ')}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Stable public interface (unchanged shape — nothing else in the codebase
// needs to know a chain exists underneath)
// ═══════════════════════════════════════════════════════════════════════

class ChainChat {
  constructor(modelWrapper, history = []) {
    this._model = modelWrapper;
    this._history = [...history]; // canonical Gemini Content[] shape, evolves each turn
  }

  async sendMessage(input) {
    const newTurnParts = typeof input === 'string' ? [{ text: input }] : input;
    const result = await runChain({
      geminiHistory: this._history,
      message: input,
      systemInstruction: this._model.systemInstruction,
      geminiTools: this._model.tools,
      openaiTools: toOpenAITools(this._model.tools?.[0]?.functionDeclarations),
      temperature: this._model.generationConfig?.temperature,
      maxTokens: this._model.generationConfig?.maxOutputTokens,
      preferredProvider: this._model.preferredProvider,
    });

    // Record both sides of this turn in canonical shape so later turns —
    // even if served by a *different* provider — have full context.
    this._history.push({ role: 'user', parts: newTurnParts });
    this._history.push({
      role: 'model',
      parts: result.functionCalls.length
        ? result.functionCalls.map(fc => ({ functionCall: { name: fc.name, args: fc.args } }))
        : [{ text: result.text }],
    });

    return {
      response: {
        text: () => result.text,
        functionCalls: () => (result.functionCalls.length ? result.functionCalls : undefined),
      },
    };
  }
}

class ChainModel {
  constructor({ model, systemInstruction, tools, generationConfig, preferredProvider } = {}) {
    this.model = model; // per-call model override isn't used by the chain (each provider has its
                         // own *_MODEL env var), kept for interface compatibility only
    this.systemInstruction = systemInstruction;
    this.tools = tools;
    this.generationConfig = generationConfig || {};
    this.preferredProvider = preferredProvider || null; // e.g. conductor.js's codeHeavy guess,
                                                          // or a manual pin from the REPL's `model` command
  }

  startChat({ history = [] } = {}) {
    return new ChainChat(this, history);
  }

  async generateContent(promptOrRequest) {
    const geminiHistory = typeof promptOrRequest === 'string' ? [] : (promptOrRequest.contents || []).slice(0, -1);
    const last = typeof promptOrRequest === 'string'
      ? promptOrRequest
      : (promptOrRequest.contents || []).at(-1)?.parts || [{ text: '' }];

    const result = await runChain({
      geminiHistory,
      message: last,
      systemInstruction: this.systemInstruction,
      geminiTools: this.tools,
      openaiTools: toOpenAITools(this.tools?.[0]?.functionDeclarations),
      temperature: this.generationConfig.temperature,
      maxTokens: this.generationConfig.maxOutputTokens,
    });

    return {
      response: {
        text: () => result.text,
        functionCalls: () => (result.functionCalls.length ? result.functionCalls : undefined),
      },
    };
  }
}

export class PuterAI {
  getGenerativeModel(config) {
    return new ChainModel(config);
  }
}

