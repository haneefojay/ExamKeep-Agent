// One place that talks to a model provider. Gemini uses its own API (with Google Search for finding
// schools); every other provider here speaks the OpenAI chat format, so OpenAI, Groq, OpenRouter and
// any compatible service work from the same code. Settings come from the page first, then from env.

export const PROVIDERS = {
  gemini: { label: 'Google Gemini', model: 'gemini-3.8-flash', search: true },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: '' },
  custom: { label: 'Other (OpenAI-compatible)', base: '', model: '' },
};

// Page settings win over env. The key is never sent back to the page.
export function resolve(store, env) {
  const s = store.state.settings || {};
  const provider = PROVIDERS[s.provider] ? s.provider : (PROVIDERS[env.LLM_PROVIDER] ? env.LLM_PROVIDER : 'gemini');
  const p = PROVIDERS[provider];
  const key = s.apiKey || env.LLM_API_KEY || (provider === 'gemini' ? env.GEMINI_API_KEY : '');
  const model = s.model || env.LLM_MODEL || (provider === 'gemini' ? env.GEMINI_MODEL_DRAFT : '') || p.model;
  const base = provider === 'gemini'
    ? (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta')
    : (provider === 'custom' ? s.baseUrl : p.base);
  return { provider, key, model, base, canSearch: !!p.search };
}

export function validateSettings(b) {
  const out = {};
  if (b.provider !== undefined) {
    if (!PROVIDERS[b.provider]) throw new Error('Unknown provider');
    out.provider = b.provider;
  }
  if (typeof b.model === 'string') out.model = b.model.trim().slice(0, 120);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) out.apiKey = b.apiKey.trim().slice(0, 400);
  if (typeof b.baseUrl === 'string') {
    const u = b.baseUrl.trim();
    if (u) { let x; try { x = new URL(u); } catch { throw new Error('Base URL is not a valid address'); } if (x.protocol !== 'https:') throw new Error('Base URL must start with https://'); }
    out.baseUrl = u.replace(/\/+$/, '');
  }
  return out;
}

// Returns { text, inTok, outTok }. Throws plain-English errors.
export async function complete(cfg, prompt, { search = false } = {}) {
  if (!cfg.key) throw new Error('No API key set. Add one under Settings.');
  if (!cfg.model) throw new Error('No model set. Add one under Settings.');
  if (cfg.provider === 'gemini') {
    const res = await fetch(`${cfg.base}/models/${cfg.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], ...(search ? { tools: [{ google_search: {} }] } : {}) }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`${PROVIDERS.gemini.label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    const m = d.usageMetadata || {};
    return { text: (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join(''), inTok: m.promptTokenCount || 0, outTok: m.candidatesTokenCount || 0 };
  }
  if (search) throw new Error(`${PROVIDERS[cfg.provider].label} cannot search the web. Use Add a school, or switch to Gemini to find schools.`);
  if (!cfg.base) throw new Error('No base URL set. Add one under Settings.');
  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`${PROVIDERS[cfg.provider].label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return { text: d.choices?.[0]?.message?.content || '', inTok: d.usage?.prompt_tokens || 0, outTok: d.usage?.completion_tokens || 0 };
}
