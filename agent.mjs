// Research and drafting steps. Three swappable stages: discover (search), read (extract facts
// from the school's own public page), draft (write the message). Nothing here sends anything.
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { resolve, complete } from './llm.mjs';

export const BRIEF = `You write for ExamKeep, a computer-based exam platform for Nigerian secondary schools.
Allowed claims only: a school's own exams run on its lab computers; each student has their own timer kept by the server;
every answer is saved on the student's computer first and sent when the network returns, so a dropped connection loses no work;
objective papers are marked on submit; works on ordinary computers; we ran our first sitting at a school in Ibadan this month.
Never mention a price, a link, the pilot school's name, a quote, JAMB/WAEC/NECO links, or legal compliance. Never promise anything.`;

const cfg = (env) => ({
  // Estimates only. Set the real rates from the provider's pricing page; the defaults are deliberately high.
  inPerM: Number(env.PRICE_IN_PER_M_USD || 1),
  outPerM: Number(env.PRICE_OUT_PER_M_USD || 5),
  perSearch: Number(env.PRICE_PER_SEARCH_USD || 0.035),
  cap: Number(env.MONTHLY_CAP_USD || 5),
});

export function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

export async function ask(store, env, _model, body, { search = false } = {}) {
  const c = cfg(env);
  const u = store.usage();
  if (u.usd >= c.cap) throw new Error(`Monthly cap of $${c.cap} reached ($${u.usd.toFixed(2)} spent)`);
  const prompt = body.contents[0].parts[0].text;
  const r = await complete(resolve(store, env), prompt, { search });
  u.usd += (r.inTok * c.inPerM + r.outTok * c.outPerM) / 1e6;
  if (search) { u.searches += 1; u.usd += c.perSearch; }
  store.save();
  return r.text;
}

export function parseJson(text, open = '[') {
  const close = open === '[' ? ']' : '}';
  const a = text.indexOf(open), b = text.lastIndexOf(close);
  if (a < 0 || b <= a) throw new Error('No JSON in model reply');
  return JSON.parse(text.slice(a, b + 1));
}

// Refuse private and local addresses, so a model-suggested URL cannot reach our own network.
async function safeUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad scheme');
  const addrs = await lookup(u.hostname, { all: true });
  for (const { address } of addrs) {
    if (net.isIP(address) === 4) {
      const [a, b] = address.split('.').map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) throw new Error('private address');
    } else if (/^(::1|fc|fd|fe80)/i.test(address)) throw new Error('private address');
  }
  return u;
}

export async function fetchText(raw, fetchImpl = fetch) {
  const u = await safeUrl(raw);
  const res = await fetchImpl(u, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 ExamKeepResearch' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 1_500_000);
  const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { url: res.url || u.href, text };
}

export async function discover(store, env, count) {
  const k = store.state.criteria;
  const known = Object.values(store.state.prospects).map((p) => p.name).join('; ') || 'none';
  const prompt = `Find up to ${count} real schools that are NOT in this list: ${known}.\nWhere: ${k.area}\nPrefer: ${k.fit}\nSkip: ${k.skip}\nUse web search. Return ONLY a JSON array of {"name":"","website":"https://..."} using each school's own website when one exists.`;
  const text = await ask(store, env, null, { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] }, { search: true });
  return parseJson(text).filter((x) => x && x.name && x.website).slice(0, count);
}

export async function readSchool(store, env, cand, fetchImpl = fetch) {
  const page = await fetchText(cand.website, fetchImpl);
  const first = cand.name.toLowerCase().split(/\s+/).filter((w) => w.length > 3)[0] || cand.name.toLowerCase();
  if (!page.text.toLowerCase().includes(first)) throw new Error('page does not mention the school');
  const prompt = `From this school website text only, return ONLY a JSON object: {"area":"","type":"","tier":"A|B|C","reason":"one sentence citing what the page says","channel":"email|phone|WhatsApp"}.\nTier A = proprietor-led or privately run, shows an ICT/computer lab or CBT use, and runs its own exams. B = fits but little lab evidence. C = possible.\nSay "not stated" for anything the text does not show. Do not guess.\nSchool: ${cand.name}\nText:\n${page.text.slice(0, 9000)}`;
  const out = parseJson(await ask(store, env, null, { contents: [{ role: 'user', parts: [{ text: prompt }] }] }), '{');
  const emails = [...new Set(page.text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])].slice(0, 3);
  const phones = [...new Set(page.text.match(/(?:\+234|0)[789]\d[\s-]?\d{3,4}[\s-]?\d{3,4}/g) || [])].slice(0, 3);
  return { ...out, sourceUrl: page.url, contact: [...emails, ...phones].join(', ') };
}

