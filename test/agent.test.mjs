import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../store.mjs';
import { createServer } from '../server.mjs';
import { draftOk, parseJson, slug, runBatch } from '../agent.mjs';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'oa-')), 's.json');
const ENV = { OUTREACH_PASSWORD: 'correct horse battery', DATA_FILE: '', MONTHLY_CAP_USD: '5' };
const auth = 'Basic ' + Buffer.from('u:correct horse battery').toString('base64');

test('draft rules reject price, links and the pilot school', () => {
  const ok = 'Good day. I saw your ICT lab.\nExamKeep runs your own exams on lab computers and keeps every answer if the network drops.\nMay I show you in 15 minutes at your school? - Haneef';
  assert.equal(draftOk(ok), true);
  assert.equal(draftOk(ok + ' ₦2,000'), false);
  assert.equal(draftOk(ok + ' https://examkeep.com'), false);
  assert.equal(draftOk(ok + ' OLA Maryway'), false);
});

test('json parsing and slugs', () => {
  assert.deepEqual(parseJson('text [{"a":1}] more'), [{ a: 1 }]);
  assert.equal(slug('St. Anne\'s School!'), 'st-anne-s-school');
});

test('server requires the password and the custom header', async () => {
  const { server } = createServer({ ...ENV, DATA_FILE: tmp() }, openStore(tmp()));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const st = await (await fetch(base + '/api/state', { headers: { authorization: auth } })).json();
  assert.equal(st.prospects.length, 6);
  const id = st.prospects[0].id;
  const noHeader = await fetch(base + '/api/prospects/' + id, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: '{"action":"approve"}' });
  assert.equal(noHeader.status, 403);
  const post = (b) => fetch(base + '/api/prospects/' + id, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json', 'x-requested-with': 'examkeep' }, body: JSON.stringify(b) });
  assert.equal((await post({ action: 'advance' })).status, 409);
  assert.equal((await post({ action: 'approve' })).status, 200);
  assert.equal((await post({ action: 'approve' })).status, 409);
  assert.equal((await post({ action: 'advance' })).status, 200);
  server.close();
});

test('refuses to start with a weak password', () => {
  assert.throws(() => createServer({ OUTREACH_PASSWORD: 'short' }, openStore(tmp())));
});

test('batch stops at the monthly cap and never sends anything', async () => {
  const store = openStore(tmp());
  store.usage().usd = 5;
  const r = await runBatch(store, { GEMINI_API_KEY: 'k', LLM_PROVIDER: 'gemini', MONTHLY_CAP_USD: '5' }, 3);
  assert.match(r.error, /Monthly cap/);
  assert.equal(store.state.job.running, false);
});

test('batch with a mocked model adds a verified, drafted school', async () => {
  const store = openStore(tmp());
  const realFetch = globalThis.fetch;
  const reply = (text) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } }));
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) return reply('[{"name":"Example Grammar School","website":"https://93.184.216.34/"}]');
    if (n === 2) return reply('{"area":"Ibadan","type":"private secondary","tier":"A","reason":"Its page lists an ICT laboratory.","channel":"email"}');
    return reply('Good day. I saw that Example Grammar School lists an ICT laboratory.\nExamKeep runs your own exams on lab computers and keeps every answer if the network drops.\nMay I show you in 15 minutes at your school? - Haneef');
  };
  try {
    const page = async () => new Response('<html>Example Grammar School ICT laboratory info@example.com 08031234567</html>');
    const r = await runBatch(store, { GEMINI_API_KEY: 'k', LLM_PROVIDER: 'gemini' }, 1, { fetch: page });
    assert.equal(r.added, 1, JSON.stringify(r));
    const p = store.state.prospects['example-grammar-school'];
    assert.equal(p.status, 'pending');
    assert.match(p.contact, /info@example.com/);
    assert.ok(store.usage().usd > 0.03);
  } finally { globalThis.fetch = realFetch; }
});

test('page fetch refuses private and local addresses', async () => {
  const { fetchText } = await import('../agent.mjs');
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'file:///etc/passwd']) {
    await assert.rejects(() => fetchText(u, async () => new Response('x')), undefined, u);
  }
});

test('settings: provider, model and key come from the page and the key is never returned', async () => {
  const { server } = createServer({ ...ENV, DATA_FILE: tmp() }, openStore(tmp()));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = { authorization: auth, 'content-type': 'application/json', 'x-requested-with': 'examkeep' };
  const bad = await fetch(base + '/api/settings', { method: 'POST', headers: h, body: JSON.stringify({ provider: 'custom', baseUrl: 'http://insecure.example' }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(base + '/api/settings', { method: 'POST', headers: h, body: JSON.stringify({ provider: 'groq', model: 'm1', apiKey: 'gsk_secretvalue1234' }) });
  assert.equal(ok.status, 200);
  const raw = await (await fetch(base + '/api/state', { headers: { authorization: auth } })).text();
  assert.ok(!raw.includes('secretvalue'));
  const st = JSON.parse(raw).settings;
  assert.equal(st.provider, 'groq'); assert.equal(st.keyHint, '…1234'); assert.equal(st.canSearch, false);
  server.close();
});

test('OpenAI-compatible provider drafts a school added by hand; search is refused', async () => {
  const store = openStore(tmp());
  Object.assign(store.state.settings, { provider: 'groq', model: 'm1', apiKey: 'k' });
  const realFetch = globalThis.fetch;
  let n = 0;
  const chat = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /groq\.com\/openai\/v1\/chat\/completions/);
    assert.equal(init.headers.authorization, 'Bearer k');
    n += 1;
    return n === 1 ? chat('{"area":"Ibadan","type":"private","tier":"B","reason":"Its page lists an ICT laboratory.","channel":"email"}')
      : chat('Good day. I saw that Hand Added College lists an ICT laboratory.\nExamKeep runs your own exams on lab computers and keeps every answer if the network drops.\nMay I show you in 15 minutes at your school? - Haneef');
  };
  try {
    const { addSchool } = await import('../agent.mjs');
    const page = async () => new Response('<html>Hand Added College ICT laboratory</html>');
    const r = await addSchool(store, {}, { name: 'Hand Added College', website: 'https://93.184.216.34/' }, { fetch: page });
    assert.equal(r.added, 1, JSON.stringify(r));
    const s2 = await runBatch(store, {}, 1);
    assert.match(s2.error, /cannot search the web/);
  } finally { globalThis.fetch = realFetch; }
});

test('old drafts get the sender and company named once', () => {
  const store = openStore(tmp());
  store.state.prospects = { a: { id: 'a', name: 'A', status: 'pending', draft: 'Good day. I saw your lab.\nExamKeep runs exams.\nMay I show you in 15 minutes at your school? - Haneef' } };
  createServer({ ...ENV }, store);
  assert.match(store.state.prospects.a.draft, /^Good day\. I am Haneef from ExamKeep\. I saw/);
  assert.match(store.state.prospects.a.draft, /- Haneef, ExamKeep$/);
  createServer({ ...ENV }, store);
  assert.equal((store.state.prospects.a.draft.match(/I am Haneef/g) || []).length, 1);
});
