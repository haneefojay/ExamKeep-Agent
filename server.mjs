// Queue server. Serves the queue page and a small JSON API behind HTTP Basic auth.
// It never sends a message to anyone; people copy approved drafts and send them by hand.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openStore } from './store.mjs';
import { runBatch, BRIEF } from './agent.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STATUS_FLOW = { approved: ['sent'], sent: ['replied'], replied: ['demo'] };

export function createServer(env = process.env, store = openStore(env.DATA_FILE || join(here, 'data', 'state.json')), deps = {}) {
  if (!env.OUTREACH_PASSWORD || env.OUTREACH_PASSWORD.length < 12) throw new Error('Set OUTREACH_PASSWORD (12+ characters)');
  if (!Object.keys(store.state.prospects).length && existsSync(join(here, 'seed.json'))) {
    store.state.prospects = JSON.parse(readFileSync(join(here, 'seed.json'), 'utf8'));
    store.save();
  }
  const want = Buffer.from(env.OUTREACH_PASSWORD);
  const authed = (req) => {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Basic ')) return false;
    const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
    const got = Buffer.from(pass);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'" });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  const readBody = (req) => new Promise((ok, no) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > 50_000) { no(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch (e) { no(e); } });
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!authed(req)) { res.setHeader('www-authenticate', 'Basic realm="ExamKeep outreach"'); return send(res, 401, { error: 'sign in' }); }
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, readFileSync(join(here, 'public', 'index.html')), 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.js') return send(res, 200, readFileSync(join(here, 'public', 'app.js')), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const s = store.state;
        return send(res, 200, { prospects: Object.values(s.prospects), criteria: s.criteria, usage: { ...store.usage(), cap: Number(env.MONTHLY_CAP_USD || 5) }, job: s.job, log: s.log.slice(0, 200), brief: BRIEF });
      }
      if (req.method === 'POST') {
        if (req.headers['x-requested-with'] !== 'examkeep') return send(res, 403, { error: 'missing header' });
        const body = await readBody(req);
        const m = url.pathname.match(/^\/api\/prospects\/([a-z0-9-]+)$/);
        if (m) {
          const p = store.state.prospects[m[1]];
          if (!p) return send(res, 404, { error: 'not found' });
          const a = body.action;
          if (a === 'approve' && p.status === 'pending') p.status = 'approved';
          else if (a === 'reject' && p.status === 'pending') p.status = 'rejected';
          else if (a === 'reopen' && p.status === 'rejected') p.status = 'pending';
          else if (a === 'advance' && STATUS_FLOW[p.status]) p.status = STATUS_FLOW[p.status][0];
          else if (a === 'edit' && typeof body.draft === 'string' && body.draft.length < 2000 && ['pending', 'approved'].includes(p.status)) p.draft = body.draft;
          else return send(res, 409, { error: 'not allowed in this state' });
          p.updatedAt = new Date().toISOString();
          store.log(p.name, a === 'advance' ? `marked ${p.status}` : a === 'edit' ? 'edited draft' : p.status);
          store.save();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/criteria') {
          for (const k of ['area', 'fit', 'skip']) if (typeof body[k] === 'string') store.state.criteria[k] = body[k].slice(0, 1000);
          store.log('', 'criteria updated'); store.save();
          return send(res, 200, { ok: true });
        }
        if (url.pathname === '/api/run') {
          if (store.state.job.running) return send(res, 409, { error: 'A batch is already running' });
          const count = Math.max(1, Math.min(Number(body.count) || 5, 10));
          runBatch(store, env, count, deps).catch((e) => { store.state.job = { running: false, message: `Stopped: ${e.message}`, startedAt: '' }; store.log('', 'batch stopped', e.message); store.save(); });
          return send(res, 202, { started: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  });
  return { server, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, store } = createServer();
  const j = store.state.job; if (j.running) { j.running = false; j.message = 'Stopped by a restart'; store.save(); }
  const port = Number(process.env.PORT || 8787);
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`outreach queue on :${port}`));
}
