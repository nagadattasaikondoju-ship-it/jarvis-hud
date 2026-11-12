import React, { useEffect, useState } from 'react';

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

export default function Settings({ open, tab: initialTab, cfg, setCfg, onClose, onTest, link, voices }) {
  const [tab, setTab] = useState(initialTab || 'link');
  const [draft, setDraft] = useState(cfg);
  useEffect(() => { if (open) { setDraft(cfg); setTab(initialTab || 'link'); } }, [open, initialTab]); // eslint-disable-line
  if (!open) return null;
  const origin = window.location.origin;
  const up = (k) => (e) => setDraft({ ...draft, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = () => { setCfg(draft); onTest(draft); };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__box frame">
        <div className="modal__head">
          <h2>SYSTEM CONFIGURATION</h2>
          <button className="btn btn--tiny" onClick={onClose} aria-label="Close">CLOSE ✕</button>
        </div>
        <div className="tabs" role="tablist">
          {['setup', 'link', 'persona', 'voice'].map((t) => (
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
                directly to OpenJarvis on <b>localhost</b>. Run these once on the computer you browse from.
              </p>
              <h3><span>01</span> Install OpenJarvis (+ Ollama &amp; a starter model)</h3>
              <p className="muted">macOS · Linux · WSL2</p>
              <Copy text="curl -fsSL https://open-jarvis.github.io/OpenJarvis/install.sh | bash" />
              <p className="muted">Windows PowerShell</p>
              <Copy text="irm https://open-jarvis.github.io/OpenJarvis/install.ps1 | iex" />

              <h3><span>02</span> Add the API server component</h3>
              <p className="muted">macOS · Linux · WSL2</p>
              <Copy text={'cd ~/.openjarvis/src && uv pip install --python ../.venv/bin/python -e ".[server]"'} />
              <p className="muted">Windows: nothing to do — the Windows installer already includes the server.</p>
              <p className="muted">Working from a git clone instead? Run <code>uv sync --extra server</code> inside it.</p>

              <h3><span>03</span> Start the core, allowing only this site</h3>
              <p className="muted">macOS · Linux · WSL2</p>
              <Copy text={`OPENJARVIS_CORS_ORIGINS=${origin} jarvis serve --port 8000`} />
              <p className="muted">Windows PowerShell</p>
              <Copy text={`$env:OPENJARVIS_CORS_ORIGINS="${origin}"; jarvis serve --port 8000`} />

              <h3><span>04</span> Connect</h3>
              <p>
                Press <b>TEST LINK</b> below. Chrome or Edge may ask to let this site access devices on your
                local network — choose <b>Allow</b>. Safari blocks secure sites from calling <code>localhost</code>; use Chrome, Edge, Brave or Firefox.
              </p>
              <button className="btn" onClick={() => onTest(draft)}>TEST LINK</button>
              <span className={`pill pill--${link.ok ? 'ok' : 'bad'}`} style={{ marginLeft: 12 }}>
                {link.ok ? `ONLINE · ${link.latency} ms` : 'OFFLINE'}
              </span>
              {!link.ok && link.error ? <p className="err">{link.error}</p> : null}

              <details className="alt">
                <summary>Alternative: talk to Ollama directly (no OpenJarvis agents)</summary>
                <Copy text={`OLLAMA_ORIGINS=${origin} ollama serve`} />
                <p className="muted">Then set LINK → Mode to “Ollama direct”. Quit any running Ollama app first so the setting applies.</p>
              </details>
            </div>
          )}

          {tab === 'link' && (
            <div className="form">
              <label>Mode
                <select value={draft.mode} onChange={up('mode')}>
                  <option value="openjarvis">OpenJarvis server (recommended)</option>
                  <option value="ollama">Ollama direct</option>
                </select>
              </label>
              {draft.mode === 'openjarvis' ? (
                <>
                  <label>OpenJarvis endpoint<input value={draft.endpoint} onChange={up('endpoint')} spellCheck={false} /></label>
                  <label>API key <span className="muted">(only if you set one on the server)</span>
                    <input type="password" value={draft.apiKey} onChange={up('apiKey')} autoComplete="off" />
                  </label>
                </>
              ) : (
                <label>Ollama endpoint<input value={draft.ollamaEndpoint} onChange={up('ollamaEndpoint')} spellCheck={false} /></label>
              )}
              <label>Model
                <select value={draft.model} onChange={up('model')}>
                  <option value="">Server default{link.defaultModel ? ` (${link.defaultModel})` : ''}</option>
                  {(link.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>Conversation memory (turns sent)
                <input type="number" min="0" max="50" value={draft.historyTurns} onChange={up('historyTurns')} />
              </label>
              <p className="muted">Settings and the conversation log are stored only in this browser.</p>
            </div>
          )}

          {tab === 'persona' && (
            <div className="form">
              <label>System prompt
                <textarea rows={9} value={draft.systemPrompt} onChange={up('systemPrompt')} />
              </label>
              <p className="muted">Leave empty to use OpenJarvis’ own agent prompt.</p>
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
              <p className="muted">
                Voices come from your operating system. The microphone uses your browser’s speech recognition
                (in Chrome this is processed by Google); typed commands never leave your machine.
              </p>
            </div>
          )}
        </div>

        {tab !== 'setup' && (
          <div className="modal__foot">
            <button className="btn btn--ghost" onClick={onClose}>CANCEL</button>
            <button className="btn" onClick={() => { save(); onClose(); }}>SAVE &amp; RECONNECT</button>
          </div>
        )}
      </div>
    </div>
  );
}
