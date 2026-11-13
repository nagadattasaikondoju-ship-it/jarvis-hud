import React, { useEffect, useState } from 'react';
import { companion, companionHas } from '../companion.js';

const STATE = {
  listening: 'LISTENING', awake: 'AWAKE', recording: 'HEARING YOU', transcribing: 'UNDERSTANDING', paused: 'PAUSED',
  off: 'OFF', error: 'PROBLEM', 'not set up': 'NOT SET UP',
};

/** CONFIG → VOICE: “Hey Jarvis”, always on, handled by the Companion so it works with no window open. */
export default function HeyJarvisSetup({ cfg, comp, voiceReady, onStatus }) {
  const [st, setSt] = useState(null);
  const [msg, setMsg] = useState('');
  const has = companionHas(comp, 'hotword');
  const running = st?.job?.state === 'running';

  const refresh = async () => { try { const s = await companion.hotword(cfg); setSt(s); onStatus?.(s); } catch (e) { setMsg(`✕ ${e.message}`); } };
  useEffect(() => { if (has) refresh(); }, [has]); // eslint-disable-line
  useEffect(() => {
    if (!has) return undefined;
    const i = setInterval(refresh, running ? 1500 : 4000);
    return () => clearInterval(i);
  }, [has, running]); // eslint-disable-line

  if (!has) return <p className="muted">“Hey Jarvis” with Jarvis closed needs <b>Jarvis Companion 1.3</b>. Open <b>SETUP → COMPANION</b> and run the install command again to update it.</p>;
  if (!st) return <p className="muted">Checking “Hey Jarvis”…</p>;

  const set = async (body) => { setMsg(''); try { const s = await companion.hotwordConfig(cfg, body); setSt(s); onStatus?.(s); } catch (e) { setMsg(`✕ ${e.message}`); } };
  const setup = async () => { setMsg(''); try { await companion.installExtra(cfg, 'wake'); setTimeout(refresh, 500); } catch (e) { setMsg(`✕ ${e.message}`); } };
  const autostart = async () => {
    setMsg('');
    try { const r = await companion.autostart(cfg); setMsg(`✓ ${r.message}`); refresh(); } catch (e) { setMsg(`✕ ${e.message}`); }
  };
  const paused = st.paused_until && st.paused_until * 1000 > Date.now();

  return (
    <div className="voice-grid">
      <div className="ws__label">“Hey Jarvis” — works even when Jarvis is closed</div>
      <p className="muted">
        The Companion listens quietly in the background for the words <b>“Hey Jarvis”</b>. Then it says “Yes?”, opens Jarvis,
        and {voiceReady ? 'hears your request' : 'opens the mic'}. The sound is checked on your PC only, and nothing is recorded or saved.
      </p>
      {!st.ready ? (
        <>
          {running ? (
            <div className="job"><div className="job__bar"><i style={{ width: `${Math.round((st.job.progress || 0) * 100)}%` }} /></div><span>{st.job.step}</span>{st.job.detail ? <em>{st.job.detail}</em> : null}</div>
          ) : <div className="btnrow"><button className="btn" onClick={setup}>SET UP “HEY JARVIS” (≈ 50 MB)</button></div>}
          {st.job?.state === 'error' ? <p className="err">{st.job.error}</p> : null}
        </>
      ) : (
        <>
          <p>
            Status: <span className={`pill pill--${st.state === 'listening' || st.state === 'awake' || st.state === 'recording' || st.state === 'transcribing' ? 'ok' : st.state === 'error' ? 'bad' : 'dim'}`}>
              {paused ? 'PAUSED' : STATE[st.state] || st.state.toUpperCase()}</span>
            {st.triggers ? <span className="muted"> · woke {st.triggers}× since the Companion started</span> : null}
          </p>
          {st.error ? <p className="err">{st.error}</p> : null}
          <label className="check"><input type="checkbox" checked={!!st.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Listen for “Hey Jarvis”</label>
          <label>Sensitivity
            <select value={st.sensitivity} onChange={(e) => set({ sensitivity: e.target.value })}>
              <option value="low">Low — fewer false wake-ups</option>
              <option value="normal">Normal</option>
              <option value="high">High — wakes more easily (noisy rooms, far away)</option>
            </select>
          </label>
          <label>Open Jarvis in
            <select value={st.browser} onChange={(e) => set({ browser: e.target.value })}>
              <option value="auto">Chrome, or Edge if Chrome isn’t installed</option>
              <option value="chrome">Google Chrome</option>
              <option value="edge">Microsoft Edge</option>
              <option value="default">My default browser</option>
            </select>
          </label>
          <div className="btnrow">
            {paused
              ? <button className="btn btn--ghost" onClick={() => set({ pause_minutes: 0 })}>RESUME NOW</button>
              : <button className="btn btn--ghost" onClick={() => set({ pause_minutes: 60 })} disabled={!st.enabled}>PAUSE FOR 1 HOUR</button>}
          </div>
          {!voiceReady ? <p className="muted">Tip: set up <b>offline voice</b> above too. Then you can say <i>“Hey Jarvis… what’s the weather?”</i> in one go, hands-free. Without it, Jarvis opens and you type or click the mic.</p> : null}
        </>
      )}

      <div className="ws__label">Start with Windows</div>
      <p className="muted">
        For “Hey Jarvis” to work right after you sign in, the Companion has to start with Windows.
        Status: <b>{st.autostart === 'on' ? 'ON ✓' : st.autostart === 'off' ? 'OFF' : 'not available here'}</b>
      </p>
      {st.autostart === 'off' ? (
        <>
          <div className="btnrow"><button className="btn btn--ghost" onClick={autostart}>START COMPANION WITH WINDOWS</button></div>
          <details className="alt">
            <summary>If Windows security blocks it — do it by hand (1 minute)</summary>
            <p className="muted">Press <b>Win + R</b>, type <code>shell:startup</code>, Enter. Right-click an empty space → <b>New → Shortcut</b>, paste the line below, <b>Next</b>, name it <b>Jarvis Companion</b>, <b>Finish</b>.</p>
            <code className="codeblock">"%LOCALAPPDATA%\Programs\Python\Python313\pythonw.exe" "%LOCALAPPDATA%\JarvisCompanion\jarvis_companion.py"</code>
          </details>
        </>
      ) : null}
      {msg ? <p className={msg.startsWith('✕') ? 'err' : 'muted'}>{msg}</p> : null}
    </div>
  );
}
