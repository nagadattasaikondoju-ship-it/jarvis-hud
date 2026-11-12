import React, { useEffect, useState } from 'react';
import { companion, companionHas } from '../companion.js';

/** CONFIG → VOICE: offline speech recognition (Whisper) and voices (Piper), run by the Companion. */
export default function VoiceSetup({ cfg, draft, setDraft, comp, onStatus }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState('');
  const [size, setSize] = useState('small');
  const [busyTest, setBusyTest] = useState(false);
  const has = companionHas(comp, 'voice');
  const running = st?.job?.state === 'running';

  const refresh = async () => {
    try { const s = await companion.voice(cfg); setSt(s); setSize(s.stt_model || 'small'); onStatus?.(s); } catch (e) { setErr(e.message); }
  };
  useEffect(() => { if (has) refresh(); }, [has]); // eslint-disable-line
  useEffect(() => {
    if (!running) return undefined;
    const i = setInterval(refresh, 1500);
    return () => clearInterval(i);
  }, [running]); // eslint-disable-line

  if (!has) {
    return <p className="muted">Offline voice needs <b>Jarvis Companion 1.2</b>. Open <b>SETUP → COMPANION</b> and run the install command again to update it.</p>;
  }
  if (!st) return <p className="muted">Checking offline voice…</p>;

  const voice = st.voices.find((v) => v.id === st.tts_voice) || st.voices[0];
  const ready = st.packages && st.stt_ready && voice?.installed;
  const setup = async (voices) => {
    setErr('');
    try { await companion.installExtra(cfg, 'voice', { stt_model: size, voices: voices || [st.tts_voice] }); setTimeout(refresh, 400); } catch (e) { setErr(e.message); }
  };
  const setVoice = async (id) => {
    setErr('');
    try { setSt(await companion.voiceConfig(cfg, { tts_voice: id })); } catch (e) { setErr(e.message); }
  };
  const test = async () => {
    setBusyTest(true);
    setErr('');
    try {
      const blob = await companion.tts(cfg, st.tts_voice.startsWith('te_') ? 'నమస్కారం. నేను జార్విస్. మీకు ఎలా సహాయం చేయగలను?' : st.tts_voice.startsWith('hi_') ? 'नमस्ते, मैं जार्विस हूँ। मैं आपकी कैसे मदद कर सकता हूँ?' : 'Good evening. All systems are online. How can I help?');
      const a = new Audio(URL.createObjectURL(blob));
      a.onended = () => URL.revokeObjectURL(a.src);
      await a.play();
    } catch (e) { setErr(e.message); }
    setBusyTest(false);
  };

  return (
    <div className="voice-grid">
      <div className="ws__label">Offline voice — nothing leaves your PC</div>
      <p className="muted">
        <b>Whisper</b> turns your speech into text and <b>Piper</b> reads replies aloud, both on this PC through the Companion.
        One-time download: about {size === 'small' ? '1 GB' : '700 MB'} (speech packages, the {size} speech model and one voice).
      </p>
      {running ? (
        <div className="job"><div className="job__bar"><i style={{ width: `${Math.round((st.job.progress || 0) * 100)}%` }} /></div><span>{st.job.step}</span>{st.job.detail ? <em>{st.job.detail}</em> : null}</div>
      ) : null}
      {st.job?.state === 'error' ? <p className="err">{st.job.error}</p> : null}

      <label>Speech recognition model
        <select value={size} onChange={(e) => { setSize(e.target.value); companion.voiceConfig(cfg, { stt_model: e.target.value }).then(setSt).catch(() => {}); }} disabled={running}>
          <option value="small">Small — more accurate (480 MB)</option>
          <option value="base">Base — faster, less accurate (145 MB)</option>
        </select>
      </label>
      <label>Voice for replies
        <select value={st.tts_voice} onChange={(e) => setVoice(e.target.value)} disabled={running}>
          {st.voices.map((v) => <option key={v.id} value={v.id}>{v.installed ? '✓ ' : '⇩ '}{v.label}</option>)}
        </select>
      </label>
      <label>Language you speak
        <select value={st.stt_language || ''} onChange={(e) => companion.voiceConfig(cfg, { stt_language: e.target.value }).then(setSt).catch(() => {})}>
          <option value="">Detect automatically</option>
          <option value="en">English</option>
          <option value="te">Telugu</option>
          <option value="hi">Hindi</option>
          <option value="ta">Tamil</option>
          <option value="ml">Malayalam</option>
        </select>
      </label>

      <div className="btnrow">
        {!ready || !st.stt_ready ? (
          <button className="btn" onClick={() => setup()} disabled={running}>{running ? 'SETTING UP…' : 'SET UP OFFLINE VOICE'}</button>
        ) : !voice.installed ? (
          <button className="btn" onClick={() => setup([st.tts_voice])} disabled={running}>DOWNLOAD THIS VOICE (≈60 MB)</button>
        ) : (
          <button className="btn btn--ghost" onClick={test} disabled={busyTest}>{busyTest ? 'SPEAKING…' : '▶ TEST VOICE'}</button>
        )}
      </div>
      {ready ? (
        <>
          <label className="check"><input type="checkbox" checked={!!draft.localStt} onChange={(e) => setDraft({ ...draft, localStt: e.target.checked })} /> Use offline speech recognition (mic, conversation mode and wake word)</label>
          <label className="check"><input type="checkbox" checked={!!draft.localTts} onChange={(e) => setDraft({ ...draft, localTts: e.target.checked })} /> Use the offline voice for spoken replies</label>
          <p className="muted">Telugu, Hindi or Malayalam replies automatically use a voice for that language if you have downloaded one. With offline speech, the wake word transcribes short phrases on your PC, which uses some CPU while it listens.</p>
        </>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}
