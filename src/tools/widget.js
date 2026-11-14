// ── Widget Tools ──────────────────────────────────────────────────────────────
// Give Jojo the ability to render visual output — charts, diagrams, dashboards,
// interactive UIs — exactly like Claude's show_widget capability.
//
// Tools:
//   show_widget   — render any HTML / SVG / interactive UI in the browser
//   show_chart    — render a Chart.js chart (bar, line, pie, doughnut, radar)
//   show_diagram  — render a Mermaid flowchart / sequence / gantt diagram
//   show_table    — render a styled data table from JSON rows
//   show_dashboard— open Jojo's live memory + knowledge dashboard

import fs   from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';

const OUTPUT_DIR = './output';

// ── helpers ───────────────────────────────────────────────────────────────────

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function writeAndOpen(filename, html) {
  await ensureOutputDir();
  const filepath = path.join(OUTPUT_DIR, filename);
  await fs.writeFile(filepath, html, 'utf-8');
  const resolved = path.resolve(filepath);

  // Node reports 'android' as its own platform value on Termux — it does NOT
  // fall under 'linux'. The generic xdg-open this used to fall back to
  // doesn't exist on Android; termux-open (from Termux:API) is the real
  // equivalent, launching the file in the device's default browser/app.
  const opener =
    process.platform === 'darwin'  ? 'open' :
    process.platform === 'win32'   ? 'start' :
    process.platform === 'android' ? 'termux-open' :
    'xdg-open';

  exec(`${opener} "${resolved}"`, (err) => {
    if (err && process.platform === 'android') {
      console.error(
        '[widget] termux-open failed — install Termux:API (`pkg install termux-api` + the ' +
        'Termux:API app) to auto-open widgets, or open the file manually:', resolved
      );
    }
  });

  return process.platform === 'android'
    ? `✅ Widget rendered → ${resolved}\n(opening via termux-open — install Termux:API if it doesn't pop up)`
    : `✅ Widget rendered → ${resolved}`;
}

function timestamp() {
  return Date.now().toString(36);
}

