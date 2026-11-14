import axios from 'axios';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0';

// ── Provider implementations ──────────────────────────────────────────────────

async function braveSearch(query, n) {
  const res = await axios.get('https://api.search.brave.com/res/v1/web/search', {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_API_KEY },
    params:  { q: query, count: n },
    timeout: 10_000,
  });
  const hits = res.data?.web?.results || [];
  if (!hits.length) return 'No results.';
  return hits.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || ''}`
  ).join('\n\n');
}

async function serpSearch(query, n) {
  const res = await axios.get('https://serpapi.com/search', {
    params:  { q: query, api_key: process.env.SERPAPI_KEY, num: n, engine: 'google' },
    timeout: 10_000,
  });
  const hits = (res.data?.organic_results || []).slice(0, n);
  if (!hits.length) return 'No results.';
  return hits.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet || ''}`
  ).join('\n\n');
}

async function ddgFallback(query) {
  // DuckDuckGo Instant Answer API — limited but zero-config
  const res = await axios.get('https://api.duckduckgo.com/', {
    params:  { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
    timeout: 8_000,
  });
  const d = res.data;
  let out  = '';
  if (d.AbstractText) out += `${d.AbstractText}\nSource: ${d.AbstractURL}\n\n`;
  if (d.RelatedTopics?.length) {
    out += 'Related:\n';
    d.RelatedTopics.slice(0, 5).forEach((t, i) => { if (t.Text) out += `${i + 1}. ${t.Text}\n`; });
  }
  if (!out.trim()) out = 'No instant-answer results. Add BRAVE_API_KEY or SERPAPI_KEY to .env for full search.';
  return out.trim();
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const WEB_TOOLS = [

  // ── web_search ───────────────────────────────────────────────────────────────
  {
    name: 'web_search',
    declaration: {
      name: 'web_search',
      description:
        'Search the web. Returns titles, URLs, and snippets. ' +
        'Use for: current events, research, factual lookups, finding documentation.',
      parameters: {
        type: 'object',
        properties: {
          query:       { type: 'string', description: 'Search query' },
          num_results: { type: 'number', description: 'Results to return (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
    async execute({ query, num_results = 5 }) {
      const n = Math.min(num_results, 10);
      try {
        if (process.env.BRAVE_API_KEY) return await braveSearch(query, n);
        if (process.env.SERPAPI_KEY)   return await serpSearch(query, n);
        return await ddgFallback(query);
      } catch (err) {
        return `Search error: ${err.message}`;
      }
    },
  },

  // ── web_fetch ────────────────────────────────────────────────────────────────
  {
    name: 'web_fetch',
    declaration: {
      name: 'web_fetch',
      description:
        'Fetch the text content of any URL. ' +
        'Strips HTML tags. Useful for reading articles, docs, APIs, or any webpage.',
      parameters: {
        type: 'object',
        properties: {
          url:        { type: 'string', description: 'URL to fetch' },
          max_length: { type: 'number', description: 'Max characters to return (default 5000)' },
        },
        required: ['url'],
      },
    },
    async execute({ url, max_length = 5000 }) {
      try {
        const res = await axios.get(url, {
          headers:      { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
          timeout:      15_000,
          maxRedirects: 5,
          responseType: 'text',
        });

        let text = String(res.data)
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (text.length > max_length) {
          text = text.slice(0, max_length) +
            `\n\n[Truncated — ${max_length}/${text.length} chars returned]`;
        }
        return text || '(empty page)';
      } catch (err) {
        return `Fetch error: ${err.message}`;
      }
    },
  },
];

