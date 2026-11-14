import readline from 'readline';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { JojoAgent } from './core/agent.js';
import { printLogo } from './core/branding.js';
import { destroyAllSandboxes } from './core/sandbox.js';

dotenv.config();

// ── helpers ───────────────────────────────────────────────────────────────────

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

function banner() {
  printLogo();
  console.log(chalk.gray('  JOJO Agent v4.2.0 · MULTIMODAL · Powered by Claude (via Puter)'));
  console.log(chalk.gray('  + Real-time Self-Learning · Deliberate Reasoning (plan→critique→refine)'));
  console.log(chalk.gray('  + Multi-Task Ledger · Visual Widget Engine · Multimodal Engine'));
  console.log(chalk.gray('  + Capability Synthesis & Natural Selection\n'));
  console.log(chalk.gray('  Commands: memory | knowledge | skills | scores | tasks | dashboard | trace | clear | exit'));
  console.log(chalk.gray('            learn <topic> | explore | mcp | mcp reload | plugins | plugins reload | watch | fixes | devices'));
  console.log(chalk.gray('  Swarm:    spawn_subagent_swarm runs scoped parallel sub-agents + an arbitration pass'));
  console.log(chalk.gray('  World:    watch shows background-monitored files/dirs/commands/URLs + recent drift events'));
  console.log(chalk.gray('  Heal:     fixes shows self-healing fixes verified in a sandbox, awaiting your approval'));
  console.log(chalk.gray('  Devices:  devices shows other known JOJO instances, handoff status, and recent pushes'));
  console.log(chalk.gray('  Skills:   skills shows loaded skills (⭐ core / 🌱 probation / [synthesized] badges)'));
  console.log(chalk.gray('            scores shows the full Capability Synthesis & Natural Selection scoreboard'));
  console.log(chalk.gray('  MCP:      mcp shows connected servers + their tools (real @modelcontextprotocol/sdk client)'));
  console.log(chalk.gray('  Any IDE:  npm run mcp-server exposes Jojo itself as an MCP server — see MCP_AND_PLUGINS.md'));
  console.log(chalk.gray('  Plugins:  plugins shows loaded plugins; /<command> runs one\'s slash command directly'));
  console.log(chalk.gray('  Visual:   show_widget | show_chart | show_diagram | show_table | show_dashboard'));
  console.log(chalk.gray('  Learn:    learn_topic | self_review | practice_skill | explore_curiosity'));
  console.log(chalk.cyan('  Multimodal (new in v4):'));
  console.log(chalk.gray('    → vision_analyze   <image_url>          Deep image analysis'));
  console.log(chalk.gray('    → vision_compare   <img1> <img2> ...    Compare images'));
  console.log(chalk.gray('    → vision_extract   <image_url> <type>   OCR/chart/code/table'));
  console.log(chalk.gray('    → vision_search    <image_url>          Image + live web search'));
  console.log(chalk.gray('    → audio_analyze    <audio_url>          Transcribe + analyze'));
  console.log(chalk.gray('    → doc_analyze      <doc_url>            Deep document analysis'));
  console.log(chalk.gray('    → multimodal_reason                     Cross-modal reasoning\n'));
}

// ── main ──────────────────────────────────────────────────────────────────────

// Tracks the live agent so the SIGINT handler below can close MCP
// connections gracefully even on Ctrl+C — otherwise stdio MCP servers
// (spawned child processes) would be left as orphans.
let agentRef = null;
process.on('SIGINT', async () => {
  console.log(chalk.cyan('\n\nShutting down…\n'));
  if (agentRef) await agentRef.shutdown().catch(() => {});
  await destroyAllSandboxes().catch(() => {});
  process.exit(0);
});

