// ── LearningSystem ────────────────────────────────────────────────────────────
// Jojo's autonomous real-time learning engine.
//
// Unlike Claude (offline RLHF batch updates, weeks/months apart), Jojo learns
// IMMEDIATELY within any session:
//   • Research: web-searches topic → synthesizes structured knowledge → stores
//   • Self-review: grades its own responses → commits corrections to memory
//   • Practice: generates problems → evaluates attempts → tracks skill levels 1-5
//   • Curiosity: autonomously picks knowledge gaps → researches without being asked
//
// All learnings are transparent, inspectable, and editable (just JSON + memory).

import { PuterAI, DEFAULT_MODEL } from './puter_client.js';

export class LearningSystem {
  constructor(memory) {
    this.memory = memory;
    this._model = null;
  }

  // ── Lazy Gemini model init ─────────────────────────────────────────────────

  _getModel() {
    if (!this._model) {
      if (!process.env.PUTER_AUTH_TOKEN) throw new Error('PUTER_AUTH_TOKEN required for learning engine.');
      const genAI = new PuterAI();
      this._model = genAI.getGenerativeModel({
        model: process.env.PUTER_MODEL || DEFAULT_MODEL,
        generationConfig: {
          temperature:     parseFloat(process.env.LEARNING_TEMPERATURE || '0.2'),
          maxOutputTokens: 2048,
        },
      });
    }
    return this._model;
  }

  async _generate(prompt) {
    const result = await this._getModel().generateContent(prompt);
    const text   = result.response.text().replace(/```json\n?|```/g, '').trim();
    try {
      return JSON.parse(text);
    } catch {
      // Try to extract JSON from response if wrapped in prose
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error(`Non-JSON response from learning engine: ${text.slice(0, 200)}`);
    }
  }

  // ── Init: ensure memory data structures exist ─────────────────────────────

  async init() {
    const d = this.memory.data;
    if (!d.knowledge)        d.knowledge        = {};
    if (!d.learning_log)     d.learning_log     = [];
    if (!d.skills_practiced) d.skills_practiced = {};
    if (!d.self_eval_history)d.self_eval_history = [];
    // Don't save here — will save when first learning happens
  }

  // ── Synthesize web research into structured knowledge ─────────────────────

  async synthesize(topic, rawContent) {
    const prompt = `You are a knowledge synthesis engine for an autonomous AI agent named Jojo.
Analyze the following web research about "${topic}" and extract structured knowledge.

Research content (may contain HTML artifacts — ignore them):
${rawContent.slice(0, 7000)}

Respond ONLY with valid JSON, no markdown fences, no extra text:
{
  "summary": "3-5 sentence clear overview of the topic",
  "key_facts": ["concrete fact 1", "concrete fact 2", "fact 3", "fact 4", "fact 5"],
  "confidence": "LOW or MEDIUM or HIGH",
  "related_topics": ["related topic 1", "related topic 2", "related topic 3"],
  "skill_level": "beginner or intermediate or advanced"
}`;
    return this._generate(prompt);
  }

  // ── Grade a past response for quality ─────────────────────────────────────

  async gradeResponse(question, response) {
    const prompt = `You are a quality evaluator for an AI assistant named Jojo.
Grade this response critically and honestly.

Question asked: ${question}
Response given: ${response.slice(0, 3000)}

Respond ONLY with valid JSON, no markdown fences:
{
  "score": <integer 1-10>,
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "corrections": ["specific factual correction if wrong, else empty array"],
  "lessons": ["actionable lesson to remember 1", "lesson 2"]
}`;
    return this._generate(prompt);
  }

  // ── Generate a practice problem ───────────────────────────────────────────

  async generateProblem(skill, level = 1) {
    const prompt = `Generate a concrete practice problem for the skill: "${skill}" at difficulty level ${level} out of 5.
Level 1 = beginner/easy, level 5 = expert/hard.

Respond ONLY with valid JSON, no markdown fences:
{
  "problem": "Clear, specific problem statement with enough detail to attempt",
  "context": "Background info needed (can be empty string)",
  "hints": ["hint 1 (vague)", "hint 2 (more specific)"],
  "evaluation_criteria": ["criterion 1", "criterion 2", "criterion 3"]
}`;
    return this._generate(prompt);
  }

