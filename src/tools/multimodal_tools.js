/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║   J O J O  –  M U L T I M O D A L   E N G I N E                   ║
 * ║   8 tools · vision · audio · video · docs · cross-modal reasoning  ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Capabilities:
 *   vision_analyze   – Deep image analysis (objects, text, emotion, scene…)
 *   vision_compare   – Compare 2-4 images; find similarities / differences
 *   vision_extract   – OCR, table→JSON, chart→JSON, code, form, faces
 *   vision_qa        – Answer any question about an image
 *   vision_search    – Analyze image + live web search for real-world context
 *   audio_analyze    – Transcribe + analyze audio files
 *   doc_analyze      – Deep analysis of PDFs / scanned documents
 *   multimodal_reason– Cross-modal reasoning over ANY combo of media + text
 *
 * Media sources accepted everywhere: HTTPS URL  |  local file path
 *   – Images:  JPEG · PNG · WEBP · GIF · HEIC · HEIF
 *   – Audio:   WAV · MP3 · AIFF · AAC · OGG · FLAC
 *   – Video:   MP4 · MPEG · MOV · AVI · MKV · WEBM · 3GPP
 *   – Docs:    PDF · TXT
 */

import fs    from 'fs/promises';
import path  from 'path';
import axios from 'axios';
import { DEFAULT_MODEL } from '../core/puter_client.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const MIME = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
  webp:'image/webp', heic:'image/heic', heif:'image/heif',
  pdf:'application/pdf', txt:'text/plain',
  wav:'audio/wav', mp3:'audio/mpeg', aiff:'audio/aiff',
  aac:'audio/aac', ogg:'audio/ogg', flac:'audio/flac',
  mp4:'video/mp4', mpeg:'video/mpeg', mov:'video/quicktime',
  avi:'video/x-msvideo', mkv:'video/x-matroska',
  webm:'video/webm', '3gpp':'video/3gpp',
};

/** Load any URL or local path → Gemini inlineData part */
async function loadMedia(src) {
  if (!src) throw new Error('Media source (URL or path) required.');

  if (src.startsWith('http://') || src.startsWith('https://')) {
    const res = await axios.get(src, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxRedirects: 5,
      headers: { 'User-Agent': 'JojoMultimodal/4.0' },
    });
    const mimeType = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    return { inlineData: { data: Buffer.from(res.data).toString('base64'), mimeType } };
  }

  // Local file
  const buf      = await fs.readFile(src);
  const ext      = path.extname(src).slice(1).toLowerCase();
  const mimeType = MIME[ext] || 'application/octet-stream';
  return { inlineData: { data: buf.toString('base64'), mimeType } };
}

/** Load multiple sources in parallel */
async function loadAll(srcs) {
  return Promise.all((srcs || []).filter(Boolean).map(loadMedia));
}

/** Get a Gemini model instance from the context */
function getModel(context, config = {}) {
  const { genAI, geminiModel } = context;
  if (!genAI) throw new Error('genAI not found in context. Update agent.js to pass genAI.');
  return genAI.getGenerativeModel({
    model:            geminiModel || process.env.PUTER_MODEL || DEFAULT_MODEL,
    generationConfig: {
      temperature:     config.temperature ?? 0.1,
      maxOutputTokens: config.maxTokens   ?? 8192,
    },
  });
}

/** Single multimodal call → string */
async function mmCall(context, parts, config) {
  const model  = getModel(context, config);
  const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
  return result.response.text();
}

