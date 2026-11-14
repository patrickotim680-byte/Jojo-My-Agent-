// ── Learning Tools ────────────────────────────────────────────────────────────
// Four tools that give Jojo autonomous self-learning capabilities:
//
//  learn_topic       — Research any subject: web search → fetch → synthesize → store
//  self_review       — Grade own past responses; commit corrections to memory
//  practice_skill    — Generate problem → solve → evaluate → track skill level 1-5
//  explore_curiosity — Jojo autonomously picks what to learn next (no user prompt needed)
//
// All tools persist results to memory, making every session incrementally smarter.
// Context carries { memory, learning } injected by the agent.

import axios from 'axios';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0';

// ── Internal web helpers (self-contained; no dependency on web.js) ─────────────

async function quickSearch(query, n = 5) {
  try {
    if (process.env.BRAVE_API_KEY) {
      const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        headers: { Accept: 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
        params:  { q: query, count: n },
        timeout: 10_000,
      });
      return (res.data?.web?.results || []).slice(0, n).map(r => ({
        title: r.title, url: r.url, snippet: r.description || '',
      }));
    }
    if (process.env.SERPAPI_KEY) {
      const res = await axios.get('https://serpapi.com/search', {
        params: { q: query, api_key: process.env.SERPAPI_KEY, num: n, engine: 'google' },
        timeout: 10_000,
      });
      return (res.data?.organic_results || []).slice(0, n).map(r => ({
        title: r.title, url: r.link, snippet: r.snippet || '',
      }));
    }
    // DuckDuckGo instant-answer fallback (limited but zero-config)
    const res = await axios.get('https://api.duckduckgo.com/', {
      params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 8_000,
    });
    const d = res.data;
    const results = [];
    if (d.AbstractText) results.push({ title: d.Heading, url: d.AbstractURL, snippet: d.AbstractText });
    (d.RelatedTopics || []).slice(0, n - 1).forEach(t => {
      if (t.Text) results.push({ title: t.Text.slice(0, 60), url: t.FirstURL || '', snippet: t.Text });
    });
    return results;
  } catch { return []; }
}