  // ── Evaluate a practice attempt ───────────────────────────────────────────

  async evaluatePractice(problem, attempt, criteria) {
    const prompt = `Evaluate this practice attempt for an AI learning system.

Problem: ${problem}
Attempt/Solution given: ${attempt.slice(0, 3000)}
Evaluation criteria: ${(criteria || []).join('; ')}

Be fair but critical. Respond ONLY with valid JSON, no markdown fences:
{
  "score": <integer 1-10>,
  "passed": <true if score >= 6>,
  "feedback": "2-3 sentence detailed feedback",
  "improvements": ["specific improvement 1", "specific improvement 2"],
  "new_level": <suggest new skill level 1-5 based on performance>
}`;
    return this._generate(prompt);
  }

  // ── Pick the most valuable topic to explore next ──────────────────────────

  async pickCuriosity(hint) {
    const known  = Object.keys(this.memory.data.knowledge || {});
    const skills = Object.keys(this.memory.data.skills_practiced || {});
    const facts  = (this.memory.data.facts || []).slice(-20).join('\n');

    const prompt = `Jojo is an autonomous AI agent choosing what to learn next to maximize its usefulness.

Topics already studied: ${known.join(', ') || 'none yet'}
Skills already practiced: ${skills.join(', ') || 'none'}
Recent memory context:\n${facts || '(empty)'}
${hint ? `User-suggested theme: ${hint}` : ''}

Pick ONE specific topic to research that fills an important gap or extends existing knowledge in a useful direction.

Respond ONLY with valid JSON, no markdown fences:
{
  "topic": "specific focused topic (not too broad)",
  "reason": "why this fills a valuable gap right now",
  "search_queries": ["search query 1", "search query 2", "search query 3"]
}`;
    return this._generate(prompt);
  }

  // ── Context block injected into the agent system prompt ───────────────────
  // Keep it under ~600 tokens; summarize, don't dump everything.

  getContext() {
    const knowledge = this.memory.data.knowledge        || {};
    const skills    = this.memory.data.skills_practiced || {};
    const log       = (this.memory.data.learning_log    || []).slice(-5);
    const evals     = (this.memory.data.self_eval_history || []);

    let out = '';

    // Knowledge base summary
    const topics = Object.keys(knowledge);
    if (topics.length) {
      out += `### Learned Topics (${topics.length})\n`;
      out += topics.map(t => {
        const k = knowledge[t];
        const age = Math.floor((Date.now() - new Date(k.learned_at).getTime()) / 86_400_000);
        return `- **${t}** [${k.confidence}/${k.skill_level}] (${age}d ago): ${(k.summary || '').slice(0, 90)}…`;
      }).join('\n');
    } else {
      out += '### Learned Topics\n(none yet — use learn_topic or explore_curiosity to start)';
    }

    // Skills
    const skillList = Object.keys(skills);
    if (skillList.length) {
      out += '\n\n### Practiced Skills\n';
      out += skillList.map(s => {
        const sk = skills[s];
        return `- **${s}**: level ${Number(sk.level || 1).toFixed(1)}/5, ${sk.sessions || 0} sessions`;
      }).join('\n');
    }

    // Rolling self-eval average
    if (evals.length >= 3) {
      const recent = evals.slice(-10);
      const avg    = recent.reduce((s, e) => s + e.score, 0) / recent.length;
      out += `\n\n### Self-Evaluation\nRolling quality score: ${avg.toFixed(1)}/10 (last ${recent.length} reviews)`;
    }

    // Recent sessions
    if (log.length) {
      out += '\n\n### Recent Learning Sessions\n';
      out += log.map(l =>
        `- ${l.topic} (${new Date(l.timestamp).toLocaleDateString()}, confidence: ${l.confidence})`
      ).join('\n');
    }

    return out;
  }
}