/** Minimal web search helper (reuses env keys from web.js) */
async function quickSearch(query) {
  try {
    if (process.env.BRAVE_API_KEY) {
      const r = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' },
        params:  { q: query, count: 5 },
        timeout: 10_000,
      });
      return (r.data?.web?.results || [])
        .map(h => `• ${h.title}\n  ${h.url}\n  ${h.description || ''}`)
        .join('\n\n');
    }
    if (process.env.SERPAPI_KEY) {
      const r = await axios.get('https://serpapi.com/search', {
        params: { q: query, api_key: process.env.SERPAPI_KEY, num: 5, engine: 'google' },
        timeout: 10_000,
      });
      return (r.data?.organic_results || [])
        .slice(0, 5)
        .map(h => `• ${h.title}\n  ${h.link}\n  ${h.snippet || ''}`)
        .join('\n\n');
    }
    return '(no search API configured — add BRAVE_API_KEY or SERPAPI_KEY to .env)';
  } catch (e) {
    return `(search error: ${e.message})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

export const MULTIMODAL_TOOLS = [

  // ══════════════════════════════════════════════════════════════════════════
  // 1.  VISION ANALYZE
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'vision_analyze',
    declaration: {
      name: 'vision_analyze',
      description:
        'Perform a DEEP analysis of an image. Returns: objects detected, ' +
        'people/faces, text found (OCR), dominant colors, scene type, ' +
        'estimated location/setting, emotional tone, composition notes, ' +
        'and any safety/quality flags. Works on photos, screenshots, artwork, diagrams.',
      parameters: {
        type: 'object',
        properties: {
          image_source: {
            type: 'string',
            description: 'HTTPS URL or local file path to the image.',
          },
          focus: {
            type: 'string',
            description:
              'Optional: narrow the analysis. ' +
              'E.g. "people", "text", "objects", "emotions", "brand", "safety", "technical".',
          },
          detail_level: {
            type: 'string',
            enum: ['brief', 'standard', 'exhaustive'],
            description: 'How much detail to return (default: standard).',
          },
        },
        required: ['image_source'],
      },
    },

    async execute({ image_source, focus, detail_level = 'standard' }, context) {
      const media = await loadMedia(image_source);

      const depthNote = {
        brief:     'Be concise — 3-5 sentences total.',
        standard:  'Be thorough but readable — use sections.',
        exhaustive:'Be extremely detailed. Miss nothing. Use well-structured markdown.',
      }[detail_level] || '';

      const focusNote = focus
        ? `Focus especially on: **${focus}**. Still note anything important outside that focus.`
        : '';

      const prompt = `Analyze this image comprehensively. ${focusNote} ${depthNote}

Return your analysis in this structure:
## Scene Overview
[What is this? What's happening? Setting/context?]

## Objects & Subjects
[List everything visible: objects, people, animals, text]

## Text Found (OCR)
[Any readable text in the image, exactly as written]

## Technical / Composition
[Colors, lighting, quality, perspective, any anomalies]

## Insights & Notable Details
[Anything surprising, useful, or worth flagging]`;

      const text = await mmCall(context, [{ text: prompt }, media]);
      return text;
    },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // 2.  VISION COMPARE
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'vision_compare',
    declaration: {
      name: 'vision_compare',
      description:
        'Compare 2-4 images side-by-side. Identifies similarities, differences, ' +
        'changes over time, quality differences, brand consistency, A/B variants, etc. ' +
        'Great for before/after, version comparison, product variants, chart evolution.',
      parameters: {
        type: 'object',
        properties: {
          image_sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of 2-4 image URLs or local paths.',
          },
          comparison_question: {
            type: 'string',
            description:
              'Optional specific question to answer. ' +
              'E.g. "Which design is more readable?", "What changed between versions?"',
          },
        },
        required: ['image_sources'],
      },
    },

    async execute({ image_sources, comparison_question }, context) {
      if (!Array.isArray(image_sources) || image_sources.length < 2) {
        return 'Error: provide at least 2 image sources.';
      }
      if (image_sources.length > 4) {
        return 'Error: maximum 4 images per comparison call.';
      }

      const mediaParts = await loadAll(image_sources);
      const labels = image_sources.map((_, i) => `Image ${i + 1}`).join(', ');

      const questionPart = comparison_question
        ? `\n\nMain question to answer: **${comparison_question}**`
        : '';

      const prompt = `You are comparing ${image_sources.length} images (${labels}).${questionPart}

Provide:
## What They Share
[Common elements, themes, subjects, style]

## Key Differences
[Be specific — layout, content, style, quality, text changes…]

## Image-by-Image Summary
[1-2 sentences describing each image uniquely]

## Conclusion
[Which is better / newer / more X — answer the main question directly if one was given]`;

      const text = await mmCall(context, [{ text: prompt }, ...mediaParts]);
      return text;
    },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // 3.  VISION EXTRACT
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'vision_extract',
    declaration: {
      name: 'vision_extract',
      description:
        'Extract structured data from an image. ' +
        'Modes: "text" (OCR), "table" (→ JSON rows), "chart" (→ JSON data + insights), ' +
        '"code" (extract source code from screenshot), "form" (→ JSON field:value), ' +
        '"faces" (describe people), "objects" (labelled list with positions), ' +
        '"markdown" (convert doc/slide to Markdown). Returns clean structured output.',
      parameters: {
        type: 'object',
        properties: {
          image_source: {
            type: 'string',
            description: 'Image URL or local path.',
          },
          extract_type: {
            type: 'string',
            enum: ['text', 'table', 'chart', 'code', 'form', 'faces', 'objects', 'markdown'],
            description: 'What to extract.',
          },
          language_hint: {
            type: 'string',
            description: 'For code extraction: programming language hint (e.g. "python", "typescript").',
          },
        },
        required: ['image_source', 'extract_type'],
      },
    },

    async execute({ image_source, extract_type, language_hint }, context) {
      const media = await loadMedia(image_source);

      const prompts = {
        text:
          'Extract ALL text from this image using OCR. ' +
          'Preserve formatting, line breaks, and structure exactly as they appear. ' +
          'Do not summarise — give the complete verbatim text.',

        table:
          'Extract every table from this image. ' +
          'Return ONLY valid JSON: an array of objects where each object is one row. ' +
          'Use the header row for keys. If multiple tables exist, return an array of arrays. ' +
          'No explanation — JSON only.',

        chart:
          'This image contains a chart or graph. Extract it fully. ' +
          'Return JSON with this shape: ' +
          '{ "chart_type": "...", "title": "...", "x_axis": "...", "y_axis": "...", ' +
          '"series": [{ "name": "...", "data": [[label, value], ...] }], ' +
          '"key_insight": "..." } ' +
          'No explanation — JSON only.',

        code:
          `Extract all source code from this screenshot. ` +
          `Language: ${language_hint || 'auto-detect'}. ` +
          `Return ONLY the code block with correct syntax highlighting. ` +
          `Reconstruct incomplete lines to the best of your ability.`,

        form:
          'This image shows a form (filled or empty). ' +
          'Extract all field labels and their values as JSON: { "field": "value", ... }. ' +
          'For checkboxes/radio buttons indicate checked state. ' +
          'No explanation — JSON only.',

        faces:
          'Describe every person visible in this image. ' +
          'For each person, note: apparent age range, gender expression, ' +
          'visible emotion, what they are doing, clothing, and position in frame. ' +
          'Do NOT name real people. Be respectful and factual.',

        objects:
          'List every distinct object in this image. ' +
          'Return JSON: { "objects": [ { "label": "...", "confidence": 0-1, ' +
          '"position": "top-left|center|etc.", "notes": "..." } ] } ' +
          'Include everything visible, however small.',

        markdown:
          'Convert this document / slide / screenshot to clean Markdown. ' +
          'Preserve headings, bullet points, bold, italic, tables, and code blocks. ' +
          'Return ONLY the Markdown — no preamble.',
      };

      const prompt = prompts[extract_type] || `Extract ${extract_type} from this image.`;
      const text   = await mmCall(context, [{ text: prompt }, media], { temperature: 0.05 });
      return text;
    },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // 4.  VISION Q&A
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'vision_qa',
    declaration: {
      name: 'vision_qa',
      description:
        'Answer any specific question about one or more images. ' +
        'Better than vision_analyze when you have a precise question. ' +
        'E.g. "Is there a fire exit visible?", "What version of the app is shown?", ' +
        '"Does this X-ray show any anomalies?", "Which product is more premium?"',
      parameters: {
        type: 'object',
        properties: {
          image_sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'One or more image URLs / local paths.',
          },
          question: {
            type: 'string',
            description: 'The question to answer about the image(s).',
          },
          answer_style: {
            type: 'string',
            enum: ['direct', 'detailed', 'yes_no', 'list'],
            description: 'How to format the answer (default: direct).',
          },
        },
        required: ['image_sources', 'question'],
      },
    },

    async execute({ image_sources, question, answer_style = 'direct' }, context) {
      const sources  = Array.isArray(image_sources) ? image_sources : [image_sources];
      const mediaParts = await loadAll(sources);

      const styleNote = {
        direct:   'Answer directly and concisely.',
        detailed: 'Explain thoroughly with evidence from the image.',
        yes_no:   'Start with YES or NO, then briefly explain why.',
        list:     'Return your answer as a numbered or bulleted list.',
      }[answer_style] || '';

      const prompt =
        `Question: ${question}\n\n` +
        styleNote + '\n\n' +
        'Base your answer only on what is actually visible in the image(s). ' +
        'If you cannot determine the answer, say so clearly.';

      const text = await mmCall(context, [{ text: prompt }, ...mediaParts]);
      return text;
    },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // 5.  VISION + SEARCH  (unique cross-modal capability)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'vision_search',
    declaration: {
      name: 'vision_search',
      description:
        'UNIQUE TOOL: Analyze an image AND search the web to provide real-world context. ' +
        'First identifies what is in the image, then searches for up-to-date information ' +
        'about it. Perfect for: identifying products/brands, getting prices, finding ' +
        'documentation for UI screenshots, researching locations, checking news about events.',
      parameters: {
        type: 'object',
        properties: {
          image_source: {
            type: 'string',
            description: 'Image URL or local path.',
          },
          search_intent: {
            type: 'string',
            description:
              'What to search for after identification. ' +
              'E.g. "price and reviews", "documentation", "news", "history", "how to use".',
          },
          custom_search_query: {
            type: 'string',
            description: 'Override the auto-generated search query with a custom one.',
          },
        },
        required: ['image_source'],
      },
    },

    async execute({ image_source, search_intent, custom_search_query }, context) {
      const media = await loadMedia(image_source);

      // Step 1 – identify what's in the image
      const identPrompt =
        'In 2-3 sentences, identify exactly what this image shows. ' +
        'Be specific: brand names, product models, location names, software names, ' +
        'person descriptions, event names — whatever is most identifiable. ' +
        'Also suggest the single best search query to find more information about it.';

      const identification = await mmCall(context, [{ text: identPrompt }, media]);

      // Step 2 – build the search query
      let searchQuery;
      if (custom_search_query) {
        searchQuery = custom_search_query;
      } else {
        // Extract the suggested query from the identification
        const queryMatch = identification.match(/search query[:\s]+["']?(.+?)["']?$/im);
        searchQuery      = queryMatch
          ? queryMatch[1].trim()
          : identification.split('\n')[0].slice(0, 100);
        if (search_intent) searchQuery += ` ${search_intent}`;
      }

      // Step 3 – web search
      const searchResults = await quickSearch(searchQuery);

      // Step 4 – synthesise
      const synthPrompt =
        `You analyzed an image and found:\n${identification}\n\n` +
        `You searched for: "${searchQuery}"\n\n` +
        `Search results:\n${searchResults}\n\n` +
        `Now provide a comprehensive answer that combines:\n` +
        `1. What you saw in the image\n` +
        `2. What the web says about it\n` +
        `3. Any ${search_intent || 'relevant'} information the user would want to know\n\n` +
        `Be specific, cite sources where helpful, and be honest about uncertainty.`;

      const synthesis = await mmCall(context, [{ text: synthPrompt }], { temperature: 0.3 });

      return `## Image Identification\n${identification}\n\n## Web Research (query: "${searchQuery}")\n${synthesis}`;
    },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // 6.  AUDIO ANALYZE
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'audio_analyze',
    declaration: {
      name: 'audio_analyze',
      description:
        'Transcribe and deeply analyze an audio file. ' +
        'Returns: full transcript (with speaker labels if multiple speakers), ' +
        'language detected, key topics, summary, sentiment, action items, quotes. ' +
        'Supports: WAV, MP3, AIFF, AAC, OGG, FLAC. URL or local path.',
      parameters: {
        type: 'object',
        properties: {
          audio_source: {
            type: 'string',
            description: 'Audio file URL or local path.',
          },
          task: {
            type: 'string',
            enum: ['transcribe', 'summarize', 'analyze', 'extract_actions', 'full'],
            description:
              'What to do with the audio. ' +
              '"transcribe" = verbatim text only, ' +
              '"summarize" = brief summary, ' +
              '"analyze" = full analysis, ' +
              '"extract_actions" = action items / decisions only, ' +
              '"full" = everything (default).',
          },
          speaker_count: {
            type: 'number',
            description: 'Expected number of speakers (optional, helps accuracy).',
          },
        },
        required: ['audio_source'],
      },
    },

    async execute({ audio_source, task = 'full', speaker_count }, context) {
      const media = await loadMedia(audio_source);

      const prompts = {
        transcribe:
          'Transcribe this audio verbatim. ' +
          (speaker_count > 1 ? `Label speakers as Speaker 1, Speaker 2, etc. (${speaker_count} total). ` : '') +
          'Include timestamps every 30 seconds in [MM:SS] format. ' +
          'Mark inaudible sections as [inaudible]. Return only the transcript.',

        summarize:
          'Listen to this audio and give a concise 3-5 sentence summary of its content.',

        analyze:
          'Analyze this audio and provide:\n' +
          '## Language & Quality\n[Detected language, audio quality, speaker info]\n\n' +
          '## Key Topics\n[Main subjects discussed]\n\n' +
          '## Notable Quotes\n[Most important statements]\n\n' +
          '## Overall Sentiment\n[Tone, mood, emotional content]',

        extract_actions:
          'Listen to this audio. Extract ONLY:\n' +
          '- Action items (who needs to do what)\n' +
          '- Decisions made\n' +
          '- Deadlines or dates mentioned\n' +
          'Return as a clean bulleted list. Skip everything else.',

        full:
          `${speaker_count ? `Expected speakers: ${speaker_count}. ` : ''}` +
          'Provide a complete audio analysis:\n\n' +
          '## Full Transcript\n[Verbatim with speaker labels and [MM:SS] timestamps]\n\n' +
          '## Summary\n[3-5 sentence overview]\n\n' +
          '## Language & Audio Quality\n[Language detected, clarity, background noise]\n\n' +
          '## Key Topics & Insights\n[Main themes and important points]\n\n' +
          '## Action Items & Decisions\n[Anything requiring follow-up]\n\n' +
          '## Sentiment\n[Overall tone and emotional content]',
      };

      return mmCall(context, [{ text: prompts[task] || prompts.full }, media]);
    },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // 7.  DOCUMENT ANALYZE
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'doc_analyze',
    declaration: {
      name: 'doc_analyze',
      description:
        'Deep analysis of a document — PDF, scanned page, screenshot of text, slide. ' +
        'Extracts structure, content, metadata, tables, figures, and provides insights. ' +
        'Far better than plain text extraction for complex/formatted documents.',
      parameters: {
        type: 'object',
        properties: {
          doc_source: {
            type: 'string',
            description: 'Document URL (PDF or image) or local path.',
          },
          task: {
            type: 'string',
            enum: ['extract', 'summarize', 'structure', 'review', 'translate', 'full'],
            description:
              '"extract" = all text + tables, ' +
              '"summarize" = concise summary, ' +
              '"structure" = outline/TOC, ' +
              '"review" = critique/feedback, ' +
              '"translate" = translate to English, ' +
              '"full" = complete analysis (default).',
          },
          target_language: {
            type: 'string',
            description: 'For "translate" task: target language (default: English).',
          },
          focus_section: {
            type: 'string',
            description: 'Focus on a specific section, page, or topic within the doc.',
          },
        },
        required: ['doc_source'],
      },
    },

    async execute({ doc_source, task = 'full', target_language = 'English', focus_section }, context) {
      const media = await loadMedia(doc_source);
      const focus = focus_section ? `\nFocus especially on: "${focus_section}".` : '';

      const prompts = {
        extract:
          `Extract ALL content from this document verbatim.${focus}\n` +
          'Include: all text, table data (as Markdown tables), list items, headers, footnotes. ' +
          'Preserve document structure with headings. Return clean Markdown.',

        summarize:
          `Provide a concise summary (200-300 words) of this document.${focus}\n` +
          'Cover: main purpose, key points, conclusions, and any important numbers/dates.',

        structure:
          `Map the complete structure of this document.${focus}\n` +
          'Return a hierarchical outline with page/section numbers. ' +
          'Note: sections, subsections, figures, tables, appendices.',

        review:
          `Review this document as an expert editor.${focus}\n` +
          'Assess: clarity, completeness, logical flow, factual concerns, ' +
          'formatting issues, missing information, and overall quality. ' +
          'Give a score out of 10 and specific recommendations.',

        translate:
          `Translate this entire document to ${target_language}.${focus}\n` +
          'Preserve the original formatting and structure. Return clean Markdown.',

        full:
          `Perform a comprehensive document analysis.${focus}\n\n` +
          '## Document Overview\n[Type, purpose, estimated length]\n\n' +
          '## Content Summary\n[Key points in 5-8 bullets]\n\n' +
          '## Structure & Sections\n[Document outline]\n\n' +
          '## Extracted Data\n[All tables, numbers, dates, names]\n\n' +
          '## Language & Quality\n[Clarity, tone, any issues]\n\n' +
          '## Key Insights\n[Most important takeaways]',
      };

      return mmCall(context, [{ text: prompts[task] || prompts.full }, media]);
    },
  },


  // ══════════════════════════════════════════════════════════════════════════
  // 8.  CROSS-MODAL REASONING  (the crown jewel)
  // ══════════════════════════════════════════════════════════════════════════
  {
    name: 'multimodal_reason',
    declaration: {
      name: 'multimodal_reason',
      description:
        'MOST POWERFUL TOOL: Reason across ANY combination of images, audio, documents, ' +
        'and text together. Jojo can hold all media in context simultaneously and answer ' +
        'complex questions that span multiple modalities. ' +
        'Examples: "Compare this image with that audio transcript", ' +
        '"Does this product photo match the spec PDF?", ' +
        '"Analyse this meeting audio alongside the slide deck shown", ' +
        '"What is inconsistent between these 3 screenshots and the requirements doc?"',
      parameters: {
        type: 'object',
        properties: {
          media_sources: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source:  { type: 'string', description: 'URL or local path.' },
                label:   { type: 'string', description: 'Human label, e.g. "Requirements PDF".' },
              },
            },
            description: 'Array of { source, label } objects (images, audio, PDFs, up to 8).',
          },
          text_context: {
            type: 'string',
            description: 'Optional additional text context to include in the reasoning.',
          },
          question: {
            type: 'string',
            description: 'The cross-modal question or task to perform.',
          },
          output_format: {
            type: 'string',
            enum: ['prose', 'bullet_points', 'json', 'table', 'comparison_matrix'],
            description: 'How to structure the response (default: prose).',
          },
        },
        required: ['media_sources', 'question'],
      },
    },

    async execute({ media_sources, text_context, question, output_format = 'prose' }, context) {
      if (!Array.isArray(media_sources) || media_sources.length === 0) {
        return 'Error: provide at least one media source.';
      }
      if (media_sources.length > 8) {
        return 'Error: maximum 8 media items per reasoning call.';
      }

      // Load all media in parallel
      const loaded = await loadAll(media_sources.map(m => m.source));

      // Build label list for the prompt
      const mediaDesc = media_sources
        .map((m, i) => `  [${i + 1}] ${m.label || `Media ${i + 1}`} (${m.source.split('/').pop()})`)
        .join('\n');

      const formatNote = {
        prose:             'Write flowing analytical prose.',
        bullet_points:     'Use clear bullet points and sub-bullets.',
        json:              'Return ONLY valid JSON — no prose.',
        table:             'Format your answer as a Markdown table.',
        comparison_matrix: 'Format as a side-by-side comparison matrix table.',
      }[output_format] || '';

      const textCtxNote = text_context
        ? `\n\nAdditional context provided:\n"""\n${text_context}\n"""`
        : '';

      const systemPart = {
        text:
          `You are performing cross-modal reasoning over ${media_sources.length} media item(s):\n${mediaDesc}${textCtxNote}\n\n` +
          `Question / Task: ${question}\n\n` +
          `${formatNote}\n\n` +
          `Analyse all provided media holistically. Reference specific media items by their labels. ` +
          `Draw connections across modalities. Be precise, evidence-based, and insightful.`,
      };

      const text = await mmCall(
        context,
        [systemPart, ...loaded],
        { temperature: 0.2, maxTokens: 8192 }
      );
      return text;
    },
  },

];

