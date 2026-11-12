import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Core from './components/Core.jsx';
import Waveform from './components/Waveform.jsx';
import Boot from './components/Boot.jsx';
import Message from './components/Message.jsx';
import Settings from './components/Settings.jsx';
import { DEFAULTS, probe, savings as fetchSavings, splitThinking, streamChat, baseUrl } from './api.js';

// ---------- persistence (per-browser conveniences; always guarded) ----------
const load = (k, d) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();
const fmtNum = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);

const PROTOCOLS = [
  { id: 'status', label: 'STATUS REPORT', prompt: 'Give me a short status report: who you are, that you run locally, and three things you can help me with right now.' },
  { id: 'brief', label: 'BRIEF ME', prompt: 'Summarise our conversation so far in three short bullet points, then suggest one next step.' },
  { id: 'plan', label: 'PLAN MY DAY', prompt: 'Help me plan my day. Ask me up to three quick questions first, then propose a schedule.' },
  { id: 'explain', label: 'EXPLAIN SIMPLY', prompt: 'Explain your last answer again in simpler words, with one everyday analogy.' },
];

function useClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => { const i = setInterval(() => setT(new Date()), 1000); return () => clearInterval(i); }, []);
  return t;
}

function Panel({ title, code, children, className = '' }) {
  return (
    <section className={`panel frame ${className}`}>
      <header className="panel__head"><span>{title}</span>{code ? <em>{code}</em> : null}</header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

function Row({ k, v, tone }) {
  return <div className="row"><span>{k}</span><b className={tone ? `tone-${tone}` : ''}>{v}</b></div>;
}

function Spark({ data }) {
  const pts = data.filter((d) => d != null);
  if (pts.length < 2) return <div className="spark spark--empty">awaiting samples</div>;
  const max = Math.max(...pts, 10);
  const w = 200, h = 40;
  const path = pts.map((d, i) => `${(i / (pts.length - 1)) * w},${h - (d / max) * (h - 4) - 2}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Link latency history">
      <polyline points={path} fill="none" />
    </svg>
  );
}

const stripMd = (s) => s.replace(/```[\s\S]*?```/g, ' code block omitted. ').replace(/[#*_`>|\-]{1,3}/g, ' ').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\s+/g, ' ').trim();

export default function App() {
  const [booted, setBooted] = useState(() => load('ojh.booted', false) && sessionStorageSafe());
  const [cfg, setCfgState] = useState(() => ({ ...DEFAULTS, ...load('ojh.cfg', {}) }));
  const [messages, setMessages] = useState(() => load('ojh.log', []));
  const [link, setLink] = useState({ ok: false, checking: true, models: [] });
  const [lat, setLat] = useState([]);
  const [sav, setSav] = useState(null);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState('');
  const [input, setInput] = useState('');
  const [settings, setSettings] = useState({ open: false, tab: 'link' });
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState([]);
  const [stats, setStats] = useState({ replies: 0, tokens: 0, tps: null, ttft: null });
  const abortRef = useRef(null);
  const logRef = useRef(null);
  const levelRef = useRef(0);
  const recRef = useRef(null);
  const micRef = useRef(null);
  const clock = useClock();

  const setCfg = (c) => { setCfgState(c); save('ojh.cfg', c); };
  useEffect(() => { save('ojh.log', messages.filter((m) => !m.pending).slice(-200)); }, [messages]);

  // ---------- link monitoring ----------
  const test = useCallback(async (c = cfg, announce = false) => {
    setLink((l) => ({ ...l, checking: true }));
    const r = await probe(c);
    setLink({ ...r, checking: false });
    setLat((a) => [...a.slice(-29), r.ok ? r.latency : null]);
    if (announce) {
      pushSys(
        r.ok
          ? `**Diagnostics complete.** Link to \`${baseUrl(c)}\` is up — ${r.latency} ms round trip. Engine **${r.engine}**, agent **${r.agent}**, ${r.models.length} model(s) available: ${r.models.map((m) => `\`${m}\``).join(', ') || 'none reported'}.`
          : `**Diagnostics failed.** ${r.error}`,
        r.ok ? 'ok' : 'warn'
      );
    }
    return r;
  }, [cfg]); // eslint-disable-line

  useEffect(() => {
    test(cfg);
  }, [cfg.mode, cfg.endpoint, cfg.ollamaEndpoint, cfg.apiKey]); // eslint-disable-line

  // Poll fast while offline so the HUD links up as soon as the core starts.
  useEffect(() => {
    const i = setInterval(() => test(cfg), link.ok ? 12000 : 3000);
    return () => clearInterval(i);
  }, [link.ok, cfg.mode, cfg.endpoint, cfg.ollamaEndpoint, cfg.apiKey]); // eslint-disable-line

  useEffect(() => {
    if (!link.ok || cfg.mode !== 'openjarvis') { setSav(null); return; }
    let live = true;
    const pull = async () => { const s = await fetchSavings(cfg); if (live) setSav(s); };
    pull();
    const i = setInterval(pull, 15000);
    return () => { live = false; clearInterval(i); };
  }, [link.ok, cfg.mode, cfg.endpoint, stats.replies]); // eslint-disable-line

  // ---------- voice out ----------
  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const fill = () => setVoices(window.speechSynthesis.getVoices());
    fill();
    window.speechSynthesis.onvoiceschanged = fill;
  }, []);

  const pickVoice = useCallback(() => {
    if (!voices.length) return null;
    if (cfg.voiceName) return voices.find((v) => v.name === cfg.voiceName) || null;
    const prefs = [/Google UK English Male/i, /Daniel/i, /Arthur/i, /en-GB.*Male/i, /Ryan/i, /en-GB/i, /en-US/i];
    for (const p of prefs) { const v = voices.find((x) => p.test(`${x.name} ${x.lang}`)); if (v) return v; }
    return voices[0];
  }, [voices, cfg.voiceName]);

  const speak = useCallback((text) => {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripMd(text).slice(0, 2500));
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = 1.02; u.pitch = 0.92;
    u.onstart = () => setSpeaking(true);
    u.onend = u.onerror = () => { setSpeaking(false); levelRef.current = 0; };
    u.onboundary = () => { levelRef.current = 0.55 + Math.random() * 0.4; };
    window.speechSynthesis.speak(u);
  }, [pickVoice]);

  const hush = () => { try { window.speechSynthesis.cancel(); } catch { /* none */ } setSpeaking(false); };

  // ---------- messages ----------
  const pushSys = (content, level) => setMessages((m) => [...m, { id: uid(), role: 'system', content, level, ts: now() }]);

  const send = useCallback(async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');
    hush();
    if (!link.ok) {
      const r = await test(cfg);
      if (!r.ok) {
        setMessages((m) => [...m, { id: uid(), role: 'user', content: q, ts: now() }]);
        pushSys(`Core is offline, so I could not send that. ${r.error} Open **SETUP** for the three commands that start it.`, 'warn');
        return;
      }
    }
    const userMsg = { id: uid(), role: 'user', content: q, ts: now() };
    const aiId = uid();
    const history = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && !m.error)
      .slice(-Number(cfg.historyTurns || 0) * 2)
      .map((m) => ({ role: m.role, content: m.content }));
    const payload = [
      ...(cfg.systemPrompt.trim() ? [{ role: 'system', content: cfg.systemPrompt.trim() }] : []),
      ...history,
      { role: 'user', content: q },
    ];
    setMessages((m) => [...m, userMsg, { id: aiId, role: 'assistant', content: '', reasoning: '', pending: true, ts: now() }]);
    setBusy(true);

    const model = cfg.model || link.defaultModel || '';
    const ctl = new AbortController();
    abortRef.current = ctl;
    const t0 = performance.now();
    let first = null;
    let raw = '';
    let rReason = '';
    const patch = (p) => setMessages((ms) => ms.map((m) => (m.id === aiId ? { ...m, ...p } : m)));
    try {
      const { usage } = await streamChat(cfg, payload, model, ({ content, reasoning }) => {
        if ((content || reasoning) && first == null) first = performance.now() - t0;
        raw += content; rReason += reasoning;
        const s = splitThinking(raw);
        if (s.text) levelRef.current = 0.35 + Math.random() * 0.45;
        patch({ content: s.text, reasoning: (rReason + (s.reasoning ? `\n${s.reasoning}` : '')).trim() });
      }, ctl.signal, (name, d) => {
        let line = null;
        if (name === 'tool_call_start') {
          let args = d.arguments;
          try { args = Object.values(typeof args === 'string' ? JSON.parse(args) : args || {}).join(' · '); } catch { /* raw */ }
          line = `▸ ${d.tool || 'tool'}${args ? ` — ${String(args).slice(0, 90)}` : ''}`;
          setActivity(`TOOL · ${(d.tool || '').toUpperCase()}`);
        } else if (name === 'tool_call_end') {
          line = `${d.success === false ? '✕' : '✓'} ${d.tool || 'tool'} ${d.success === false ? 'failed' : 'complete'}`;
          setActivity('SYNTHESISING');
        } else if (name === 'inference_start') {
          setActivity('INFERENCE');
        }
        if (line) setMessages((ms) => ms.map((m) => (m.id === aiId ? { ...m, steps: [...(m.steps || []), line] } : m)));
      });
      const secs = (performance.now() - t0 - (first || 0)) / 1000;
      const s = splitThinking(raw);
      const toks = usage?.completion_tokens || Math.max(1, Math.round((raw.length + rReason.length) / 4));
      const tps = secs > 0.05 ? toks / secs : null;
      patch({ pending: false, content: s.text || (rReason ? '_(The model only produced reasoning — expand the trace above.)_' : '_(empty reply)_'),
        stats: `${model || 'default'} · ${toks} tok${tps ? ` · ${tps.toFixed(1)} tok/s` : ''} · ${(first / 1000).toFixed(2)}s to first token` });
      setStats((st) => ({ replies: st.replies + 1, tokens: st.tokens + toks, tps, ttft: first }));
      if (cfg.voiceReply && s.text) speak(s.text);
    } catch (e) {
      if (e?.name === 'AbortError') patch({ pending: false, content: raw ? splitThinking(raw).text : '', error: 'Interrupted.' });
      else { patch({ pending: false, error: String(e.message || e) }); test(cfg); }
    } finally {
      setBusy(false);
      setActivity('');
      abortRef.current = null;
      levelRef.current = 0;
    }
  }, [input, busy, link, cfg, messages, speak, test]); // eslint-disable-line

  const stop = () => { abortRef.current?.abort(); hush(); };

  // ---------- voice in ----------
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const stopMic = () => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    micRef.current?.stream?.getTracks().forEach((t) => t.stop());
    micRef.current?.ctx?.close?.();
    micRef.current = null;
    setListening(false);
    levelRef.current = 0;
  };
  const startMic = async () => {
    if (!SR) { pushSys('Voice input is not supported in this browser. Chrome or Edge support it.', 'warn'); return; }
    hush();
    const rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      setInput((finalText + interim).trim());
    };
    rec.onerror = (ev) => { if (ev.error !== 'no-speech' && ev.error !== 'aborted') pushSys(`Microphone: ${ev.error}.`, 'warn'); };
    rec.onend = () => { stopMic(); if (finalText.trim()) send(finalText.trim()); };
    recRef.current = rec;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      micRef.current = { stream, ctx, an, buf };
    } catch { /* level meter optional */ }
    setListening(true);
    rec.start();
  };

  const getLevel = useCallback(() => {
    const m = micRef.current;
    if (m) {
      m.an.getByteTimeDomainData(m.buf);
      let s = 0;
      for (let i = 0; i < m.buf.length; i++) { const v = (m.buf[i] - 128) / 128; s += v * v; }
      return Math.min(1, Math.sqrt(s / m.buf.length) * 4);
    }
    levelRef.current *= 0.92;
    return levelRef.current;
  }, []);

  const [coreLevel, setCoreLevel] = useState(0);
  useEffect(() => { const i = setInterval(() => setCoreLevel(getLevel()), 90); return () => clearInterval(i); }, [getLevel]);

  // ---------- derived ----------
  const pendingMsg = messages.find((m) => m.pending);
  const coreState = !link.ok ? (link.checking && !link.error ? 'connecting' : 'offline')
    : listening ? 'listening'
    : busy && !(pendingMsg && pendingMsg.content) ? 'thinking'
    : busy || speaking ? 'speaking'
    : 'standby';
  const coreSub = !link.ok ? 'OPEN SETUP TO CONNECT' : activity && busy ? activity : (cfg.model || link.defaultModel || 'auto').toUpperCase();

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') stop(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []); // eslint-disable-line

  const exportLog = () => {
    const md = messages.map((m) => `### ${m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Jarvis' : 'System'} — ${new Date(m.ts).toLocaleString()}\n\n${m.content}\n`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = `jarvis-log-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const saved = useMemo(() => {
    if (!sav?.per_provider?.length) return null;
    const top = [...sav.per_provider].sort((a, b) => b.total_cost - a.total_cost)[0];
    return { top, tokens: sav.total_tokens, calls: sav.total_calls };
  }, [sav]);

  const finishBoot = useCallback(() => { setBooted(true); save('ojh.booted', true); try { sessionStorage.setItem('ojh.booted', '1'); } catch { /* ignore */ } }, []);

  return (
    <div className={`hud hud--${coreState}`}>
      <div className="bg-grid" aria-hidden="true" />
      <div className="bg-scan" aria-hidden="true" />
      {!booted && <Boot onDone={finishBoot} />}

      <header className="top">
        <div className="brand">
          <svg viewBox="0 0 32 32" className="brand__mark" aria-hidden="true">
            <circle cx="16" cy="16" r="13" /><circle cx="16" cy="16" r="6" /><path d="M16 1v6M16 25v6M1 16h6M25 16h6" />
          </svg>
          <div>
            <div className="brand__name">OPEN<b>JARVIS</b></div>
            <div className="brand__tag">PERSONAL AI · LOCAL CORE</div>
          </div>
        </div>
        <div className="top__mid">
          <span className={`pill pill--${link.ok ? 'ok' : 'bad'}`}>
            <i className="led" />{link.ok ? `LINK ${link.latency} ms` : link.checking ? 'LINKING…' : 'LINK OFFLINE'}
          </span>
          <span className="top__clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <span className="top__date">{clock.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()}</span>
        </div>
        <nav className="top__nav">
          <button className={`btn ${!link.ok ? 'btn--pulse' : 'btn--ghost'}`} onClick={() => setSettings({ open: true, tab: 'setup' })}>SETUP</button>
          <button className="btn btn--ghost" onClick={() => setSettings({ open: true, tab: 'link' })}>CONFIG</button>
        </nav>
      </header>

      <main className="grid">
        <aside className="col col--left">
          <Panel title="SYSTEMS" code="SYS-01">
            <Row k="Link" v={link.ok ? 'ONLINE' : 'OFFLINE'} tone={link.ok ? 'ok' : 'bad'} />
            <Row k="Mode" v={cfg.mode === 'ollama' ? 'OLLAMA DIRECT' : 'OPENJARVIS'} />
            <Row k="Endpoint" v={baseUrl(cfg).replace(/^https?:\/\//, '')} />
            <Row k="Engine" v={link.engine || '—'} />
            <Row k="Agent" v={link.agent || '—'} />
            <label className="row row--select">
              <span>Model</span>
              <select value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })} aria-label="Model">
                <option value="">default{link.defaultModel ? ` · ${link.defaultModel}` : ''}</option>
                {(link.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </Panel>
          <Panel title="LINK TELEMETRY" code="NET-02">
            <Spark data={lat} />
            <Row k="Round trip" v={link.ok ? `${link.latency} ms` : '—'} />
            <Row k="First token" v={stats.ttft ? `${(stats.ttft / 1000).toFixed(2)} s` : '—'} />
            <Row k="Throughput" v={stats.tps ? `${stats.tps.toFixed(1)} tok/s` : '—'} />
          </Panel>
          <Panel title="EFFICIENCY" code="PWR-03">
            {saved ? (
              <>
                <div className="big"><b>${saved.top.total_cost.toFixed(4)}</b><span>saved vs {saved.top.label}</span></div>
                <Row k="Local cost" v="$0.00" tone="ok" />
                <Row k="Tokens on-device" v={fmtNum(saved.tokens)} />
                <Row k="Cloud energy avoided" v={`${saved.top.energy_wh.toFixed(3)} Wh`} />
              </>
            ) : (
              <>
                <div className="big"><b>{fmtNum(stats.tokens)}</b><span>tokens generated this session</span></div>
                <p className="muted small">{cfg.mode === 'openjarvis' ? 'Savings readout appears once the core is online.' : 'Savings readout needs OpenJarvis mode.'}</p>
              </>
            )}
          </Panel>
        </aside>

        <section className="col col--center">
          <div className="stage">
            <Core state={coreState} sub={coreSub} level={coreLevel} />
            <Waveform getLevel={getLevel} state={coreState} />
          </div>

          <div className="log frame" ref={logRef} aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty">
                <p className="empty__hi">{greeting(clock)}.</p>
                <p>I think on your own machine — your conversations are not sent to a cloud AI model.</p>
                {!link.ok && (
                  <button className="btn" onClick={() => setSettings({ open: true, tab: 'setup' })}>CONNECT LOCAL CORE</button>
                )}
                <div className="chips">
                  {PROTOCOLS.slice(0, 3).map((p) => <button key={p.id} className="chip" onClick={() => send(p.prompt)}>{p.label}</button>)}
                </div>
              </div>
            ) : messages.map((m) => <Message key={m.id} m={m} onSpeak={speak} />)}
          </div>

          <form className="composer frame" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <button type="button" className={`mic ${listening ? 'mic--on' : ''}`} onClick={() => (listening ? stopMic() : startMic())}
              aria-label={listening ? 'Stop listening' : 'Speak a command'} title={listening ? 'Stop listening' : 'Speak a command'}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
            <textarea
              rows={1}
              value={input}
              placeholder={listening ? 'Listening…' : link.ok ? 'Give an instruction, or press the mic…' : 'Core offline — open SETUP to connect'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              aria-label="Message"
            />
            {busy || speaking ? (
              <button type="button" className="btn btn--warn" onClick={stop}>STOP</button>
            ) : (
              <button type="submit" className="btn" disabled={!input.trim()}>EXECUTE</button>
            )}
          </form>
        </section>

        <aside className="col col--right">
          <Panel title="PROTOCOLS" code="CMD-04">
            <div className="protos">
              {PROTOCOLS.map((p) => (
                <button key={p.id} className="proto" disabled={busy} onClick={() => send(p.prompt)}>
                  <span>{p.label}</span><i>▸</i>
                </button>
              ))}
              <button className="proto" onClick={() => test(cfg, true)}><span>RUN DIAGNOSTICS</span><i>▸</i></button>
            </div>
          </Panel>
          <Panel title="VOICE" code="AUD-05">
            <label className="toggle">
              <input type="checkbox" checked={cfg.voiceReply} onChange={(e) => { setCfg({ ...cfg, voiceReply: e.target.checked }); if (!e.target.checked) hush(); }} />
              <span>Speak replies</span>
            </label>
            <Row k="Voice" v={(pickVoice()?.name || 'system').slice(0, 22)} />
            <Row k="Mic" v={SR ? (listening ? 'LIVE' : 'READY') : 'UNSUPPORTED'} tone={listening ? 'ok' : undefined} />
            <button className="btn btn--ghost btn--block" onClick={() => setSettings({ open: true, tab: 'voice' })}>VOICE SETTINGS</button>
          </Panel>
          <Panel title="SESSION" code="LOG-06">
            <Row k="Replies" v={stats.replies} />
            <Row k="Entries in log" v={messages.length} />
            <div className="btnrow">
              <button className="btn btn--ghost" onClick={exportLog} disabled={!messages.length}>EXPORT</button>
              <button className="btn btn--ghost" onClick={() => { stop(); setMessages([]); }} disabled={!messages.length}>PURGE</button>
            </div>
          </Panel>
        </aside>
      </main>

      <footer className="foot">
        <span>INFERENCE: LOCAL · {baseUrl(cfg).replace(/^https?:\/\//, '')}</span>
        <span>ENTER execute · SHIFT+ENTER newline · ESC interrupt</span>
        <span>Built on <a href="https://github.com/open-jarvis/OpenJarvis" target="_blank" rel="noreferrer">OpenJarvis</a> · <a href="https://github.com/nagadattasaikondoju-ship-it/jarvis-hud" target="_blank" rel="noreferrer">Source</a></span>
      </footer>

      <Settings
        open={settings.open}
        tab={settings.tab}
        cfg={cfg}
        setCfg={setCfg}
        onClose={() => setSettings({ ...settings, open: false })}
        onTest={(c) => test(c)}
        link={link}
        voices={voices}
      />
    </div>
  );
}

function greeting(d) {
  const h = d.getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function sessionStorageSafe() {
  try { return sessionStorage.getItem('ojh.booted') === '1'; } catch { return false; }
}