function baseHtml(title, bodyContent, extraHead = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:      #0f1117;
      --surface: #1a1d27;
      --border:  #2a2d3e;
      --accent:  #7c6af7;
      --text:    #e2e8f0;
      --muted:   #64748b;
      --green:   #34d399;
      --yellow:  #fbbf24;
      --red:     #f87171;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      min-height: 100vh;
      padding: 2rem;
    }
    h1, h2, h3 { color: var(--accent); margin-bottom: 1rem; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .badge {
      display: inline-block;
      background: var(--accent);
      color: #fff;
      border-radius: 20px;
      padding: 2px 10px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .muted { color: var(--muted); font-size: 0.85rem; }
  </style>
  ${extraHead}
</head>
<body>
  ${bodyContent}
</body>
</html>`;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const WIDGET_TOOLS = [

  // ── show_widget ─────────────────────────────────────────────────────────────
  {
    name: 'show_widget',
    declaration: {
      name: 'show_widget',
      description:
        'Render any visual content in the browser — interactive UIs, SVG diagrams, ' +
        'dashboards, forms, calculators, games, illustrations, data displays. ' +
        'Accepts raw HTML (with embedded CSS/JS) or a bare SVG string. ' +
        'Use whenever the user asks to "show", "visualize", "draw", "chart", "display", ' +
        '"build a UI", "make it visual", or whenever a visual would be clearer than text. ' +
        'This is the primary tool for all visual output.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Window / tab title for the rendered output',
          },
          content: {
            type: 'string',
            description:
              'Full HTML page content (or raw SVG starting with <svg). ' +
              'Include all CSS and JS inline. Use dark theme with --accent: #7c6af7.',
          },
          description: {
            type: 'string',
            description: 'One-line description of what this widget shows (logged to terminal)',
          },
        },
        required: ['title', 'content'],
      },
    },

    async execute({ title, content, description }) {
      const isSvg = content.trimStart().startsWith('<svg');
      const html  = isSvg
        ? baseHtml(title, `<div style="display:flex;justify-content:center;align-items:center;min-height:80vh">${content}</div>`)
        : content;
      const filename = `widget_${timestamp()}.html`;
      return writeAndOpen(filename, html);
    },
  },

  // ── show_chart ──────────────────────────────────────────────────────────────
  {
    name: 'show_chart',
    declaration: {
      name: 'show_chart',
      description:
        'Render a beautiful interactive chart using Chart.js. ' +
        'Supports bar, line, pie, doughnut, radar, and polarArea chart types. ' +
        'Use for data comparisons, trends, distributions, proportions. ' +
        'Pass labels and one or more datasets.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Chart title',
          },
          type: {
            type: 'string',
            enum: ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea'],
            description: 'Chart type (default: bar)',
          },
          labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'X-axis labels or slice labels',
          },
          datasets: {
            type: 'array',
            description: 'Array of { label, data[], color? } objects',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                data:  { type: 'array', items: { type: 'number' } },
                color: { type: 'string', description: 'Hex color (optional)' },
              },
              required: ['label', 'data'],
            },
          },
          x_label: { type: 'string', description: 'X-axis label (optional)' },
          y_label: { type: 'string', description: 'Y-axis label (optional)' },
        },
        required: ['title', 'labels', 'datasets'],
      },
    },

    async execute({ title, type = 'bar', labels, datasets, x_label, y_label }) {
      const palette = [
        '#7c6af7','#34d399','#fbbf24','#f87171','#60a5fa',
        '#a78bfa','#fb7185','#38bdf8','#4ade80','#facc15',
      ];
      const chartDatasets = datasets.map((ds, i) => {
        const color = ds.color || palette[i % palette.length];
        const isRound = ['pie','doughnut','polarArea'].includes(type);
        return {
          label:           ds.label,
          data:            ds.data,
          backgroundColor: isRound
            ? labels.map((_, j) => palette[j % palette.length] + 'cc')
            : color + '99',
          borderColor:     isRound ? labels.map((_, j) => palette[j % palette.length]) : color,
          borderWidth:     2,
          tension:         0.4,
          fill:            type === 'line',
          pointRadius:     type === 'line' ? 4 : 0,
        };
      });

      const scalesConfig = ['pie','doughnut','polarArea','radar'].includes(type) ? '' : `
        scales: {
          x: {
            grid: { color: '#2a2d3e' },
            ticks: { color: '#94a3b8' },
            ${x_label ? `title: { display: true, text: ${JSON.stringify(x_label)}, color: '#94a3b8' },` : ''}
          },
          y: {
            grid: { color: '#2a2d3e' },
            ticks: { color: '#94a3b8' },
            ${y_label ? `title: { display: true, text: ${JSON.stringify(y_label)}, color: '#94a3b8' },` : ''}
          },
        },`;

      const html = baseHtml(title,
        `<div class="card">
          <h2>${title}</h2>
          <div style="position:relative; height:420px; width:100%;">
            <canvas id="chart"></canvas>
          </div>
        </div>`,
        `<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
        <script>
          const ctx = document.getElementById('chart').getContext('2d');
          new Chart(ctx, {
            type: ${JSON.stringify(type)},
            data: {
              labels:   ${JSON.stringify(labels)},
              datasets: ${JSON.stringify(chartDatasets)},
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { labels: { color: '#e2e8f0' } },
              },
              ${scalesConfig}
            },
          });
        </script>`
      );

      return writeAndOpen(`chart_${timestamp()}.html`, html);
    },
  },

  // ── show_diagram ─────────────────────────────────────────────────────────────
  {
    name: 'show_diagram',
    declaration: {
      name: 'show_diagram',
      description:
        'Render a Mermaid diagram — flowchart, sequence, class, gantt, state, ER, journey, pie. ' +
        'Use for system architecture, process flows, sequences, entity relationships, timelines. ' +
        'Write standard Mermaid syntax in the `definition` field.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Diagram title',
          },
          definition: {
            type: 'string',
            description:
              'Mermaid diagram definition. Examples:\n' +
              '  flowchart LR\\n  A --> B --> C\n' +
              '  sequenceDiagram\\n  Alice->>Bob: Hello\n' +
              '  gantt\\n  title Project\\n  section Phase 1\\n  Task :a1, 2024-01-01, 7d',
          },
        },
        required: ['title', 'definition'],
      },
    },

    async execute({ title, definition }) {
      const html = baseHtml(title,
        `<div class="card">
          <h2>${title}</h2>
          <div class="mermaid" style="text-align:center; padding:1rem;">
${definition}
          </div>
        </div>`,
        `<script type="module">
          import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
          mermaid.initialize({
            startOnLoad: true,
            theme: 'dark',
            themeVariables: {
              primaryColor: '#7c6af7',
              primaryTextColor: '#e2e8f0',
              primaryBorderColor: '#2a2d3e',
              lineColor: '#64748b',
              background: '#1a1d27',
              mainBkg: '#1a1d27',
              nodeBorder: '#7c6af7',
              clusterBkg: '#0f1117',
              titleColor: '#e2e8f0',
              edgeLabelBackground: '#0f1117',
            },
          });
        </script>`
      );

      return writeAndOpen(`diagram_${timestamp()}.html`, html);
    },
  },

  // ── show_table ───────────────────────────────────────────────────────────────
  {
    name: 'show_table',
    declaration: {
      name: 'show_table',
      description:
        'Render a styled, sortable, searchable data table in the browser. ' +
        'Use for displaying structured data, comparisons, reports, analysis results. ' +
        'Pass an array of row objects — columns are inferred from the keys.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Table title / heading',
          },
          rows: {
            type: 'array',
            description: 'Array of objects — each key becomes a column header',
            items: { type: 'object' },
          },
          caption: {
            type: 'string',
            description: 'Optional caption / note below the table',
          },
        },
        required: ['title', 'rows'],
      },
    },

    async execute({ title, rows, caption }) {
      if (!rows || !rows.length) return 'No rows to display.';
      const columns = Object.keys(rows[0]);

      const thead = `<tr>${columns.map(c =>
        `<th onclick="sortBy('${c}')" style="cursor:pointer;user-select:none;">${c} <span class="sort-icon">⇅</span></th>`
      ).join('')}</tr>`;

      const tbody = rows.map(row =>
        `<tr>${columns.map(c => `<td>${row[c] ?? ''}</td>`).join('')}</tr>`
      ).join('');

      const html = baseHtml(title, `
        <div class="card">
          <h2>${title}</h2>
          <input id="search" type="text" placeholder="🔍 Search…"
            oninput="filterRows()"
            style="width:100%;padding:.6rem 1rem;margin-bottom:1rem;
                   background:var(--bg);border:1px solid var(--border);
                   border-radius:8px;color:var(--text);font-size:.9rem;">
          <div style="overflow-x:auto;">
            <table id="table" style="width:100%;border-collapse:collapse;">
              <thead>${thead}</thead>
              <tbody id="tbody">${tbody}</tbody>
            </table>
          </div>
          ${caption ? `<p class="muted" style="margin-top:.75rem;">${caption}</p>` : ''}
        </div>
        <style>
          th, td { padding: .7rem 1rem; text-align:left; border-bottom:1px solid var(--border); }
          th { background: var(--bg); color: var(--accent); font-size:.85rem; text-transform:uppercase; letter-spacing:.05em; }
          tr:hover td { background: rgba(124,106,247,.08); }
          .sort-icon { opacity: .4; font-size:.7rem; }
        </style>
        <script>
          const allRows = [...document.querySelectorAll('#tbody tr')];
          function filterRows() {
            const q = document.getElementById('search').value.toLowerCase();
            allRows.forEach(r => {
              r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
            });
          }
          function sortBy(col) {
            const idx = ${JSON.stringify(columns)}.indexOf(col);
            const sorted = [...document.querySelectorAll('#tbody tr')].sort((a,b) => {
              const av = a.cells[idx]?.textContent || '';
              const bv = b.cells[idx]?.textContent || '';
              return isNaN(av) ? av.localeCompare(bv) : Number(av) - Number(bv);
            });
            const tbody = document.getElementById('tbody');
            sorted.forEach(r => tbody.appendChild(r));
          }
        </script>
      `);

      return writeAndOpen(`table_${timestamp()}.html`, html);
    },
  },

  // ── show_dashboard ───────────────────────────────────────────────────────────
  {
    name: 'show_dashboard',
    declaration: {
      name: 'show_dashboard',
      description:
        "Open Jojo's live dashboard in the browser — shows persistent memory, " +
        'knowledge base topics, practiced skills, and self-evaluation scores. ' +
        'Use when the user asks to see a summary, overview, or status of Jojo.',
      parameters: { type: 'object', properties: {} },
    },

    async execute(_args, { memory, learning }) {
      const data   = memory?.data || {};
      const facts  = data.facts    || [];
      const knowledge = data.knowledge || {};
      const skills    = data.skills_practiced || {};
      const evals     = data.self_eval_history || [];

      const avgScore = evals.length
        ? (evals.slice(-10).reduce((s,e) => s + e.score, 0) / Math.min(10, evals.length)).toFixed(1)
        : 'n/a';

      const knowledgeCards = Object.entries(knowledge).map(([topic, k]) => `
        <div class="card" style="margin-bottom:.75rem;">
          <div style="display:flex;justify-content:space-between;align-items:start;">
            <strong style="color:var(--accent)">${topic}</strong>
            <span class="badge">${k.confidence || 'MEDIUM'}</span>
          </div>
          <p style="margin:.5rem 0;font-size:.9rem;">${(k.summary || '').slice(0, 120)}…</p>
          <span class="muted">${k.skill_level || 'intermediate'} · ${k.key_facts?.length || 0} facts · ${new Date(k.learned_at).toLocaleDateString()}</span>
        </div>`).join('') || '<p class="muted">No topics learned yet. Try: learn &lt;topic&gt;</p>';

      const skillRows = Object.entries(skills).map(([name, sk]) => `
        <tr>
          <td>${name}</td>
          <td>
            <div style="background:var(--bg);border-radius:6px;height:8px;width:100%;overflow:hidden;">
              <div style="background:var(--accent);height:8px;width:${(Number(sk.level||1)/5*100).toFixed(0)}%;border-radius:6px;"></div>
            </div>
          </td>
          <td style="text-align:right;">${Number(sk.level||1).toFixed(1)}/5</td>
          <td style="text-align:right;">${sk.sessions||0}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">No skills practiced yet.</td></tr>';

      const factsList = facts.slice(-20).map((f, i) =>
        `<div style="padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.85rem;">${i+1}. ${f}</div>`
      ).join('') || '<p class="muted">No memories yet.</p>';

      const html = baseHtml('Jojo Dashboard', `
        <div style="max-width:1100px;margin:0 auto;">
          <div style="display:flex;align-items:center;gap:1rem;margin-bottom:2rem;">
            <span style="font-size:2.5rem;">🤖</span>
            <div>
              <h1 style="font-size:1.8rem;margin:0;">Jojo Agent Dashboard</h1>
              <p class="muted">v2.0.0 · Claude-powered (via Puter) · Self-learning enabled</p>
            </div>
          </div>

          <!-- Stats row -->
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1rem;margin-bottom:2rem;">
            ${[
              ['📚', Object.keys(knowledge).length, 'Topics learned'],
              ['🧠', facts.length, 'Memories stored'],
              ['🎯', Object.keys(skills).length, 'Skills practiced'],
              ['📊', avgScore + (avgScore !== 'n/a' ? '/10' : ''), 'Avg quality score'],
            ].map(([icon, val, label]) => `
              <div class="card" style="text-align:center;padding:1.25rem .5rem;">
                <div style="font-size:1.8rem;">${icon}</div>
                <div style="font-size:2rem;font-weight:700;color:var(--accent);line-height:1.2;">${val}</div>
                <div class="muted">${label}</div>
              </div>`).join('')}
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;">

            <!-- Knowledge -->
            <div>
              <h2>📖 Knowledge Base</h2>
              ${knowledgeCards}
            </div>

            <!-- Right column -->
            <div>
              <!-- Skills -->
              <h2>🎯 Practiced Skills</h2>
              <div class="card" style="margin-bottom:1.5rem;">
                <table style="width:100%;border-collapse:collapse;">
                  <thead>
                    <tr style="font-size:.75rem;text-transform:uppercase;color:var(--muted);">
                      <th style="padding:.5rem;text-align:left;">Skill</th>
                      <th style="padding:.5rem;">Progress</th>
                      <th style="padding:.5rem;text-align:right;">Level</th>
                      <th style="padding:.5rem;text-align:right;">Sessions</th>
                    </tr>
                  </thead>
                  <tbody>${skillRows}</tbody>
                </table>
              </div>

              <!-- Memory -->
              <h2>🧠 Recent Memories</h2>
              <div class="card" style="max-height:320px;overflow-y:auto;">
                ${factsList}
              </div>
            </div>
          </div>
        </div>
        <style>
          td { padding:.5rem .75rem; }
          td:first-child { color:var(--text); }
        </style>
      `);

      return writeAndOpen(`dashboard_${timestamp()}.html`, html);
    },
  },

];

