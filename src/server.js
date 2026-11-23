import 'dotenv/config';
import http from 'http';
import { JojoAgent } from './core/agent.js';

const TOKEN = process.env.JOJO_API_TOKEN;
if (!TOKEN) throw new Error('Set JOJO_API_TOKEN');

const BLOCKED = ['bash_execute','code_execute','nmap_scan','aircrack_ng',
  'airmon_ng','airodump_ng','aireplay_ng','apply_deployment','rollback_deployment'];

const agent = new JojoAgent();
agent.setChannel('text');
await agent.init();

let queue = Promise.resolve();

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CHAT_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  if (req.method === 'OPTIONS') return res.end();
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end(); }
  if (req.method !== 'POST' || req.url !== '/chat') { res.statusCode = 404; return res.end(); }

  let body = ''; for await (const c of req) body += c;
  let message, unsafe;
  try { ({ message, unsafe } = JSON.parse(body)); }
  catch { res.statusCode = 400; return res.end('bad json'); }

  queue = queue.then(async () => {
    const snap = unsafe ? null : agent.tools.disableTemporary(BLOCKED);
    try {
      const reply = await agent.run(message);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ reply }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message }));
    } finally { if (snap) agent.tools.restoreTemporary(snap); }
  });
}).listen(process.env.PORT || 7860);
