// Client for Jarvis Companion — a tiny helper that runs on the user's PC
// (127.0.0.1:8765). It does web search with the user's own key and runs
// scheduled tasks in the background, even when the browser is closed.
// Version 1.1+ also reports live system vitals and shows desktop notifications.

export const COMPANION_LATEST = '1.2.0';
export const companionHas = (comp, feature) => !!comp?.ok && Array.isArray(comp.features) && comp.features.includes(feature);

const H = { 'Content-Type': 'application/json', 'X-Jarvis': '1' };
const base = (cfg) => (cfg.companionUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');

async function call(cfg, path, opts = {}, timeout = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(base(cfg) + path, { ...opts, headers: H, signal: opts.signal || ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Companion returned HTTP ${r.status}`);
    return j;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Companion did not answer in time.');
    if (/Failed to fetch|NetworkError|Load failed/i.test(String(e?.message))) {
      throw new Error('Jarvis Companion is not running on this PC. Open SETUP → COMPANION to install or start it.');
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const companion = {
  health: (cfg) => call(cfg, '/health', {}, 2500),
  setConfig: (cfg, body) => call(cfg, '/config', { method: 'POST', body: JSON.stringify(body) }),
  search: (cfg, query, max = 6) => call(cfg, '/search', { method: 'POST', body: JSON.stringify({ query, max }) }, 30000),
  tasks: (cfg) => call(cfg, '/tasks'),
  saveTask: (cfg, task) => call(cfg, '/tasks', { method: 'POST', body: JSON.stringify(task) }),
  deleteTask: (cfg, id) => call(cfg, `/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  runTask: (cfg, id) => call(cfg, `/tasks/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' }),
  runs: (cfg) => call(cfg, '/runs'),
  run: (cfg, id) => call(cfg, `/runs/${encodeURIComponent(id)}`),
  system: (cfg) => call(cfg, '/system', {}, 6000),
  testNotify: (cfg) => call(cfg, '/notify/test', { method: 'POST', body: '{}' }, 25000),
  jobs: (cfg) => call(cfg, '/jobs'),
  installExtra: (cfg, name, opts = {}) => call(cfg, '/extras/install', { method: 'POST', body: JSON.stringify({ name, ...opts }) }),
  folders: (cfg) => call(cfg, '/folders', {}, 8000),
  addFolder: (cfg, path) => call(cfg, '/folders', { method: 'POST', body: JSON.stringify({ path }) }),
  removeFolder: (cfg, path) => call(cfg, '/folders/remove', { method: 'POST', body: JSON.stringify({ path }) }),
  reindex: (cfg) => call(cfg, '/folders/reindex', { method: 'POST', body: '{}' }),
  folderSearch: (cfg, query, k = 6) => call(cfg, '/folders/search', { method: 'POST', body: JSON.stringify({ query, k }) }, 60000),
  action: (cfg, action, args) => call(cfg, '/actions/run', { method: 'POST', body: JSON.stringify({ action, args }) }, 30000),
  voice: (cfg) => call(cfg, '/voice', {}, 5000),
  voiceConfig: (cfg, body) => call(cfg, '/voice/config', { method: 'POST', body: JSON.stringify(body) }),
  /** Speech to text on the user's PC. `wav` is a 16 kHz mono WAV Blob. */
  async stt(cfg, wav, { quick = false, lang = '' } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 90000);
    try {
      const q = new URLSearchParams({ ...(quick ? { quick: '1' } : {}), ...(lang ? { lang } : {}) });
      const r = await fetch(`${base(cfg)}/stt?${q}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Jarvis': '1' }, body: wav, signal: ctl.signal });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Speech recognition failed (HTTP ${r.status})`);
      return j;
    } finally { clearTimeout(t); }
  },
  /** Text to speech on the user's PC; resolves with a WAV Blob. */
  async tts(cfg, text, voice) {
    const r = await fetch(`${base(cfg)}/tts`, { method: 'POST', headers: H, body: JSON.stringify({ text, ...(voice ? { voice } : {}) }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `Voice failed (HTTP ${r.status})`); }
    return r.blob();
  },
  markRead: (cfg, id) => call(cfg, `/runs/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' }),
};

/** Format search results as numbered sources for the model. */
export function sourcesBlock(results, perSource = 1800) {
  return results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content || '').slice(0, perSource)}`).join('\n\n');
}
