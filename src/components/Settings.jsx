import React, { useEffect, useState } from 'react';
import { companion, companionHas, COMPANION_LATEST } from '../companion.js';
import { installOnDevice, onDeviceStatus } from '../wake.js';

const older = (a, b) => {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
};

function Copy({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        className="btn btn--tiny"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1400);
          });
        }}
      >
        {ok ? 'COPIED' : 'COPY'}
      </button>
    </div>
  );
}

function CompanionTab({ cfg, setCfg, comp, onRefresh, origin }) {
  const [provider, setProvider] = useState(comp.search_provider || 'tavily');
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [nMsg, setNMsg] = useState('');
  const canNotify = companionHas(comp, 'notify');
  const outdated = comp.ok && older(comp.version, COMPANION_LATEST);
  const setNotify = async (on) => {
    setNMsg('');
    try { await companion.setConfig(cfg, { notify: on }); onRefresh(); } catch (e) { setNMsg(`✕ ${e.message}`); }
  };
  const testNotify = async () => {
    setNMsg('Sending…');
    try { await companion.testNotify(cfg); setNMsg('✓ Sent — look at the bottom-right corner of your screen.'); } catch (e) { setNMsg(`✕ ${e.message}`); }
  };
  const saveKey = async () => {
    setMsg('Saving…');
    try {
      await companion.setConfig(cfg, { searchProvider: provider, searchKey: key });
      setKey('');
      setMsg('Saved on your PC. Testing a search…');
      const r = await companion.search(cfg, 'latest technology news', 2);
      setMsg(`✓ Search works — ${r.results.length} result(s) received.`);
      onRefresh();
    } catch (e) { setMsg(`✕ ${e.message}`); onRefresh(); }
  };
  return (
    <div className="setup">
      <p className="lead">
        <b>Jarvis Companion</b> is a tiny helper that runs on your PC. It lets Jarvis <b>search the web</b> with your own free search key
        and run <b>scheduled tasks in the background</b> — even when this browser is closed. It uses the Python already on your PC.
      </p>
      <p>
        Status: <span className={`pill pill--${comp.ok ? 'ok' : 'bad'}`}>{comp.ok ? `RUNNING · v${comp.version}` : 'NOT RUNNING'}</span>{' '}
        {comp.ok && <span className={`pill pill--${comp.search_configured ? 'ok' : 'bad'}`}>{comp.search_configured ? `SEARCH READY · ${comp.search_provider}` : 'NO SEARCH KEY'}</span>}
      </p>
      {outdated ? (
        <div className="notice">
          <b>Update available — v{COMPANION_LATEST}.</b> Adds live CPU / GPU / battery vitals and desktop notifications.
          Run the install command below again in PowerShell; it replaces the old version and keeps your search key and tasks.
        </div>
      ) : null}

      <h3><span>01</span> Install (one time)</h3>
      <p className="muted">Windows PowerShell — no admin needed. It starts automatically every time you sign in.</p>
      <Copy text={`irm ${origin}/companion/install.ps1 | iex`} />
      <p className="muted">macOS · Linux</p>
      <Copy text={`curl -fsSL ${origin}/companion/jarvis_companion.py -o ~/jarvis_companion.py && python3 ~/jarvis_companion.py`} />

      <h3><span>02</span> Add your free search key</h3>
      <p>
        Create a free account and copy your API key:{' '}
        <a href="https://app.tavily.com" target="_blank" rel="noreferrer">Tavily</a> (recommended — built for AI assistants) or{' '}
        <a href="https://api-dashboard.search.brave.com" target="_blank" rel="noreferrer">Brave Search API</a>.
        The key is saved only in <code>%LOCALAPPDATA%\JarvisCompanion\config.json</code> on your PC — never on this website.
      </p>
      <div className="form">
        <label>Search provider
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="tavily">Tavily</option>
            <option value="brave">Brave Search</option>
          </select>
        </label>
        <label>API key
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={comp.search_configured ? '•••••••• (saved — paste a new one to replace)' : 'tvly-… or BSA…'} autoComplete="off" spellCheck={false} />
        </label>
        <div className="btnrow">
          <button className="btn" disabled={!comp.ok || !key.trim()} onClick={saveKey}>SAVE KEY &amp; TEST</button>
          <button className="btn btn--ghost" onClick={onRefresh}>CHECK STATUS</button>
        </div>
        {msg ? <p className={msg.startsWith('✕') ? 'err' : 'muted'}>{msg}</p> : null}
      </div>

      <h3><span>03</span> Notifications</h3>
      {canNotify ? (
        <div className="form">
          <label className="check"><input type="checkbox" checked={comp.notify !== false} onChange={(e) => setNotify(e.target.checked)} /> Show a desktop notification when a scheduled task finishes (works even when this browser is closed)</label>
          <div className="btnrow"><button className="btn btn--ghost" onClick={testNotify}>SEND TEST NOTIFICATION</button></div>
          {nMsg ? <p className={nMsg.startsWith('✕') ? 'err' : 'muted'}>{nMsg}</p> : null}
          <p className="muted">Clicking a notification opens that result in Jarvis. On Windows the notification is shown by Windows PowerShell; if nothing appears, check <b>Settings → System → Notifications</b> and Focus / Do not disturb.</p>
        </div>
      ) : <p className="muted">{comp.ok ? 'Update the Companion (step 01) to get desktop notifications.' : 'Install the Companion first.'}</p>}

      <h3><span>04</span> Use it</h3>
      <p>
        In normal chat, Jarvis <b>searches automatically</b> when you ask for current information — “latest news about ISRO”,
        “weather in Hyderabad today”, “search the web for …”. You can also pick <b>RESEARCH</b> above the message box for cited web answers,
        and use the <b>SCHEDULER</b> panel for tasks like a daily morning briefing.
      </p>
      <label className="check"><input type="checkbox" checked={cfg.autoResearch !== false} onChange={(e) => setCfg({ ...cfg, autoResearch: e.target.checked })} /> Search the web automatically when a chat message needs current information</label>
      <details className="alt">
        <summary>Uninstall</summary>
        <p className="muted">In PowerShell run <code>Remove-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run JarvisCompanion</code> (and delete “Jarvis Companion” from <code>shell:startup</code> if it is there), then delete the folder <code>%LOCALAPPDATA%\JarvisCompanion</code> and restart your PC.</p>
      </details>
    </div>
  );
}

