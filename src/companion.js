// Client for Jarvis Companion — a tiny helper that runs on the user's PC
// (127.0.0.1:8765). It does web search with the user's own key and runs
// scheduled tasks in the background, even when the browser is closed.

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
  markRead: (cfg, id) => call(cfg, `/runs/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' }),
};

/** Format search results as numbered sources for the model. */
export function sourcesBlock(results, perSource = 1800) {
  return results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${(r.content || '').slice(0, perSource)}`).join('\n\n');
}
