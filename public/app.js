// Queue page. All state lives on the server; this file only renders and sends actions.
const STATUSES = { pending: 'Waiting', approved: 'Approved', sent: 'Sent', replied: 'Replied', demo: 'Demo booked', rejected: 'Rejected' };
const NEXT = { approved: 'Mark sent', sent: 'Mark replied', replied: 'Demo booked' };
const $ = (id) => document.getElementById(id);
let S = { prospects: [], log: [], criteria: {}, usage: {}, job: {} };
let filter = 'pending', editing = null, criteriaShown = false, settingsShown = false;

function el(tag, props, ...kids) { const n = document.createElement(tag); Object.assign(n, props || {}); for (const k of kids) n.append(k); return n; }
function when(iso) { try { return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
function safeUrl(u) { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (e) { return ''; } }
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json', 'x-requested-with': 'examkeep' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
async function refresh() { try { S = await api('/api/state'); render(); } catch (e) { $('job').textContent = e.message; } }
async function act(id, body) { try { await api('/api/prospects/' + id, body); editing = null; await refresh(); } catch (e) { $('job').textContent = e.message; } }

function renderStrip() {
  const c = (s) => S.prospects.filter((i) => i.status === s).length;
  const s = $('strip'); s.replaceChildren();
  for (const [k, label] of [['pending', 'waiting'], ['approved', 'approved'], ['sent', 'sent'], ['replied', 'replied'], ['demo', 'demos booked']]) s.append(el('div', {}, el('b', { textContent: String(c(k)) }), el('span', { textContent: label })));
  const u = S.usage || {};
  s.append(el('div', { title: 'Estimate from token counts and search calls' }, el('b', { textContent: '$' + (u.usd || 0).toFixed(2) }), el('span', { textContent: 'of $' + (u.cap || 0) + ' this month' })));
}
function renderFilters() {
  const f = $('filters'); f.replaceChildren();
  for (const k of ['pending', 'approved', 'sent', 'replied', 'demo', 'rejected', 'all']) {
    const n = k === 'all' ? S.prospects.length : S.prospects.filter((i) => i.status === k).length;
    const b = el('button', { className: 'chip', textContent: (k === 'all' ? 'All' : STATUSES[k]) + ' ' + n });
    b.setAttribute('aria-pressed', String(filter === k));
    b.onclick = () => { filter = k; render(); };
    f.append(b);
  }
}
function card(i) {
  const url = safeUrl(i.sourceUrl || '');
  const head = el('div', { className: 'head' }, el('h2', { textContent: i.name || 'Unnamed school' }),
    el('span', {}, el('span', { className: 'pill ' + (i.tier || 'C'), textContent: 'Tier ' + (i.tier || 'C') }), ' ', el('span', { className: 'pill st-' + (i.status || 'pending'), textContent: STATUSES[i.status] || 'Waiting' })));
  const meta = el('div', { className: 'meta', textContent: [i.area, i.type, i.channel ? 'via ' + i.channel : ''].filter(Boolean).join(' · ') });
  const why = el('div', {}, el('strong', { textContent: 'Why: ' }), i.reason || '');
  if (url) { why.append(' '); why.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', textContent: 'source' })); }
  const box = el('div', { className: 'item' }, head, meta, why);
  if (i.contact) box.append(el('div', { className: 'meta', textContent: 'Public contact: ' + i.contact }));
  if (editing === i.id) {
    const ta = el('textarea', { value: i.draft || '' }); ta.setAttribute('aria-label', 'Edit draft');
    const save = el('button', { className: 'btn pri', textContent: 'Save draft' }); save.onclick = () => act(i.id, { action: 'edit', draft: ta.value });
    const cancel = el('button', { className: 'btn', textContent: 'Cancel' }); cancel.onclick = () => { editing = null; render(); };
    box.append(ta, el('div', { className: 'actions' }, save, cancel));
    return box;
  }
  box.append(el('div', { className: 'draft', textContent: i.draft || '(no draft yet)' }));
  const acts = el('div', { className: 'actions' });
  const add = (cls, text, fn) => { const b = el('button', { className: 'btn ' + cls, textContent: text }); b.onclick = fn; acts.append(b); return b; };
  if (i.status === 'pending') {
    add('go', 'Approve', () => act(i.id, { action: 'approve' }));
    add('', 'Edit', () => { editing = i.id; render(); });
    add('no', 'Reject', () => act(i.id, { action: 'reject' }));
  } else {
    if (i.status === 'approved' || i.status === 'sent') { const b = add('', 'Copy message', async () => { try { await navigator.clipboard.writeText(i.draft || ''); b.textContent = 'Copied'; } catch (e) { b.textContent = 'Select the text and copy'; } }); }
    if (NEXT[i.status]) add('pri', NEXT[i.status], () => act(i.id, { action: 'advance' }));
    if (i.status === 'approved') add('', 'Edit', () => { editing = i.id; render(); });
    if (i.status === 'rejected') add('', 'Move back to waiting', () => act(i.id, { action: 'reopen' }));
  }
  box.append(acts);
  return box;
}
function renderList() {
  const l = $('list'); l.replaceChildren();
  const rank = { A: 0, B: 1, C: 2 };
  const shown = S.prospects.filter((i) => filter === 'all' || i.status === filter).sort((a, b) => (rank[a.tier] ?? 3) - (rank[b.tier] ?? 3));
  if (!S.prospects.length) l.append(el('div', { className: 'empty', textContent: 'No drafts yet. Set the criteria, then choose Find more schools.' }));
  else if (!shown.length) l.append(el('div', { className: 'empty', textContent: 'Nothing in this view.' }));
  for (const i of shown) l.append(card(i));
}
function renderLog() {
  const u = $('log'); u.replaceChildren();
  if (!S.log.length) u.append(el('li', { className: 'meta', textContent: 'Nothing yet.' }));
  for (const g of S.log) u.append(el('li', {}, el('time', { textContent: when(g.at) }), el('span', { textContent: (g.school ? g.school + ': ' : '') + g.action + (g.extra ? ' (' + g.extra + ')' : '') })));
}
function syncBase() { $('m-search-row').hidden = $('m-provider').value !== 'gemini'; $('m-base-row').hidden = $('m-provider').value !== 'custom'; }
function renderSettings() {
  const st = S.settings;
  if (!settingsShown) {
    settingsShown = true;
    for (const [k, v] of Object.entries(st.providers)) $('m-provider').append(el('option', { value: k, textContent: v.label }));
    $('m-provider').value = st.provider; $('m-model').value = st.model; $('m-search').value = st.searchModel; $('m-base').value = st.baseUrl; syncBase();
    $('m-provider').onchange = () => { $('m-model').value = st.providers[$('m-provider').value].model; syncBase(); };
  }
  $('m-keyinfo').textContent = st.keySet ? 'A key is saved (' + st.keyHint + '). ' + (st.canSearch ? 'This provider can search the web for schools.' : 'This provider cannot search; use Add a school.') : 'No key saved yet.';
}
function render() {
  renderStrip(); renderFilters();
  if (!(editing && document.activeElement && document.activeElement.tagName === 'TEXTAREA')) renderList();
  renderLog();
  $('job').textContent = S.job.message || '';
  $('run').disabled = !!S.job.running;
  $('brief').textContent = S.brief || '';
  if (S.settings) renderSettings();
  if (!criteriaShown && S.criteria.area !== undefined) { criteriaShown = true; $('c-area').value = S.criteria.area; $('c-fit').value = S.criteria.fit; $('c-skip').value = S.criteria.skip; }
}

for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('#tabs button')) x.setAttribute('aria-selected', String(x === b));
    for (const t of ['queue', 'criteria', 'settings', 'brief', 'log']) $('tab-' + t).hidden = t !== b.dataset.tab;
  };
}
$('b-copy').onclick = async () => { try { await navigator.clipboard.writeText(S.brief || ''); $('b-state').textContent = 'Copied'; } catch (e) { $('b-state').textContent = 'Select the text and copy'; } };
$('c-save').onclick = async () => { try { await api('/api/criteria', { area: $('c-area').value, fit: $('c-fit').value, skip: $('c-skip').value }); $('c-state').textContent = 'Saved'; await refresh(); } catch (e) { $('c-state').textContent = e.message; } };
$('run').onclick = async () => { try { await api('/api/run', { count: Number($('run-n').value) }); await refresh(); } catch (e) { $('job').textContent = e.message; } };
refresh();
setInterval(() => { if (!editing) refresh(); }, S.job && S.job.running ? 4000 : 8000);

async function saveModel() {
  await api('/api/settings', { provider: $('m-provider').value, model: $('m-model').value, searchModel: $('m-search').value, baseUrl: $('m-base').value, apiKey: $('m-key').value });
  $('m-key').value = ''; await refresh();
}
$('m-save').onclick = async () => { try { await saveModel(); $('m-state').textContent = 'Saved'; } catch (e) { $('m-state').textContent = e.message; } };
$('m-test').onclick = async () => { try { await saveModel(); $('m-state').textContent = 'Testing'; const r = await api('/api/settings/test', {}); $('m-state').textContent = r.ok ? 'Works: ' + r.reply : 'Failed: ' + r.error; } catch (e) { $('m-state').textContent = e.message; } };
$('add-go').onclick = async () => { try { await api('/api/add', { name: $('add-name').value, website: $('add-site').value }); $('add-name').value = ''; $('add-site').value = ''; await refresh(); } catch (e) { $('job').textContent = e.message; } };