export default function Settings({ open, tab: initialTab, cfg, setCfg, onClose, onTest, link, voices, comp, onCompanionRefresh, install, speechLocal, setSpeechLocal, brainPair }) {
  const [dl, setDl] = useState('');
  const [tab, setTab] = useState(initialTab || 'link');
  const [draft, setDraft] = useState(cfg);
  useEffect(() => { if (open) { setDraft(cfg); setTab(initialTab || 'link'); } }, [open, initialTab]); // eslint-disable-line
  if (!open) return null;
  const origin = window.location.origin;
  const up = (k) => (e) => setDraft({ ...draft, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' || k === 'maxCtx' ? Number(e.target.value) : e.target.value });
  const save = () => { setCfg(draft); onTest(draft); };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__box frame">
        <div className="modal__head">
          <h2>SYSTEM CONFIGURATION</h2>
          <button className="btn btn--tiny" onClick={onClose} aria-label="Close">CLOSE ✕</button>
        </div>
        <div className="tabs" role="tablist">
          {['setup', 'companion', 'link', 'persona', 'voice'].map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab--on' : ''}`} onClick={() => setTab(t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="modal__body">
          {tab === 'setup' && (
            <div className="setup">
              <p className="lead">
                This interface is hosted on Vercel, but the AI never leaves your computer: your browser talks
                directly to Ollama or OpenJarvis on <b>localhost</b>. Run these once on the computer you browse from.
              </p>

              <h3><span>A</span> Light setup — Ollama (≈5 GB, recommended)</h3>
              <p className="muted">Windows PowerShell, one line at a time</p>
              <Copy text="winget install Ollama.Ollama" />
              <Copy text="ollama pull qwen3.5:2b" />
              <Copy text={`setx OLLAMA_ORIGINS "${origin}"`} />
              <Copy text={`$env:OLLAMA_ORIGINS="${origin}"; Stop-Process -Name "ollama*" -Force -ErrorAction SilentlyContinue; Start-Sleep 2; Start-Process "$env:LOCALAPPDATA\\Programs\\Ollama\\ollama app.exe"`} />
              <p className="muted">macOS · Linux: install from ollama.com, then</p>
              <Copy text={`OLLAMA_ORIGINS=${origin} ollama serve`} />
              <p className="muted">Then set <b>LINK → Mode → Ollama direct</b>.</p>

              <details className="alt">
                <summary>Full setup — OpenJarvis agents (≈20 GB on Windows)</summary>
                <p className="muted">macOS · Linux · WSL2</p>
                <Copy text="curl -fsSL https://open-jarvis.github.io/OpenJarvis/install.sh | bash" />
                <Copy text={'cd ~/.openjarvis/src && uv pip install --python ../.venv/bin/python -e ".[server]"'} />
                <Copy text={`OPENJARVIS_CORS_ORIGINS=${origin} jarvis serve --port 8000`} />
                <p className="muted">Windows PowerShell (needs Microsoft C++ Build Tools first)</p>
                <Copy text="irm https://open-jarvis.github.io/OpenJarvis/install.ps1 | iex" />
                <Copy text={`$env:OPENJARVIS_CORS_ORIGINS="${origin}"; jarvis serve --port 8000`} />
              </details>

              <h3><span>✓</span> Connect</h3>
              <p>
                Press <b>TEST LINK</b>. Chrome or Edge may ask to let this site access devices on your
                local network — choose <b>Allow</b>. Safari blocks secure sites from calling <code>localhost</code>; use Chrome, Edge, Brave or Firefox.
              </p>
              <button className="btn" onClick={() => onTest(draft)}>TEST LINK</button>
              <span className={`pill pill--${link.ok ? 'ok' : 'bad'}`} style={{ marginLeft: 12 }}>
                {link.ok ? `ONLINE · ${link.latency} ms` : 'OFFLINE'}
              </span>
              {!link.ok && link.error ? <p className="err">{link.error}</p> : null}

              <h3><span>⇩</span> Install as an app (optional)</h3>
              <p>
                Gives Jarvis its own window, a desktop / Start-menu icon and a badge for new scheduled results.
                The interface keeps loading even when your internet is down — the AI already runs on your PC.
              </p>
              {install?.installed ? <p className="muted">✓ You are using the installed app.</p>
                : install?.canInstall ? <button className="btn" onClick={install.install}>INSTALL JARVIS</button>
                : <p className="muted">In Chrome or Edge, click the install icon at the right end of the address bar (or menu ⋮ → <b>Cast, save and share → Install page as app</b> in Chrome, <b>Apps → Install this site as an app</b> in Edge).</p>}
            </div>
          )}

          {tab === 'companion' && <CompanionTab cfg={cfg} setCfg={setCfg} comp={comp} onRefresh={onCompanionRefresh} origin={origin} />}

          {tab === 'link' && (
            <div className="form">
              <label>Mode
                <select value={draft.mode} onChange={up('mode')}>
                  <option value="ollama">Ollama direct</option>
                  <option value="openjarvis">OpenJarvis server (agents)</option>
                </select>
              </label>
              {draft.mode === 'openjarvis' ? (
                <>
                  <label>OpenJarvis endpoint<input value={draft.endpoint} onChange={up('endpoint')} spellCheck={false} /></label>
                  <label>API key <span className="muted">(only if you set one on the server)</span>
                    <input type="password" value={draft.apiKey} onChange={up('apiKey')} autoComplete="off" />
                  </label>
                </>
              ) : null}
              <label>Ollama endpoint <span className="muted">(also used for images, files and dashboards)</span>
                <input value={draft.ollamaEndpoint} onChange={up('ollamaEndpoint')} spellCheck={false} />
              </label>
              <label>Model
                <select value={draft.model} onChange={up('model')}>
                  <option value="">Server default{link.defaultModel ? ` (${link.defaultModel})` : ''}</option>
                  {(link.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              {draft.mode === 'ollama' ? (
                <>
                  <label>Model choice <span className="muted">(also on the main screen, next to the modes)</span>
                    <select value={draft.brain || 'manual'} onChange={up('brain')}>
                      <option value="manual">Always use the model above</option>
                      <option value="auto">AUTO — fast model for quick chat and voice, smart model for everything else</option>
                      <option value="fast">FAST — always the fast model</option>
                      <option value="smart">SMART — always the smart model</option>
                    </select>
                  </label>
                  <label>Fast model
                    <select value={draft.fastModel || ''} onChange={up('fastModel')}>
                      <option value="">Smallest installed{brainPair?.fast && !draft.fastModel ? ` (${brainPair.fast})` : ''}</option>
                      {(link.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  <label>Smart model
                    <select value={draft.smartModel || ''} onChange={up('smartModel')}>
                      <option value="">Largest installed{brainPair?.smart && !draft.smartModel ? ` (${brainPair.smart})` : ''}</option>
                      {(link.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </label>
                  <p className="muted">If your graphics card has little memory (4 GB or less), switching between two models takes a few seconds each time while the other one loads.</p>
                </>
              ) : null}
              <label>Max context — how much text Jarvis can read at once
                <select value={draft.maxCtx || 16384} onChange={up('maxCtx')}>
                  <option value={4096}>4,096 tokens — lowest memory use</option>
                  <option value={8192}>8,192 tokens — ~6 pages</option>
                  <option value={16384}>16,384 tokens — ~12 pages (default)</option>
                  <option value={32768}>32,768 tokens — ~25 pages, needs more RAM</option>
                  <option value={65536}>65,536 tokens — ~50 pages, 16 GB+ RAM</option>
                </select>
              </label>
              <label>Conversation memory (turns sent)
                <input type="number" min="0" max="50" value={draft.historyTurns} onChange={up('historyTurns')} />
              </label>
              <label>Jarvis Companion address
                <input value={draft.companionUrl} onChange={up('companionUrl')} spellCheck={false} />
              </label>
              <p className="muted">Settings, chats, projects and memory are stored only in this browser.</p>
            </div>
          )}

          {tab === 'persona' && (
            <div className="form">
              <label>System prompt
                <textarea rows={9} value={draft.systemPrompt} onChange={up('systemPrompt')} />
              </label>
              <p className="muted">Leave empty to use OpenJarvis’ own agent prompt. Your saved memory and project instructions are added automatically.</p>
            </div>
          )}

          {tab === 'voice' && (
            <div className="form">
              <label className="check"><input type="checkbox" checked={draft.voiceReply} onChange={up('voiceReply')} /> Speak replies aloud</label>
              <label>Voice
                <select value={draft.voiceName} onChange={up('voiceName')}>
                  <option value="">Automatic (prefers a British English voice)</option>
                  {voices.map((v) => <option key={v.name} value={v.name}>{v.name} — {v.lang}</option>)}
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={!!draft.wakeWord} onChange={up('wakeWord')} /> Wake word — say “Jarvis …” without clicking the mic</label>
              <p className="muted">
                Keep this tab or the installed app open. Say <b>“Jarvis, what’s the weather like for a walk?”</b> in one go, or say <b>“Jarvis”</b>,
                wait for the chime, then speak. It pauses while Jarvis is thinking or talking.
              </p>
              <p className="muted">
                Speech recognition: <b>{speechLocal === 'available' ? 'on this PC (private)' : speechLocal === 'downloadable' || speechLocal === 'downloading' ? 'browser service — an on-device model can be downloaded' : 'your browser’s speech service'}</b>.
                {speechLocal !== 'available' ? ' While the wake word is on, the microphone audio is sent to that service (Google for Chrome, Microsoft for Edge) to find the word “Jarvis”. Turn it off when you want full privacy.' : ''}
              </p>
              {speechLocal === 'unknown' ? (
                <div className="btnrow">
                  <button className="btn btn--ghost" onClick={async () => {
                    setDl('Checking…');
                    const r = await onDeviceStatus(navigator.language || 'en-US');
                    setSpeechLocal?.(r);
                    setDl(r === 'available' ? '✓ On-device speech is available and now in use.' : r === 'downloadable' ? 'Your browser can download on-device speech — use the button below.' : 'This browser does not offer on-device speech yet.');
                  }}>CHECK FOR ON-DEVICE SPEECH</button>
                </div>
              ) : null}
              {speechLocal === 'downloadable' ? (
                <div className="btnrow">
                  <button className="btn btn--ghost" onClick={async () => {
                    setDl('Downloading…');
                    const ok = await installOnDevice(navigator.language || 'en-US');
                    setDl(ok ? '✓ Installed. Speech now stays on this PC.' : '✕ The browser could not install it.');
                    if (ok) setSpeechLocal?.('available');
                  }}>DOWNLOAD ON-DEVICE SPEECH</button>
                </div>
              ) : null}
              {dl ? <p className={dl.startsWith('✕') ? 'err' : 'muted'}>{dl}</p> : null}
              <p className="muted">
                Voices come from your operating system. The microphone uses your browser’s speech recognition
                (in Chrome and Edge this is processed by Google or Microsoft); typed messages never leave your machine.
              </p>
            </div>
          )}
        </div>

        {tab !== 'setup' && tab !== 'companion' && (
          <div className="modal__foot">
            <button className="btn btn--ghost" onClick={onClose}>CANCEL</button>
            <button className="btn" onClick={() => { save(); onClose(); }}>SAVE &amp; RECONNECT</button>
          </div>
        )}
      </div>
    </div>
  );
}
