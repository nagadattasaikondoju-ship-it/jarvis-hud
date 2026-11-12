// Link layer: talks from the browser straight to the user's own machine.
// Two modes:
//   openjarvis -> OpenJarvis OpenAI-compatible server (`jarvis serve`, :8000)
//   ollama     -> Ollama directly (:11434), no agent layer

export const DEFAULTS = {
  mode: 'openjarvis',
  endpoint: 'http://localhost:8000',
  ollamaEndpoint: 'http://localhost:11434',
  apiKey: '',
  model: '',
  systemPrompt:
    'You are JARVIS, a calm, precise and slightly witty personal AI running entirely on the user\'s own hardware. Be concise; use short paragraphs and lists. Never claim abilities you do not have.',
  voiceReply: true,
  voiceName: '',
  historyTurns: 12,
};

const trim = (u) => (u || '').replace(/\/+$/, '');
export const baseUrl = (cfg) => trim(cfg.mode === 'ollama' ? cfg.ollamaEndpoint : cfg.endpoint);

function headers(cfg, json = false) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (cfg.mode === 'openjarvis' && cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function getJSON(cfg, path, timeout = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(baseUrl(cfg) + path, { headers: headers(cfg), signal: ctl.signal });
    if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Check the link. Returns { ok, latency, engine, agent, defaultModel, models[], error } */
export async function probe(cfg) {
  const t0 = performance.now();
  try {
    if (cfg.mode === 'ollama') {
      const v = await getJSON(cfg, '/api/version');
      const latency = Math.round(performance.now() - t0);
      const tags = await getJSON(cfg, '/api/tags');
      const models = (tags.models || []).map((m) => m.name);
      return { ok: true, latency, engine: `ollama ${v.version || ''}`.trim(), agent: 'direct', defaultModel: models[0] || '', models };
    }
    await getJSON(cfg, '/health');
    const latency = Math.round(performance.now() - t0);
    const [info, models] = await Promise.all([
      getJSON(cfg, '/v1/info').catch(() => ({})),
      getJSON(cfg, '/v1/models').catch(() => ({ data: [] })),
    ]);
    return {
      ok: true,
      latency,
      engine: info.engine || 'openjarvis',
      agent: info.agent || '—',
      defaultModel: info.model || '',
      models: (models.data || []).map((m) => m.id),
    };
  } catch (e) {
    return { ok: false, latency: null, error: describeError(e, cfg) };
  }
}

export function describeError(e, cfg) {
  if (e?.name === 'AbortError') return `No answer from ${baseUrl(cfg)} (timed out).`;
  const msg = String(e?.message || e);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return `Cannot reach ${baseUrl(cfg)}. Either OpenJarvis is not running on this computer, or it is not allowing this site (CORS).`;
  }
  return msg;
}

export async function savings(cfg) {
  if (cfg.mode !== 'openjarvis') return null;
  try {
    return await getJSON(cfg, '/v1/savings', 5000);
  } catch {
    return null;
  }
}

/** Split a raw answer into visible text and <think> reasoning. */
export function splitThinking(raw) {
  let reasoning = '';
  let text = raw.replace(/<think>([\s\S]*?)<\/think>/g, (_, r) => {
    reasoning += r;
    return '';
  });
  const open = text.indexOf('<think>');
  if (open !== -1) {
    reasoning += text.slice(open + 7);
    text = text.slice(0, open);
  }
  return { text: text.replace(/^\s+/, ''), reasoning: reasoning.trim() };
}

/**
 * Stream a chat completion. Calls onDelta({content, reasoning}) per chunk.
 * Resolves with { usage: {completion_tokens, prompt_tokens} | null }.
 */
export async function streamChat(cfg, messages, model, onDelta, signal, onEvent) {
  const isOllama = cfg.mode === 'ollama';
  const url = baseUrl(cfg) + (isOllama ? '/api/chat' : '/v1/chat/completions');
  const body = isOllama
    ? { model, messages, stream: true, think: false }
    : { model: model || undefined, messages, stream: true };

  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: headers(cfg, true), body: JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(describeError(e, cfg));
  }
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Core returned HTTP ${r.status}${detail ? ` — ${detail}` : ''}`);
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let usage = null;

  const handleOllama = (line) => {
    const j = JSON.parse(line);
    if (j.error) throw new Error(j.error);
    const m = j.message || {};
    onDelta({ content: m.content || '', reasoning: m.thinking || '' });
    if (j.done) usage = { completion_tokens: j.eval_count || 0, prompt_tokens: j.prompt_eval_count || 0 };
  };
  let evName = null;
  const handleSSE = (line) => {
    if (line.startsWith('event:')) { evName = line.slice(6).trim(); return; }
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (evName) {
      const name = evName;
      evName = null;
      let payload = {};
      try { payload = JSON.parse(data); } catch { /* keep empty */ }
      onEvent?.(name, payload);
      return;
    }
    if (!data || data === '[DONE]') return;
    const j = JSON.parse(data);
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const d = j.choices?.[0]?.delta || {};
    onDelta({ content: d.content || '', reasoning: d.reasoning_content || d.reasoning || '' });
    if (j.usage) usage = j.usage;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        isOllama ? handleOllama(line) : handleSSE(line);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  if (buf.trim()) {
    try { isOllama ? handleOllama(buf.trim()) : handleSSE(buf.trim()); } catch { /* ignore tail */ }
  }
  return { usage };
}