async function quickFetch(url, maxLen = 3000) {
  try {
    const res = await axios.get(url, {
      headers:      { 'User-Agent': UA, Accept: 'text/html,*/*' },
      timeout:      12_000,
      maxRedirects: 5,
      responseType: 'text',
    });
    const text = String(res.data)
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return text.slice(0, maxLen);
  } catch (e) {
    return `[fetch error: ${e.message}]`;
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const LEARNING_TOOLS = [

  // ── learn_topic ─────────────────────────────────────────────────────────────
  {
    name: 'learn_topic',
    declaration: {
      name: 'learn_topic',
      description:
        'Autonomously research and deeply learn a topic. ' +
        'Searches the web from multiple angles, reads source pages, synthesizes with AI, ' +
        'and stores structured knowledge + key facts to long-term memory. ' +
        'Use when asked to learn, research, study, or understand something in depth.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Specific topic to research and learn',
          },
          depth: {
            type: 'string',
            enum: ['quick', 'normal', 'deep'],
            description: 'Research depth — quick (1 source), normal (2-3), deep (4-5). Default: normal',
          },
          force: {
            type: 'boolean',
            description: 'Re-learn even if already known. Default: false',
          },
        },
        required: ['topic'],
      },
    },

    async execute({ topic, depth = 'normal', force = false }, { memory, learning }) {
      if (!learning) return 'Learning system unavailable.';

      // Check if already known and fresh (< 7 days)
      const existing = (memory.data.knowledge || {})[topic];
      if (existing && !force) {
        const ageMs  = Date.now() - new Date(existing.learned_at).getTime();
        const ageDays = Math.floor(ageMs / 86_400_000);
        if (ageMs < 7 * 86_400_000) {
          return [
            `📚 Already know "${topic}" (learned ${ageDays}d ago, confidence: ${existing.confidence})`,
            `Summary: ${existing.summary}`,
            `Key facts: ${(existing.key_facts || []).slice(0, 3).join(' | ')}`,
            `Use force=true to refresh.`,
          ].join('\n');
        }
      }

      const numSearches = depth === 'quick' ? 1 : depth === 'deep' ? 4 : 2;
      const numFetches  = depth === 'quick' ? 1 : depth === 'deep' ? 4 : 2;

      // Multi-angle queries for better coverage
      const queries = [
        topic,
        `${topic} explained comprehensively`,
        depth !== 'quick' ? `${topic} key concepts advanced` : null,
        depth === 'deep'  ? `${topic} latest developments 2025` : null,
        depth === 'deep'  ? `how does ${topic} work in practice` : null,
      ].filter(Boolean).slice(0, numSearches + 1);

      // Search
      let snippetBlock = '';
      const urlSet = new Set();
      for (const q of queries) {
        const results = await quickSearch(q, 4);
        for (const r of results) {
          snippetBlock += `\n[${r.title}]\n${r.snippet}\n`;
          if (r.url && r.url.startsWith('http')) urlSet.add(r.url);
        }
      }

      // Fetch pages
      let pageBlock = '';
      let fetched   = 0;
      for (const url of [...urlSet]) {
        if (fetched >= numFetches) break;
        const content = await quickFetch(url, 2800);
        if (!content.startsWith('[fetch error')) {
          pageBlock += `\n\n=== ${url} ===\n${content}`;
          fetched++;
        }
      }

      if (!snippetBlock.trim() && !pageBlock.trim()) {
        return `No web content retrieved for "${topic}". Check search API keys in .env`;
      }

      // Synthesize with LearningSystem
      let synthesis;
      try {
        synthesis = await learning.synthesize(topic, snippetBlock + pageBlock);
      } catch (err) {
        return `Synthesis failed: ${err.message}. (Snippets collected but not stored.)`;
      }

      // Persist to knowledge base
      if (!memory.data.knowledge) memory.data.knowledge = {};
      memory.data.knowledge[topic] = {
        summary:     synthesis.summary,
        key_facts:   synthesis.key_facts   || [],
        confidence:  synthesis.confidence  || 'MEDIUM',
        related:     synthesis.related_topics || [],
        skill_level: synthesis.skill_level || 'intermediate',
        sources:     [...urlSet].slice(0, numFetches),
        learned_at:  new Date().toISOString(),
      };

      // Store top facts in persistent memory (searchable via recall)
      const factsToStore = (synthesis.key_facts || []).slice(0, 6);
      for (const fact of factsToStore) {
        await memory.remember(`[learned:${topic}] ${fact}`);
      }

      // Log session
      if (!memory.data.learning_log) memory.data.learning_log = [];
      memory.data.learning_log.push({
        topic,
        timestamp:    new Date().toISOString(),
        sources_used: fetched,
        facts_added:  factsToStore.length,
        confidence:   synthesis.confidence,
      });
      if (memory.data.learning_log.length > 200) {
        memory.data.learning_log = memory.data.learning_log.slice(-200);
      }

      await memory._save();

      const lines = [
        `✅ Learned: "${topic}" [${synthesis.confidence} confidence | ${synthesis.skill_level}]`,
        `📖 ${synthesis.summary}`,
        '',
        `💡 Key facts stored (${factsToStore.length}):`,
        ...factsToStore.map((f, i) => `  ${i + 1}. ${f}`),
        '',
        `🔗 Sources read: ${fetched}`,
      ];
      if (synthesis.related_topics?.length) {
        lines.push(`🗺  Related to explore: ${synthesis.related_topics.join(', ')}`);
      }
      return lines.join('\n');
    },
  },

  // ── self_review ──────────────────────────────────────────────────────────────
  {
    name: 'self_review',
    declaration: {
      name: 'self_review',
      description:
        'Self-evaluate a past response in this conversation. ' +
        'Grades quality 1-10, identifies mistakes and weaknesses, ' +
        'and commits corrections + lessons to persistent memory. ' +
        'Call after giving complex or uncertain answers to catch errors and improve.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question or task that was given' },
          response: { type: 'string', description: 'The response that was given' },
        },
        required: ['question', 'response'],
      },
    },

    async execute({ question, response }, { memory, learning }) {
      if (!learning) return 'Learning system unavailable.';

      let grade;
      try {
        grade = await learning.gradeResponse(question, response);
      } catch (err) {
        return `Self-review failed: ${err.message}`;
      }

      // Commit lessons and corrections to memory
      for (const lesson of (grade.lessons || [])) {
        await memory.remember(`[lesson] ${lesson}`);
      }
      for (const correction of (grade.corrections || [])) {
        await memory.remember(`[correction] ${correction}`);
      }

      // Track scores
      if (!memory.data.self_eval_history) memory.data.self_eval_history = [];
      memory.data.self_eval_history.push({
        score:     grade.score,
        timestamp: new Date().toISOString(),
      });
      if (memory.data.self_eval_history.length > 100) {
        memory.data.self_eval_history = memory.data.self_eval_history.slice(-100);
      }

      await memory._save();

      const recent  = memory.data.self_eval_history.slice(-10);
      const rolling = recent.reduce((s, e) => s + e.score, 0) / recent.length;

      return [
        `📊 Self-review: ${grade.score}/10 | Rolling avg (last ${recent.length}): ${rolling.toFixed(1)}/10`,
        grade.strengths?.length  ? `✅ Strengths:    ${grade.strengths.join(' | ')}`  : '',
        grade.weaknesses?.length ? `⚠️  Weaknesses:   ${grade.weaknesses.join(' | ')}` : '',
        grade.corrections?.length
          ? `🔧 Corrections stored: ${grade.corrections.length}` : '',
        grade.lessons?.length
          ? `📝 Lessons learned: ${grade.lessons.length}` : '',
      ].filter(Boolean).join('\n');
    },
  },

  // ── practice_skill ───────────────────────────────────────────────────────────
  {
    name: 'practice_skill',
    declaration: {
      name: 'practice_skill',
      description:
        'Practice a skill through deliberate problem → attempt → evaluation cycle. ' +
        'Tracks skill level from 1 (beginner) to 5 (expert) across sessions. ' +
        'Without an attempt: generates a problem at current level. ' +
        'With an attempt: evaluates it and updates skill level. ' +
        'Use to build and verify real competency through doing, not just reading.',
      parameters: {
        type: 'object',
        properties: {
          skill:   { type: 'string', description: 'Skill to practice (e.g. "Python async", "SQL joins", "writing clear explanations")' },
          attempt: { type: 'string', description: 'Your solution attempt (omit to get a new problem first)' },
        },
        required: ['skill'],
      },
    },

    async execute({ skill, attempt }, { memory, learning }) {
      if (!learning) return 'Learning system unavailable.';

      if (!memory.data.skills_practiced) memory.data.skills_practiced = {};
      const rec = memory.data.skills_practiced[skill] || {
        level:    1,
        sessions: 0,
        history:  [],
      };

      // ── Phase 1: Generate problem ─────────────────────────────────────────
      if (!attempt) {
        let prob;
        try {
          prob = await learning.generateProblem(skill, Math.round(rec.level));
        } catch (err) {
          return `Problem generation failed: ${err.message}`;
        }

        return [
          `🎯 Practice: ${skill} | Level ${rec.level.toFixed(1)}/5 | Session ${rec.sessions + 1}`,
          '',
          `📋 Problem:\n${prob.problem}`,
          prob.context ? `\n📚 Context:\n${prob.context}` : '',
          `\n💡 Hints: ${(prob.hints || []).join(' → ')}`,
          `\n✅ Will be evaluated on:\n${(prob.evaluation_criteria || []).map(c => `  • ${c}`).join('\n')}`,
          '',
          `Call practice_skill again with skill="${skill}" and your attempt= to get evaluated.`,
        ].filter(Boolean).join('\n');
      }

      // ── Phase 2: Evaluate attempt ─────────────────────────────────────────
      // Regenerate a representative problem at the current level for context
      let prob;
      try {
        prob = await learning.generateProblem(skill, Math.round(rec.level));
      } catch (err) {
        return `Could not load evaluation context: ${err.message}`;
      }

      let evaluation;
      try {
        evaluation = await learning.evaluatePractice(
          prob.problem,
          attempt,
          prob.evaluation_criteria || []
        );
      } catch (err) {
        return `Evaluation failed: ${err.message}`;
      }

      // Update skill record
      rec.sessions++;
      const prevLevel = rec.level;
      // Smooth level update: ±0.5 max per session toward evaluated new_level
      const targetLevel = Math.min(5, Math.max(1, evaluation.new_level || rec.level));
      rec.level = prevLevel + Math.sign(targetLevel - prevLevel) * Math.min(0.5, Math.abs(targetLevel - prevLevel));
      rec.history = [
        ...(rec.history || []).slice(-30),
        {
          timestamp:  new Date().toISOString(),
          score:      evaluation.score,
          passed:     evaluation.passed,
          level_from: prevLevel,
          level_to:   rec.level,
        },
      ];
      memory.data.skills_practiced[skill] = rec;

      // Store improvements in memory
      for (const imp of (evaluation.improvements || [])) {
        await memory.remember(`[practice:${skill}] ${imp}`);
      }

      await memory._save();

      const levelChange = rec.level > prevLevel ? `↑ ${rec.level.toFixed(1)}` :
                          rec.level < prevLevel ? `↓ ${rec.level.toFixed(1)}` :
                          `= ${rec.level.toFixed(1)}`;

      return [
        `📊 Practice result: ${skill}`,
        `Score: ${evaluation.score}/10 | ${evaluation.passed ? '✅ Passed' : '❌ Not yet'}`,
        `Skill level: ${levelChange}/5 after ${rec.sessions} total sessions`,
        '',
        `💬 Feedback: ${evaluation.feedback}`,
        evaluation.improvements?.length
          ? `\n🔧 Improvements to remember:\n${evaluation.improvements.map(i => `  • ${i}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');
    },
  },

  // ── explore_curiosity ────────────────────────────────────────────────────────
  {
    name: 'explore_curiosity',
    declaration: {
      name: 'explore_curiosity',
      description:
        'Jojo autonomously decides what to learn next based on its own knowledge gaps, ' +
        'recent context, and what would be most useful to know. ' +
        'Then immediately researches and learns that topic. ' +
        'Use when asked to "explore", "be curious", "learn something on your own", ' +
        '"expand your knowledge", or "surprise me with what you know".',
      parameters: {
        type: 'object',
        properties: {
          hint: {
            type: 'string',
            description: 'Optional domain or theme to guide curiosity (e.g. "AI", "science", "the user\'s projects")',
          },
        },
      },
    },

    async execute({ hint } = {}, { memory, learning }) {
      if (!learning) return 'Learning system unavailable.';

      // Let the engine pick the most valuable gap to fill
      let picked;
      try {
        picked = await learning.pickCuriosity(hint);
      } catch (err) {
        return `Curiosity engine failed: ${err.message}`;
      }

      // Now learn it (reuse learn_topic execute directly)
      const learnTool = LEARNING_TOOLS.find(t => t.name === 'learn_topic');
      const result    = await learnTool.execute(
        { topic: picked.topic, depth: 'normal' },
        { memory, learning }
      );

      return [
        `🧠 Curiosity-driven exploration`,
        `📌 Chosen topic: ${picked.topic}`,
        `💭 Why: ${picked.reason}`,
        '',
        result,
      ].join('\n');
    },
  },

];