export function draftOk(d) {
  return typeof d === 'string' && d.length > 60 && d.length < 800 && !/https?:|www\.|₦|\bN\s?\d|naira|price|\bfree\b/i.test(d) && !/our lady|ola maryway/i.test(d);
}

export async function draftMessage(store, env, p) {
  const prompt = `${BRIEF}\nWrite a three-line first message from Haneef (founder) to the proprietor or principal of ${p.name}. Line 1 gives one specific, true reason for writing, taken only from this fact: ${p.reason}\nLine 2 states what ExamKeep does using only the allowed claims. Line 3 asks: "May I show you in 15 minutes at your school? - Haneef". Plain, polite Nigerian business English, no flattery, no emoji. Return only the message.`;
  const d = (await ask(store, env, null, { contents: [{ role: 'user', parts: [{ text: prompt }] }] })).trim();
  if (!draftOk(d)) throw new Error('draft broke a rule (price, link or forbidden name)');
  return d;
}

async function processCandidate(store, env, c, deps) {
  const j = store.state.job;
  j.message = `Reading ${c.name}`; store.save();
  const r = await readSchool(store, env, c, deps.fetch);
  const p = { id: slug(c.name), name: c.name, area: r.area, type: r.type, tier: ['A', 'B', 'C'].includes(r.tier) ? r.tier : 'C', reason: r.reason, sourceUrl: r.sourceUrl, channel: r.channel, contact: r.contact, status: 'pending', createdAt: new Date().toISOString() };
  if (store.state.prospects[p.id]) throw new Error('already in the queue');
  j.message = `Drafting for ${c.name}`; store.save();
  p.draft = await draftMessage(store, env, p);
  store.state.prospects[p.id] = p;
  store.log(p.name, 'added by agent', `tier ${p.tier}`);
}

const STOP = /^Monthly cap|No API key|No model|No base URL|cannot search/;

// Works with every provider: you name the school and its website, the agent reads and drafts.
export async function addSchool(store, env, cand, deps = {}) {
  const j = store.state.job;
  if (j.running) throw new Error('A batch is already running');
  Object.assign(j, { running: true, message: `Reading ${cand.name}`, startedAt: new Date().toISOString() });
  store.save();
  try {
    await processCandidate(store, env, cand, deps);
    j.message = `Done: ${cand.name} added`;
    return { added: 1 };
  } catch (e) {
    j.message = `Stopped: ${e.message}`;
    store.log(cand.name, 'could not add', e.message);
    return { added: 0, error: e.message };
  } finally { j.running = false; store.save(); }
}

export async function runBatch(store, env, count = 5, deps = {}) {
  const j = store.state.job;
  if (j.running) throw new Error('A batch is already running');
  Object.assign(j, { running: true, message: 'Searching for schools', startedAt: new Date().toISOString() });
  store.save();
  let added = 0;
  const skipped = [];
  try {
    const cands = await discover(store, env, Math.min(count, 10));
    for (const c of cands) {
      try {
        await processCandidate(store, env, c, deps);
        added += 1;
      } catch (e) {
        if (STOP.test(e.message)) throw e;
        skipped.push(`${c.name}: ${e.message}`);
        store.log(c.name, 'skipped', e.message);
      }
    }
  } catch (e) {
    j.running = false;
    j.message = `Stopped: ${e.message}${added ? ` (${added} added first)` : ''}`;
    store.log('', 'batch stopped', e.message);
    store.save();
    return { added, skipped, error: e.message };
  }
  j.running = false;
  j.message = `Done: ${added} added${skipped.length ? `, ${skipped.length} skipped` : ''}`;
  store.save();
  return { added, skipped };
}
