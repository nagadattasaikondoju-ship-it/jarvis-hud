import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Core from './components/Core.jsx';
import Waveform from './components/Waveform.jsx';
import Boot from './components/Boot.jsx';
import Message from './components/Message.jsx';
import Settings from './components/Settings.jsx';
import Workspace from './components/Workspace.jsx';
import Scheduler from './components/Scheduler.jsx';
import ArtifactPanel, { extractHtml } from './components/ArtifactPanel.jsx';
import { DEFAULTS, probe, savings as fetchSavings, splitThinking, streamChat, baseUrl } from './api.js';
import * as store from './store.js';
import { ACCEPT, attachmentBlock, readFile } from './files.js';
import { MODES, DEFAULT_MODE_OPTS, WRITE_TYPES, TONES, LENGTHS, LANGUAGES, FILE_FORMATS, modeSystem, schemaFor } from './modes.js';
import { companion, sourcesBlock } from './companion.js';

// ---------- small persistence helpers (per-browser conveniences; always guarded) ----------
const load = (k, d) => {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

const uid = store.uid;
const now = () => Date.now();
const fmtNum = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
const CTX_STEPS = [4096, 8192, 16384, 32768, 65536];
const CHARS_PER_TOKEN = 3;

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

const stripMd = (s) => s.replace(/```[\s\S]*?```/g, ' code block omitted. ').replace(/[#*_`>|\-]{1,3}/g, ' ').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
const parseJson = (raw) => {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(t);
};
const REMEMBER = /^(?:please\s+)?remember(?:\s+that)?[\s,:]+(.{3,})$/i;
const STOP_WORDS = /^(stop|stop listening|goodbye|bye|exit|that's all|thats all)[.!]?$/i;

export default function App() {
  const [booted, setBooted] = useState(() => load('ojh.booted', false) && sessionStorageSafe());
  const [cfg, setCfgState] = useState(() => ({ ...DEFAULTS, ...load('ojh.cfg', {}) }));
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

  // workspace
  const [ready, setReady] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectIdState] = useState(() => load('ojh.project', null));
  const [projectFiles, setProjectFiles] = useState([]);
  const [chats, setChats] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [memory, setMemory] = useState([]);
  const [fileBusy, setFileBusy] = useState(false);
  const [atts, setAtts] = useState([]);
  const [mode, setMode] = useState(() => load('ojh.mode', 'chat'));
  const [modeOpts, setModeOpts] = useState(() => ({ ...DEFAULT_MODE_OPTS, ...load('ojh.modeOpts', {}) }));
  const [artifact, setArtifact] = useState(null);
  const [convo, setConvo] = useState(false);
  const [comp, setComp] = useState({ ok: false });
  const [unread, setUnread] = useState(0);
  const [leftTab, setLeftTab] = useState(() => load('ojh.leftTab', 'workspace'));
  const [drawer, setDrawer] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const abortRef = useRef(null);
  const logRef = useRef(null);
  const levelRef = useRef(0);
  const recRef = useRef(null);
  const micRef = useRef(null);
  const fileInRef = useRef(null);
  const convoRef = useRef(false);
  const emptyHeard = useRef(0);
  const sendRef = useRef(null);
  const startMicRef = useRef(null);
  const clock = useClock();

  const setCfg = (c) => { setCfgState(c); save('ojh.cfg', c); };
  const project = projects.find((p) => p.id === projectId) || null;
  const setProjectId = (id) => { setProjectIdState(id); save('ojh.project', id); };
  useEffect(() => { save('ojh.mode', mode); }, [mode]);
  useEffect(() => { save('ojh.modeOpts', modeOpts); }, [modeOpts]);
  useEffect(() => { save('ojh.leftTab', leftTab); }, [leftTab]);
  useEffect(() => { convoRef.current = convo; }, [convo]);

  const pushSys = (content, level) => setMessages((m) => [...m, { id: uid(), role: 'system', content, level, ts: now() }]);

  // ---------- load workspace from IndexedDB ----------
  useEffect(() => {
    (async () => {
      let [p, c, mem] = await Promise.all([store.get('projects', []), store.get('chats', []), store.get('memory', [])]);
      const legacy = load('ojh.log', null);
      if (legacy?.length && !c.length) {
        const id = uid();
        c = [{ id, title: legacy.find((m) => m.role === 'user')?.content?.slice(0, 48) || 'Earlier chat', projectId: null, updatedAt: now() }];
        await store.set(`chat:${id}`, legacy);
        await store.set('chats', c);
        try { localStorage.removeItem('ojh.log'); } catch { /* ignore */ }
      }
      setProjects(p); setChats(c); setMemory(mem);
      const last = load('ojh.chat', null);
      const pick = c.find((x) => x.id === last) || c.find((x) => (x.projectId || null) === (load('ojh.project', null) || null));
      if (pick) { setChatId(pick.id); setMessages(await store.get(`chat:${pick.id}`, [])); }
      setReady(true);
    })();
  }, []);

  // project files for the active project
  useEffect(() => {
    let live = true;
    (async () => {
      if (!project) { setProjectFiles([]); return; }
      const files = await Promise.all((project.fileIds || []).map((id) => store.get(`file:${id}`)));
      if (live) setProjectFiles(files.filter(Boolean));
    })();
    return () => { live = false; };
  }, [project?.id, project?.fileIds?.length]); // eslint-disable-line

  // persist the active chat whenever its messages settle
  useEffect(() => {
    if (!ready || !chatId) return;
    if (messages.some((m) => m.pending)) return;
    store.set(`chat:${chatId}`, messages.slice(-300));
    setChats((cs) => {
      const firstUser = messages.find((m) => m.role === 'user');
      const title = (firstUser?.content || firstUser?.attachments?.[0]?.name || 'New chat').replace(/\s+/g, ' ').slice(0, 48);
      const lastTs = messages.length ? messages[messages.length - 1].ts || 0 : 0;
      const next = cs.map((c) => (c.id === chatId ? { ...c, title: c.title && c.title !== 'New chat' ? c.title : title, updatedAt: Math.max(c.updatedAt || 0, lastTs) } : c));
      store.set('chats', next);
      return next;
    });
  }, [messages, chatId, ready]);

  const saveChats = (next) => { setChats(next); store.set('chats', next); };
  const saveProjects = (next) => { setProjects(next); store.set('projects', next); };
  const saveMemory = (next) => { setMemory(next); store.set('memory', next); };

  const newChat = useCallback((pid = projectId) => {
    const id = uid();
    const meta = { id, title: 'New chat', projectId: pid || null, updatedAt: now() };
    setChats((cs) => { const next = [meta, ...cs]; store.set('chats', next); return next; });
    setChatId(id); save('ojh.chat', id);
    setMessages([]);
    setDrawer(false);
    return id;
  }, [projectId]);

  const openChat = async (id) => {
    if (busy) abortRef.current?.abort();
    setChatId(id); save('ojh.chat', id);
    setMessages(await store.get(`chat:${id}`, []));
    setDrawer(false);
  };

  const deleteChat = async (id) => {
    await store.del(`chat:${id}`);
    const next = chats.filter((c) => c.id !== id);
    saveChats(next);
    if (id === chatId) { setChatId(null); setMessages([]); }
  };

  const visibleChats = chats.filter((c) => (c.projectId || null) === (projectId || null)).sort((a, b) => b.updatedAt - a.updatedAt);

  const switchProject = (id) => {
    setProjectId(id);
    const first = chats.filter((c) => (c.projectId || null) === (id || null)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (first) openChat(first.id); else { setChatId(null); setMessages([]); }
  };

  const createProject = (name) => {
    const p = { id: uid(), name, instructions: '', fileIds: [], createdAt: now() };
    saveProjects([...projects, p]);
    setProjectId(p.id);
    newChat(p.id);
  };
  const updateProject = (p) => saveProjects(projects.map((x) => (x.id === p.id ? p : x)));
  const deleteProject = async (id) => {
    const p = projects.find((x) => x.id === id);
    for (const f of p?.fileIds || []) await store.del(`file:${f}`);
    for (const c of chats.filter((x) => x.projectId === id)) await store.del(`chat:${c.id}`);
    saveChats(chats.filter((x) => x.projectId !== id));
    saveProjects(projects.filter((x) => x.id !== id));
    setProjectId(null); setChatId(null); setMessages([]);
  };

  const addProjectFiles = async (files) => {
    if (!project) return;
    setFileBusy(true);
    const ids = [];
    for (const f of files) {
      try { const a = await readFile(f); await store.set(`file:${a.id}`, a); ids.push(a.id); } catch (e) { pushSys(String(e.message || e), 'warn'); }
    }
    updateProject({ ...project, fileIds: [...(project.fileIds || []), ...ids] });
    setFileBusy(false);
  };
  const removeProjectFile = async (fid) => {
    await store.del(`file:${fid}`);
    updateProject({ ...project, fileIds: (project.fileIds || []).filter((x) => x !== fid) });
  };

  const addMemory = (text) => saveMemory([...memory, { id: uid(), text, ts: now() }]);
  const deleteMemory = (id) => saveMemory(memory.filter((m) => m.id !== id));

  // ---------- composer attachments ----------
  const attach = async (files) => {
    if (!files?.length) return;
    setFileBusy(true);
    for (const f of files) {
      if (f.size > 40e6) { pushSys(`${f.name} is larger than 40 MB — too big to read in the browser.`, 'warn'); continue; }
      try { const a = await readFile(f); setAtts((x) => [...x, a]); if (a.note) pushSys(`${a.name}: ${a.note}`, 'warn'); } catch (e) { pushSys(String(e.message || e), 'warn'); }
    }
    setFileBusy(false);
  };

  // ---------- link monitoring ----------
  const test = useCallback(async (c = cfg, announce = false) => {
    setLink((l) => ({ ...l, checking: true }));
    const r = await probe(c);
    setLink({ ...r, checking: false });
    setLat((a) => [...a.slice(-29), r.ok ? r.latency : null]);
    if (announce) {
      pushSys(
        r.ok
          ? `**Diagnostics complete.** Link to \`${baseUrl(c)}\` is up — ${r.latency} ms round trip. Engine **${r.engine}**, agent **${r.agent}**, ${r.models.length} model(s) available: ${r.models.map((m) => `\`${m}\``).join(', ') || 'none reported'}. Companion: **${comp.ok ? `online${comp.search_configured ? ', web search ready' : ', no search key yet'}` : 'not running'}**.`
          : `**Diagnostics failed.** ${r.error}`,
        r.ok ? 'ok' : 'warn'
      );
    }
    return r;
  }, [cfg, comp]); // eslint-disable-line

  useEffect(() => { test(cfg); }, [cfg.mode, cfg.endpoint, cfg.ollamaEndpoint, cfg.apiKey]); // eslint-disable-line
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

  // ---------- companion monitoring + sync ----------
  const checkCompanion = useCallback(async () => {
    try { const h = await companion.health(cfg); setComp({ ok: true, ...h }); } catch { setComp({ ok: false }); }
  }, [cfg]);
  useEffect(() => { checkCompanion(); const i = setInterval(checkCompanion, 15000); return () => clearInterval(i); }, [checkCompanion]);
  useEffect(() => {
    if (!comp.ok) return undefined;
    const t = setTimeout(() => {
      companion.setConfig(cfg, {
        model: cfg.model || link.defaultModel || undefined,
        systemPrompt: cfg.systemPrompt,
        memory: cfg.useMemory ? memory.map((m) => m.text) : [],
        ollamaUrl: cfg.ollamaEndpoint,
      }).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [comp.ok, cfg.model, cfg.systemPrompt, cfg.useMemory, cfg.ollamaEndpoint, link.defaultModel, memory]); // eslint-disable-line

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

  const speak = useCallback((text, after) => {
    if (!('speechSynthesis' in window) || !text) { after?.(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripMd(text).slice(0, 2500));
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = 1.02; u.pitch = 0.92;
    u.onstart = () => setSpeaking(true);
    u.onend = u.onerror = () => { setSpeaking(false); levelRef.current = 0; after?.(); };
    u.onboundary = () => { levelRef.current = 0.55 + Math.random() * 0.4; };
    window.speechSynthesis.speak(u);
  }, [pickVoice]);

  const hush = () => { try { window.speechSynthesis.cancel(); } catch { /* none */ } setSpeaking(false); };

  // ---------- building the conversation for the model ----------
  const buildSystem = (extra) => {
    const budget = (cfg.maxCtx || 16384) * CHARS_PER_TOKEN;
    const parts = [];
    if (cfg.systemPrompt.trim()) parts.push(cfg.systemPrompt.trim());
    parts.push(`Current date and time: ${new Date().toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })}.`);
    if (cfg.useMemory && memory.length) parts.push(`Things you know about the user (their saved memory):\n${memory.map((m) => `- ${m.text}`).join('\n')}`);
    if (project) {
      parts.push(`You are working inside the user's project "${project.name}".${project.instructions ? `\nProject instructions: ${project.instructions}` : ''}`);
      const textFiles = projectFiles.filter((f) => f.kind !== 'image');
      if (textFiles.length) {
        const per = Math.floor((budget * 0.35) / textFiles.length);
        parts.push(`Project reference files:\n${textFiles.map((f) => attachmentBlock(f, per)).join('\n\n')}`);
      }
    }
    if (extra) parts.push(extra);
    return parts.join('\n\n');
  };

  const send = useCallback(async (text, opts = {}) => {
    const q = (text ?? input).trim();
    const useMode = opts.mode || mode;
    const files = opts.keepAtts ? [] : atts;
    if ((!q && !files.length) || busy) return;
    setInput('');
    hush();
    let cid = chatId;
    if (!cid) cid = newChat();

    // "remember that …" — store locally, no model call needed
    const rem = REMEMBER.exec(q);
    if (rem && useMode === 'chat' && !files.length) {
      addMemory(rem[1].replace(/[.]$/, ''));
      setMessages((m) => [...m,
        { id: uid(), role: 'user', content: q, ts: now() },
        { id: uid(), role: 'assistant', content: `Noted. I'll remember: *${rem[1]}*. You can see or remove this under **WORKSPACE → MEMORY**.`, ts: now() }]);
      if (convoRef.current) speak('Noted. I will remember that.', () => startMicRef.current?.());
      return;
    }

    const isStructured = useMode === 'file' || useMode === 'dashboard';
    const ollamaReachable = link.ok || isStructured;
    if (!ollamaReachable) {
      const r = await test(cfg);
      if (!r.ok) {
        setMessages((m) => [...m, { id: uid(), role: 'user', content: q, ts: now() }]);
        pushSys(`Core is offline, so I could not send that. ${r.error} Open **SETUP** for the commands that start it.`, 'warn');
        return;
      }
    }

    const budget = (cfg.maxCtx || 16384) * CHARS_PER_TOKEN;
    const textAtts = files.filter((a) => a.kind !== 'image');
    const per = textAtts.length ? Math.floor((budget * 0.55) / textAtts.length) : 0;
    const images = files.filter((a) => a.kind === 'image').map((a) => a.image);
    const sentText = [q || (images.length ? 'Describe and analyse the attached image(s).' : 'Analyse the attached file(s).'), ...textAtts.map((a) => attachmentBlock(a, per))].join('\n\n');
    const modeInfo = MODES.find((x) => x.id === useMode);
    const modeLabel = useMode === 'chat' ? '' : useMode === 'write' ? `WRITE · ${modeOpts.writeType} · ${modeOpts.tone}` : useMode === 'translate' ? `TRANSLATE → ${modeOpts.language}` : useMode === 'file' ? `CREATE · ${FILE_FORMATS.find((f) => f.id === modeOpts.format)?.label}` : modeInfo?.label;
    const userMsg = {
      id: uid(), role: 'user', content: q, ts: now(), modeLabel, sentText,
      attachments: files.map(({ id, name, kind, size, thumb }) => ({ id, name, kind, size, thumb })),
      images: images.length ? images : undefined,
    };
    const aiId = uid();
    setAtts([]);
    setMessages((m) => [...m, userMsg, { id: aiId, role: 'assistant', content: '', reasoning: '', pending: true, ts: now(), modeLabel }]);
    setBusy(true);
    const patch = (p) => setMessages((ms) => ms.map((m) => (m.id === aiId ? { ...m, ...p } : m)));
    const addStep = (line) => setMessages((ms) => ms.map((m) => (m.id === aiId ? { ...m, steps: [...(m.steps || []), line] } : m)));

    const model = cfg.model || link.defaultModel || '';
    const ctl = new AbortController();
    abortRef.current = ctl;
    const t0 = performance.now();
    let first = null;
    let raw = '';
    let rReason = '';

    try {
      // research: gather sources through the Companion first
      let sources = null;
      let userContent = sentText;
      if (useMode === 'research') {
        if (!comp.ok) throw new Error('Web research needs Jarvis Companion running on your PC. Open SETUP → COMPANION.');
        if (!comp.search_configured) throw new Error('Add your search API key first: SETUP → COMPANION.');
        setActivity('TOOL · WEB_SEARCH');
        addStep(`▸ web_search — ${q.slice(0, 90)}`);
        const res = await companion.search(cfg, q, 6);
        sources = res.results || [];
        addStep(`✓ ${sources.length} sources found`);
        if (!sources.length) throw new Error('The search returned no results. Try different words.');
        userContent = `${sentText}\n\nWeb sources:\n${sourcesBlock(sources)}`;
        patch({ sources });
        setActivity('SYNTHESISING');
      }

      // history (trimmed to fit) + current message
      const system = buildSystem(modeSystem(useMode, modeOpts));
      const hist = [];
      if (!isStructured) {
        let room = budget - system.length - userContent.length - 6000;
        const prior = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && (m.content || m.sentText) && !m.error).slice(-Number(cfg.historyTurns || 0) * 2);
        for (let i = prior.length - 1; i >= 0 && room > 0; i--) {
          const c = prior[i].role === 'user' ? (prior[i].sentText || prior[i].content) : prior[i].content;
          if (c.length > room) break;
          hist.unshift({ role: prior[i].role, content: c });
          room -= c.length;
        }
      }
      const payload = [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...hist,
        { role: 'user', content: userContent, ...(images.length ? { images } : {}) },
      ];
      const chars = payload.reduce((n, m) => n + m.content.length, 0);
      const want = Math.ceil(chars / CHARS_PER_TOKEN) + (isStructured || useMode === 'artifact' ? 5000 : 2500) + images.length * 1200;
      const numCtx = Math.min(cfg.maxCtx || 16384, CTX_STEPS.find((s) => s >= want) || 65536);
      const extra = {
        numCtx,
        forceOllama: isStructured || images.length > 0,
        ...(isStructured ? { format: schemaFor(useMode, modeOpts), numPredict: 4096, temperature: 0.4 } : {}),
        ...(useMode === 'artifact' ? { numPredict: 6144 } : {}),
      };
      if (chars / CHARS_PER_TOKEN > numCtx * 0.85) addStep(`⚠ input is large for the current memory size (${numCtx.toLocaleString()} tokens) — raise CONFIG → Max context if answers miss details`);

      const { usage } = await streamChat(cfg, payload, model, ({ content, reasoning }) => {
        if ((content || reasoning) && first == null) first = performance.now() - t0;
        raw += content; rReason += reasoning;
        if (isStructured) {
          patch({ progress: `building ${useMode === 'dashboard' ? 'dashboard' : 'file'} · ${raw.length.toLocaleString()} characters` });
          return;
        }
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
        if (line) addStep(line);
      }, extra);

      const secs = (performance.now() - t0 - (first || 0)) / 1000;
      const toks = usage?.completion_tokens || Math.max(1, Math.round((raw.length + rReason.length) / 4));
      const tps = secs > 0.05 ? toks / secs : null;
      const statLine = `${model || 'default'} · ${toks} tok${tps ? ` · ${tps.toFixed(1)} tok/s` : ''} · ${((first || 0) / 1000).toFixed(2)}s to first token`;
      setStats((st) => ({ replies: st.replies + 1, tokens: st.tokens + toks, tps, ttft: first }));

      let spoken = '';
      if (useMode === 'file') {
        const spec = parseJson(raw);
        const { describeSpec } = await import('./exporters.js');
        const label = `${FILE_FORMATS.find((f) => f.id === modeOpts.format)?.label} · ${describeSpec(modeOpts.format, spec)}`;
        patch({ pending: false, progress: '', stats: statLine, content: `Created **${spec.title || 'your file'}** — ${label}. Click **DOWNLOAD** to save it.`, file: { format: modeOpts.format, spec, label } });
        spoken = `Your ${FILE_FORMATS.find((f) => f.id === modeOpts.format)?.label.split(' ')[0]} file is ready.`;
      } else if (useMode === 'dashboard') {
        const spec = parseJson(raw);
        patch({ pending: false, progress: '', stats: statLine, content: spec.summary || 'Dashboard ready.', dashboard: spec });
        setArtifact({ kind: 'dashboard', spec });
        spoken = spec.summary;
      } else {
        const s = splitThinking(raw);
        patch({ pending: false, stats: statLine, content: s.text || (rReason ? '_(The model only produced reasoning — expand the trace above.)_' : '_(empty reply)_') });
        const html = useMode === 'artifact' ? extractHtml(s.text) : null;
        if (html) setArtifact({ kind: 'html', html, title: q.slice(0, 60) });
        spoken = html ? 'Your artifact is ready.' : s.text;
      }
      if ((cfg.voiceReply || convoRef.current) && spoken) speak(spoken, () => { if (convoRef.current) startMicRef.current?.(); });
      else if (convoRef.current) startMicRef.current?.();
    } catch (e) {
      if (e?.name === 'AbortError') patch({ pending: false, progress: '', content: raw && !isStructured ? splitThinking(raw).text : '', error: 'Interrupted.' });
      else if (e instanceof SyntaxError) patch({ pending: false, progress: '', error: 'The model returned an incomplete result. Try again, ask for something shorter, or simplify the request.' });
      else { patch({ pending: false, progress: '', error: String(e.message || e) }); if (useMode !== 'research') test(cfg); }
      if (convoRef.current) speak('Sorry, something went wrong.', () => startMicRef.current?.());
    } finally {
      setBusy(false);
      setActivity('');
      abortRef.current = null;
      levelRef.current = 0;
    }
  }, [input, busy, link, cfg, messages, speak, test, atts, mode, modeOpts, chatId, comp, memory, project, projectFiles, newChat]); // eslint-disable-line
  sendRef.current = send;

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
    if (!SR) { pushSys('Voice input is not supported in this browser. Chrome or Edge support it.', 'warn'); setConvo(false); return; }
    if (recRef.current && listening) return;
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
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed') { pushSys('Microphone permission was blocked. Allow it from the icon left of the address bar.', 'warn'); setConvo(false); }
      else if (ev.error !== 'no-speech' && ev.error !== 'aborted') pushSys(`Microphone: ${ev.error}.`, 'warn');
    };
    rec.onend = () => {
      stopMic();
      recRef.current = null;
      const said = finalText.trim();
      if (said) {
        emptyHeard.current = 0;
        if (convoRef.current && STOP_WORDS.test(said)) { setConvo(false); setInput(''); speak('Conversation mode off.'); return; }
        sendRef.current?.(said);
      } else if (convoRef.current) {
        emptyHeard.current += 1;
        if (emptyHeard.current >= 3) { setConvo(false); emptyHeard.current = 0; pushSys('Conversation mode paused — I didn’t hear anything for a while.', 'ok'); }
        else setTimeout(() => startMicRef.current?.(), 250);
      }
    };
    recRef.current = rec;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      micRef.current = { stream, ctx, an, buf: new Uint8Array(an.fftSize) };
    } catch { /* level meter optional */ }
    setListening(true);
    try { rec.start(); } catch { /* already started */ }
  };
  startMicRef.current = startMic;

  const toggleConvo = () => {
    if (convo) { setConvo(false); convoRef.current = false; stopMic(); hush(); return; }
    setConvo(true); convoRef.current = true; emptyHeard.current = 0;
    speak('Conversation mode on. I am listening.', () => startMicRef.current?.());
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
  const coreSub = !link.ok ? 'OPEN SETUP TO CONNECT' : convo && !busy && !speaking ? 'CONVERSATION' : activity && busy ? activity : (cfg.model || link.defaultModel || 'auto').toUpperCase();

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape' && !artifact && !settings.open) { stop(); if (convoRef.current) { setConvo(false); stopMic(); } } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [artifact, settings.open]); // eslint-disable-line

  const exportLog = () => {
    const md = messages.map((m) => `### ${m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Jarvis' : 'System'} — ${new Date(m.ts).toLocaleString()}\n\n${m.content}\n`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = `jarvis-log-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const downloadFile = async (m) => {
    try {
      const { buildFile, download } = await import('./exporters.js');
      const { blob, name } = await buildFile(m.file.format, m.file.spec);
      download(blob, name);
    } catch (e) { pushSys(`Could not build the file: ${e.message || e}`, 'warn'); }
  };
  const exportAnswer = async (m, format) => {
    try {
      const { buildFile, download, markdownToDoc } = await import('./exporters.js');
      const { blob, name } = await buildFile(format, markdownToDoc(m.content.replace(/```html[\s\S]*?(```|$)/i, ''), 'Jarvis answer'));
      download(blob, name);
    } catch (e) { pushSys(`Export failed: ${e.message || e}`, 'warn'); }
  };

  const openRun = (r) => {
    const id = uid();
    const title = `⏰ ${r.task_name}`;
    const msgs = [
      { id: uid(), role: 'system', content: `Scheduled task **${r.task_name}** ran ${r.finished ? new Date(r.finished * 1000).toLocaleString() : ''}.`, level: r.status === 'error' ? 'warn' : 'ok', ts: now() },
      { id: uid(), role: 'assistant', content: r.output || '_(no output)_', sources: r.sources, modeLabel: 'SCHEDULED', ts: (r.finished || r.started) * 1000, error: r.status === 'error' ? 'The task failed — see the message above.' : undefined },
    ];
    const meta = { id, title, projectId: projectId || null, updatedAt: now() };
    setChats((cs) => { const next = [meta, ...cs]; store.set('chats', next); return next; });
    store.set(`chat:${id}`, msgs);
    setChatId(id); save('ojh.chat', id); setMessages(msgs);
  };

  const saved = useMemo(() => {
    if (!sav?.per_provider?.length) return null;
    const top = [...sav.per_provider].sort((a, b) => b.total_cost - a.total_cost)[0];
    return { top, tokens: sav.total_tokens, calls: sav.total_calls };
  }, [sav]);

  const finishBoot = useCallback(() => { setBooted(true); save('ojh.booted', true); try { sessionStorage.setItem('ojh.booted', '1'); } catch { /* ignore */ } }, []);
  const mo = (k) => (e) => setModeOpts({ ...modeOpts, [k]: e.target.value });
  const placeholder = listening ? 'Listening…'
    : !link.ok ? 'Core offline — open SETUP to connect'
    : mode === 'write' ? `Describe the ${modeOpts.writeType.toLowerCase()} you need…`
    : mode === 'translate' ? `Paste text to translate into ${modeOpts.language}…`
    : mode === 'file' ? `What should the ${FILE_FORMATS.find((f) => f.id === modeOpts.format)?.label.split(' ')[0]} file contain? Attach material if you have it…`
    : mode === 'dashboard' ? 'Attach a spreadsheet/CSV or paste numbers, then describe the dashboard…'
    : mode === 'artifact' ? 'Describe a diagram, chart, calculator or mini app…'
    : mode === 'research' ? 'Ask a question to research on the web…'
    : 'Give an instruction, attach a file, or press the mic…';

  return (
    <div className={`hud hud--${coreState}`}>
      <div className="bg-grid" aria-hidden="true" />
      <div className="bg-scan" aria-hidden="true" />
      {!booted && <Boot onDone={finishBoot} />}

      <header className="top">
        <div className="brand">
          <button className="drawer-btn" onClick={() => setDrawer(!drawer)} aria-label="Open workspace" aria-expanded={drawer}>☰</button>
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
          <span className={`pill pill--${comp.ok ? 'ok' : 'dim'}`} title="Jarvis Companion: web search + background tasks">
            <i className="led" />COMPANION{unread ? ` · ${unread} NEW` : ''}
          </span>
          <span className="top__clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>
        <nav className="top__nav">
          <button className={`btn ${!link.ok ? 'btn--pulse' : 'btn--ghost'}`} onClick={() => setSettings({ open: true, tab: 'setup' })}>SETUP</button>
          <button className="btn btn--ghost" onClick={() => setSettings({ open: true, tab: 'link' })}>CONFIG</button>
        </nav>
      </header>

      <main className={`grid ${drawer ? 'grid--drawer' : ''}`}>
        <aside className={`col col--left ${drawer ? 'col--open' : ''}`}>
          <div className="tabs tabs--side" role="tablist">
            {['workspace', 'systems'].map((t) => (
              <button key={t} role="tab" aria-selected={leftTab === t} className={`tab ${leftTab === t ? 'tab--on' : ''}`} onClick={() => setLeftTab(t)}>{t.toUpperCase()}</button>
            ))}
          </div>
          {leftTab === 'workspace' ? (
            <Workspace
              projects={projects} project={project} setProjectId={switchProject}
              chats={visibleChats} chatId={chatId} onNewChat={() => newChat()} onOpenChat={openChat} onDeleteChat={deleteChat}
              onCreateProject={createProject} onUpdateProject={updateProject} onDeleteProject={deleteProject}
              projectFiles={projectFiles} onAddProjectFiles={addProjectFiles} onRemoveProjectFile={removeProjectFile} fileBusy={fileBusy}
              memory={memory} useMemory={cfg.useMemory} setUseMemory={(v) => setCfg({ ...cfg, useMemory: v })} onAddMemory={addMemory} onDeleteMemory={deleteMemory}
            />
          ) : (
            <>
              <Panel title="SYSTEMS" code="SYS-01">
                <Row k="Link" v={link.ok ? 'ONLINE' : 'OFFLINE'} tone={link.ok ? 'ok' : 'bad'} />
                <Row k="Mode" v={cfg.mode === 'ollama' ? 'OLLAMA DIRECT' : 'OPENJARVIS'} />
                <Row k="Endpoint" v={baseUrl(cfg).replace(/^https?:\/\//, '')} />
                <Row k="Engine" v={link.engine || '—'} />
                <Row k="Agent" v={link.agent || '—'} />
                <Row k="Context" v={`${(cfg.maxCtx || 16384).toLocaleString()} tok`} />
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
                    <p className="muted small">Local cost: $0.00 — everything runs on your PC.</p>
                  </>
                )}
              </Panel>
            </>
          )}
        </aside>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}

        <section
          className={`col col--center ${dragOver ? 'col--drop' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); attach([...e.dataTransfer.files]); }}
        >
          <div className="stage">
            <Core state={coreState} sub={coreSub} level={coreLevel} />
            <Waveform getLevel={getLevel} state={coreState} />
          </div>

          <div className="log frame" ref={logRef} aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty">
                <p className="empty__hi">{greeting(clock)}.</p>
                <p>{project ? <>Project <b>{project.name}</b> — {projectFiles.length} file(s) loaded.</> : 'I think on your own machine — your conversations are not sent to a cloud AI model.'}</p>
                {!link.ok && (
                  <button className="btn" onClick={() => setSettings({ open: true, tab: 'setup' })}>CONNECT LOCAL CORE</button>
                )}
                <div className="chips">
                  <button className="chip" onClick={() => { setMode('write'); setModeOpts({ ...modeOpts, writeType: 'Email' }); setInput('A polite email to my manager asking for Friday off.'); }}>✍ WRITE AN EMAIL</button>
                  <button className="chip" onClick={() => { setMode('file'); setModeOpts({ ...modeOpts, format: 'pptx' }); setInput('A 6-slide presentation about the benefits of running AI locally.'); }}>▤ MAKE A DECK</button>
                  <button className="chip" onClick={() => { setMode('dashboard'); setInput('Monthly sales: Jan 120, Feb 135, Mar 160, Apr 150, May 190, Jun 210. Build a sales dashboard.'); }}>◩ BUILD A DASHBOARD</button>
                  <button className="chip" onClick={() => fileInRef.current?.click()}>⇪ ANALYSE A FILE</button>
                </div>
              </div>
            ) : messages.map((m) => (
              <Message key={m.id} m={m} onSpeak={(t) => speak(t)} onOpenArtifact={setArtifact} onDownloadFile={downloadFile} onExport={exportAnswer} />
            ))}
          </div>

          <div className="modebar" role="toolbar" aria-label="Jarvis mode">
            <div className="modebar__chips">
              {MODES.map((x) => (
                <button key={x.id} className={`mchip ${mode === x.id ? 'mchip--on' : ''} ${x.id === 'research' && !comp.ok ? 'mchip--dim' : ''}`} onClick={() => setMode(x.id)} title={x.hint} aria-pressed={mode === x.id}>{x.label}</button>
              ))}
            </div>
            {mode === 'write' && (
              <div className="modebar__opts">
                <select value={modeOpts.writeType} onChange={mo('writeType')} aria-label="Type">{WRITE_TYPES.map((v) => <option key={v}>{v}</option>)}</select>
                <select value={modeOpts.tone} onChange={mo('tone')} aria-label="Tone">{TONES.map((v) => <option key={v}>{v}</option>)}</select>
                <select value={modeOpts.length} onChange={mo('length')} aria-label="Length">{LENGTHS.map((v) => <option key={v}>{v}</option>)}</select>
              </div>
            )}
            {mode === 'translate' && (
              <div className="modebar__opts">
                <span className="muted small">into</span>
                <select value={modeOpts.language} onChange={mo('language')} aria-label="Target language">{LANGUAGES.map((v) => <option key={v}>{v}</option>)}</select>
              </div>
            )}
            {mode === 'file' && (
              <div className="modebar__opts">
                <select value={modeOpts.format} onChange={mo('format')} aria-label="File format">{FILE_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
              </div>
            )}
            {mode === 'research' && !comp.ok && (
              <div className="modebar__opts"><button className="btn btn--tiny" onClick={() => setSettings({ open: true, tab: 'companion' })}>SET UP COMPANION</button></div>
            )}
          </div>

          {atts.length > 0 && (
            <div className="atts atts--pending">
              {atts.map((a) => (
                <span className="att" key={a.id} title={a.name}>
                  {a.thumb ? <img src={a.thumb} alt="" /> : <i>{a.kind === 'pdf' ? 'PDF' : a.kind === 'sheet' ? 'XLS' : a.kind === 'docx' ? 'DOC' : 'TXT'}</i>}
                  <span>{a.name}</span>
                  <em>{a.kind === 'image' ? 'image' : `${(a.text || '').length.toLocaleString()} ch`}</em>
                  <button className="ws__x" onClick={() => setAtts(atts.filter((x) => x.id !== a.id))} aria-label={`Remove ${a.name}`}>×</button>
                </span>
              ))}
            </div>
          )}

          <form className="composer frame" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <button type="button" className={`mic ${listening ? 'mic--on' : ''}`} onClick={() => (listening ? stopMic() : startMic())}
              aria-label={listening ? 'Stop listening' : 'Speak a command'} title={listening ? 'Stop listening' : 'Speak a command'}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
            <button type="button" className="mic mic--clip" onClick={() => fileInRef.current?.click()} aria-label="Attach files" title="Attach PDF, Word, Excel, CSV, text or images" disabled={fileBusy}>
              {fileBusy ? <span className="spin" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15.5 7.5" /></svg>}
            </button>
            <input ref={fileInRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { attach([...e.target.files]); e.target.value = ''; }} />
            <textarea
              rows={1}
              value={input}
              placeholder={placeholder}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              onPaste={(e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); attach(f); } }}
              aria-label="Message"
            />
            {busy || speaking ? (
              <button type="button" className="btn btn--warn" onClick={stop}>STOP</button>
            ) : (
              <button type="submit" className="btn" disabled={!input.trim() && !atts.length}>EXECUTE</button>
            )}
          </form>
          {dragOver && <div className="dropzone">DROP FILES TO ATTACH</div>}
        </section>

        <aside className="col col--right">
          <Panel title="VOICE" code="AUD-05">
            <button className={`btn btn--block ${convo ? 'btn--live' : ''}`} style={{ marginTop: 0 }} onClick={toggleConvo} disabled={!SR}>
              {convo ? '■ END CONVERSATION' : '◉ CONVERSATION MODE'}
            </button>
            <p className="muted small">{convo ? 'Speak naturally. Say “stop” to end.' : 'Hands-free: Jarvis listens, answers aloud, then listens again.'}</p>
            <label className="toggle">
              <input type="checkbox" checked={cfg.voiceReply} onChange={(e) => { setCfg({ ...cfg, voiceReply: e.target.checked }); if (!e.target.checked) hush(); }} />
              <span>Speak replies</span>
            </label>
            <Row k="Voice" v={(pickVoice()?.name || 'system').slice(0, 22)} />
            <Row k="Mic" v={SR ? (listening ? 'LIVE' : 'READY') : 'UNSUPPORTED'} tone={listening ? 'ok' : undefined} />
          </Panel>
          <Scheduler cfg={cfg} online={comp.ok} onOpenRun={openRun} onSetup={() => setSettings({ open: true, tab: 'companion' })} onUnread={setUnread} />
          <Panel title="PROTOCOLS" code="CMD-04">
            <div className="protos">
              {PROTOCOLS.map((p) => (
                <button key={p.id} className="proto" disabled={busy} onClick={() => send(p.prompt, { mode: 'chat', keepAtts: true })}>
                  <span>{p.label}</span><i>▸</i>
                </button>
              ))}
              <button className="proto" onClick={() => test(cfg, true)}><span>RUN DIAGNOSTICS</span><i>▸</i></button>
            </div>
          </Panel>
          <Panel title="SESSION" code="LOG-06">
            <Row k="Replies" v={stats.replies} />
            <Row k="Entries in chat" v={messages.length} />
            <div className="btnrow">
              <button className="btn btn--ghost" onClick={exportLog} disabled={!messages.length}>EXPORT</button>
              <button className="btn btn--ghost" onClick={() => { stop(); setMessages([]); }} disabled={!messages.length}>CLEAR</button>
            </div>
          </Panel>
        </aside>
      </main>

      <footer className="foot">
        <span>INFERENCE: LOCAL · {baseUrl(cfg).replace(/^https?:\/\//, '')}</span>
        <span>ENTER execute · SHIFT+ENTER newline · ESC interrupt · drop files to attach</span>
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
        comp={comp}
        onCompanionRefresh={checkCompanion}
      />
      <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />
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