async function main() {
  banner();

  let agent;
  try {
    agent = new JojoAgent();
    await agent.init();
    agentRef = agent;
    console.log(chalk.green('✓ Agent ready. Learning engine online. Visual engine online.\n'));
  } catch (err) {
    console.error(chalk.red('Startup failed:', err.message));
    process.exit(1);
  }

  // ── REPL loop ──────────────────────────────────────────────────────────────
  while (true) {
    const raw   = await ask(chalk.green('You › '));
    const input = raw.trim();
    if (!input) continue;

    // ── Built-in commands ──────────────────────────────────────────────────

    if (input === 'exit') {
      console.log(chalk.cyan('\nGoodbye!\n'));
      await agent.shutdown().catch(() => {});
      rl.close();
      process.exit(0);
    }

    if (input === 'memory') {
      agent.memory.show();
      continue;
    }

    if (input === 'knowledge') {
      agent.memory.showKnowledge();
      continue;
    }

    if (input === 'skills') {
      agent.skills.list(agent.skillLedger);
      continue;
    }

    if (input === 'scores') {
      const board = agent.skillLedger.scoreboard();
      console.log(chalk.cyan('\n📊  Skill Scoreboard (Capability Synthesis & Natural Selection):\n'));
      if (!board.length) {
        console.log(chalk.gray('  (no skills registered yet)\n'));
      } else {
        board.forEach(s => {
          const kind = s.protected ? 'hand-authored, immune' : 'synthesized';
          const pct  = s.score === null ? 'n/a' : `${Math.round(s.score * 100)}%`;
          const color = s.status === 'retired' ? chalk.red : s.status === 'core' ? chalk.yellow : chalk.white;
          console.log(color(`  · ${s.name}`) + chalk.gray(` [${s.status}] (${kind}) — ${s.total} use(s), ${pct} score`));
        });
        console.log('');
      }
      continue;
    }

    if (input === 'tasks') {
      agent.tasks.print(chalk);
      continue;
    }

    if (input === 'model' || input.startsWith('model ')) {
      const arg = input.slice(5).trim();
      const PROVIDERS = ['gemini', 'nvidia', 'puter', 'openai'];

      if (!arg) {
        // Status: which providers are actually configured, current order,
        // current pin (if any), and what Conductor would auto-prefer.
        const configured = PROVIDERS.filter(p => ({
          gemini: process.env.GEMINI_API_KEY, nvidia: process.env.NVIDIA_API_KEY,
          puter: process.env.PUTER_AUTH_TOKEN, openai: process.env.OPENAI_API_KEY,
        }[p]));
        const order = (process.env.PROVIDER_ORDER || 'gemini,nvidia,puter,openai').split(',').map(s => s.trim());
        console.log(chalk.cyan('\n🧭  Model routing:\n'));
        console.log(chalk.white('  Configured providers: ') + chalk.gray(configured.join(', ') || '(none!)'));
        console.log(chalk.white('  Fallback order:       ') + chalk.gray(order.join(' → ')));
        console.log(chalk.white('  Session pin:          ') +
          (agent.modelPin ? chalk.yellow(`${agent.modelPin.provider}${agent.modelPin.model ? ` (${agent.modelPin.model})` : ''}`) : chalk.gray('(none — automatic)')));
        console.log(chalk.gray('\n  Usage: model <provider> [model-name]   e.g. model puter claude-opus-4-8'));
        console.log(chalk.gray('         model auto                       — clear the pin, back to automatic routing'));
        console.log(chalk.gray('         (session-only — for a permanent change, use: bash scripts/set_key.sh)\n'));
        continue;
      }

      if (arg === 'auto') {
        agent.setModelPin(null);
        console.log(chalk.green('\nCleared model pin — back to automatic per-turn routing.\n'));
        continue;
      }

      const [provider, ...rest] = arg.split(' ');
      const modelName = rest.join(' ').trim() || null;
      if (!PROVIDERS.includes(provider)) {
        console.log(chalk.red(`\nUnknown provider "${provider}". Use one of: ${PROVIDERS.join(', ')}, or "model auto" to clear.\n`));
        continue;
      }
      try {
        agent.setModelPin(provider, modelName);
        console.log(chalk.green(`\nPinned to ${provider}${modelName ? ` (${modelName})` : ''} for this session. ` +
          `Still falls back to the rest of the chain automatically if it fails — this only changes what's tried first.\n`));
      } catch (err) {
        console.log(chalk.red(`\n${err.message}\n`));
      }
      continue;
    }

    if (input === 'clear') {
      agent.clearHistory();
      console.log(chalk.gray('History cleared.\n'));
      continue;
    }

    // "trace" — show exactly what the reasoning engine did on the last turn
    if (input === 'trace') {
      const t = agent.reasoning.lastTrace;
      if (!t) {
        console.log(chalk.gray('\nNo reasoning trace yet — ask something non-trivial first.\n'));
        continue;
      }
      console.log(chalk.cyan(`\n🧠  Reasoning trace — tier: ${t.tier}\n`));
      if (t.plan) {
        console.log(chalk.white('Plan:'));
        console.log(chalk.gray(agent.reasoning.formatPlan(t.plan)) + '\n');
      } else {
        console.log(chalk.gray('(no plan — fast tier, pipeline skipped)\n'));
      }
      if (t.critique) {
        console.log(chalk.white(`Critique: ${t.critique.has_issues ? `${t.critique.issues.length} issue(s) found` : 'no significant issues'}`));
        (t.critique.issues || []).forEach(i => console.log(chalk.gray(`  • ${i}`)));
        console.log(chalk.white(`Refined: ${t.refined ? 'yes — answer was rewritten' : 'no'}\n`));
      }
      continue;
    }

    // "dashboard" — open the live visual dashboard in browser
    if (input === 'dashboard') {
      console.log(chalk.gray('\nOpening dashboard in browser…\n'));
      try {
        const reply = await agent.run('Use show_dashboard to open my visual dashboard.');
        console.log(chalk.yellow('\nJojo › ') + chalk.white(reply) + '\n');
      } catch (err) {
        console.error(chalk.red('\n[Error]', err.message) + '\n');
      }
      continue;
    }

    // "learn <topic>" — trigger autonomous research on a specific topic
    if (input.toLowerCase().startsWith('learn ')) {
      const topic = input.slice(6).trim();
      if (!topic) { console.log(chalk.gray('Usage: learn <topic>\n')); continue; }
      console.log(chalk.gray(`\nResearching "${topic}"…\n`));
      try {
        const reply = await agent.run(
          `Use the learn_topic tool to deeply research and learn about: "${topic}". ` +
          `After learning, give me a brief summary of what you now know.`
        );
        console.log(chalk.yellow('\nJojo › ') + chalk.white(reply) + '\n');
      } catch (err) {
        console.error(chalk.red('\n[Error]', err.message) + '\n');
      }
      continue;
    }

    // "explore" — trigger curiosity-driven autonomous learning
    if (input.toLowerCase() === 'explore') {
      console.log(chalk.gray('\nJojo is deciding what to learn next…\n'));
      try {
        const reply = await agent.run(
          'Use explore_curiosity to autonomously pick and research something valuable ' +
          'based on your current knowledge gaps. Then summarize what you learned.'
        );
        console.log(chalk.yellow('\nJojo › ') + chalk.white(reply) + '\n');
      } catch (err) {
        console.error(chalk.red('\n[Error]', err.message) + '\n');
      }
      continue;
    }

    // "watch" — background-monitored world model: what's watched + recent drift
    if (input.toLowerCase() === 'watch') {
      agent.worldModel.print(chalk);
      continue;
    }

    // "devices" — cross-device continuity: known devices, handoff, recent pushes
    if (input.toLowerCase() === 'devices') {
      agent.continuity.print(chalk);
      continue;
    }

    // "fixes" — self-healing loop: fixes verified in sandbox, awaiting approval
    if (input.toLowerCase() === 'fixes') {
      const pending = agent.healer.listPending();
      if (!pending.length) {
        console.log(chalk.gray('\n  No pending self-healing fixes.\n'));
      } else {
        console.log(chalk.cyan('\n🔧 Self-Healing — Verified Fixes Awaiting Approval:\n'));
        pending.forEach(f => {
          console.log(chalk.white(`  · [${f.id}] "${f.watchLabel}" — ${f.description}`));
          console.log(chalk.gray(`      files: ${Object.keys(f.files).join(', ')}`));
          console.log(chalk.gray(`      candidates tried: ${f.candidatesTried} · created: ${f.createdAt}`));
        });
        console.log(chalk.gray('\n  Ask Jojo to apply or dismiss one by id.\n'));
      }
      continue;
    }

    // "mcp" / "mcp reload" — real MCP (Model Context Protocol) client status
    if (input.toLowerCase() === 'mcp') {
      agent.mcp.list();
      continue;
    }
    if (input.toLowerCase() === 'mcp reload') {
      console.log(chalk.gray('\nReconnecting MCP servers…\n'));
      await agent.mcp.reload(agent.plugins.getMcpServers());
      agent.refreshDynamicTools();
      agent.mcp.list();
      continue;
    }

    // "plugins" / "plugins reload" — local plugin status
    if (input.toLowerCase() === 'plugins') {
      agent.plugins.list();
      continue;
    }
    if (input.toLowerCase() === 'plugins reload') {
      console.log(chalk.gray('\nRescanning ./plugins…\n'));
      await agent.plugins.reload();
      await agent.mcp.reload(agent.plugins.getMcpServers()); // in case bundled servers changed
      agent.refreshDynamicTools();
      agent.plugins.list();
      continue;
    }

    // "/command args…" — a plugin-defined slash command. Looks up the
    // command across every enabled plugin and routes its canned prompt
    // straight through the normal agent turn (see plugins/README.md).
    if (input.startsWith('/')) {
      const [cmdName, ...rest] = input.slice(1).split(/\s+/);
      const argStr = rest.join(' ');
      const cmd = agent.plugins.getCommand(cmdName);
      if (!cmd) {
        console.log(chalk.gray(`\nNo plugin command "/${cmdName}" found. Type "plugins" to see what's loaded.\n`));
        continue;
      }
      const prompt = cmd.prompt.includes('{args}')
        ? cmd.prompt.replace(/\{args\}/g, argStr)
        : (argStr ? `${cmd.prompt}\n\n${argStr}` : cmd.prompt);
      console.log(chalk.gray(`\nRunning /${cmdName}…\n`));
      try {
        const reply = await agent.run(prompt);
        console.log(chalk.yellow('\nJojo › ') + chalk.white(reply) + '\n');
      } catch (err) {
        console.error(chalk.red('\n[Error]', err.message) + '\n');
      }
      continue;
    }

    // ── Normal agent turn ──────────────────────────────────────────────────
    try {
      const reply = await agent.run(input);
      console.log(chalk.yellow('\nJojo › ') + chalk.white(reply) + '\n');
    } catch (err) {
      console.error(chalk.red('\n[Error]', err.message) + '\n');
    }
  }
}

// `node src/index.js --mcp` runs the MCP server instead of the REPL — some
// IDE configs may point at this same entry point. `npm run mcp-server`
// (→ src/mcp-server.js) is the recommended way in, since it resolves .env
// relative to itself regardless of the spawning process's cwd; this flag
// is here so index.js works too if that's what ends up configured.
if (process.argv.includes('--mcp')) {
  const { runMcpServer } = await import('./core/mcp_server.js');
  runMcpServer().catch(err => {
    console.error('[jojo mcp-server] fatal:', err);
    process.exit(1);
  });
} else {
  main();
}

