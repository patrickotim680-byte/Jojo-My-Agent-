// Memory tools let the agent manage its own persistent memory.
// The `context.memory` and `context.vectorMemory` references are injected
// by ToolRegistry.execute().

export const MEMORY_TOOLS = [

  // ── Classic keyword memory (unchanged) ────────────────────────────────────

  {
    name: 'remember',
    declaration: {
      name: 'remember',
      description:
        'Save a fact or piece of information to persistent memory. ' +
        'This survives across conversations. Use liberally for anything useful to recall later. ' +
        'For richer semantic recall, prefer vector_remember.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The fact or note to save' },
        },
        required: ['fact'],
      },
    },
    async execute({ fact }, { memory }) {
      return memory ? memory.remember(fact) : 'Memory system unavailable.';
    },
  },

  {
    name: 'recall',
    declaration: {
      name: 'recall',
      description:
        'Keyword-search persistent memory. ' +
        'For meaning-based search use vector_recall instead.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term to look up in memory' },
        },
        required: ['query'],
      },
    },
    execute({ query }, { memory }) {
      return memory ? memory.recall(query) : 'Memory system unavailable.';
    },
  },

  {
    name: 'forget',
    declaration: {
      name: 'forget',
      description:
        'Remove a stored fact from persistent memory by its index number (1-based). ' +
        'Use recall first to find the index.',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '1-based index of the memory to delete' },
        },
        required: ['index'],
      },
    },
    async execute({ index }, { memory }) {
      return memory ? memory.forget(index) : 'Memory system unavailable.';
    },
  },

  // ── Vector memory ──────────────────────────────────────────────────────────

  {
    name: 'vector_remember',
    declaration: {
      name: 'vector_remember',
      description:
        'Store any information with a semantic embedding for intelligent recall later. ' +
        'Much better than remember() for complex facts because search finds by meaning. ' +
        'Use category="creator" for ANYTHING about the person who built or uses Jojo — ' +
        'their name, preferences, projects, background, instructions, personality. ' +
        'Use "knowledge" for researched facts, "entity" for named people/places/things, ' +
        '"conversation" for notable exchanges, "general" for everything else.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The information to store',
          },
          category: {
            type: 'string',
            enum: ['creator', 'general', 'knowledge', 'entity', 'conversation'],
            description:
              'Category for organisation. Always use "creator" for facts about ' +
              'the user / creator of Jojo.',
          },
          metadata: {
            type: 'object',
            description: 'Optional extra fields (source, topic, confidence, etc.)',
          },
        },
        required: ['text'],
      },
    },
    async execute({ text, category = 'general', metadata = {} }, { vectorMemory }) {
      if (!vectorMemory) return 'Vector memory unavailable.';
      const id = await vectorMemory.store(text, category, metadata);
      const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
      return `✅ Stored in vector memory [${category}]: "${preview}" (id: ${id})`;
    },
  },

  {
    name: 'vector_recall',
    declaration: {
      name: 'vector_recall',
      description:
        'Semantically search vector memory by meaning — finds the most relevant stored ' +
        'memories even when the exact words differ. ' +
        'Use category="creator" to search only what Jojo knows about its creator/user. ' +
        'Use category="all" (or omit) for a global search.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What you want to find — phrase it naturally',
          },
          top_k: {
            type: 'number',
            description: 'Number of results to return (default 5, max 20)',
          },
          category: {
            type: 'string',
            enum: ['creator', 'general', 'knowledge', 'entity', 'conversation', 'all'],
            description: 'Filter by category; omit or "all" for global search',
          },
          min_score: {
            type: 'number',
            description:
              'Minimum similarity threshold 0–1 (default 0.3). ' +
              'Lower = broader results, higher = stricter relevance.',
          },
        },
        required: ['query'],
      },
    },
    async execute({ query, top_k = 5, category, min_score = 0.3 }, { vectorMemory }) {
      if (!vectorMemory) return 'Vector memory unavailable.';

      const cat     = (!category || category === 'all') ? null : category;
      const topK    = Math.min(Number(top_k) || 5, 20);
      const results = await vectorMemory.search(query, {
        topK,
        category:  cat,
        minScore:  Number(min_score) || 0.3,
      });

      if (!results.length) {
        return `No semantically similar memories found for "${query}"` +
               (cat ? ` in category "${cat}"` : '') + '.';
      }

      const lines = results.map((r, i) => {
        const pct  = (r.score * 100).toFixed(1);
        const ago  = _relativeTime(r.timestamp);
        return `${i + 1}. [${r.category}] ${pct}% match  (${ago})\n   ${r.text}`;
      });

      return lines.join('\n\n');
    },
  },

];

// ── helpers ───────────────────────────────────────────────────────────────────

function _relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

