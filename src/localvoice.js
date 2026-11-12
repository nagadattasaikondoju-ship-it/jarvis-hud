// Offline voice: the microphone is recorded here, in the browser, and sent as a
// 16 kHz WAV to Jarvis Companion, which runs Whisper on the PC. Replies are spoken
// with Piper voices, also on the PC. Nothing goes to an online speech service.
import { companion } from './companion.js';
import { WAKE_RE } from './wake.js';

function toWav(chunks, rate) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(len);
  let o = 0;
  for (const c of chunks) { pcm.set(c, o); o += c.length; }
  // downsample to 16 kHz by averaging
  const ratio = rate / 16000;
  const outLen = Math.floor(len / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(len, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j];
    const v = s / Math.max(1, b - a);
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + out.length * 2);
  const dv = new DataView(buf);
  const w = (p, s) => [...s].forEach((ch, i) => dv.setUint8(p + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + out.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, out.length * 2, true);
  new Int16Array(buf, 44).set(out);
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Record one spoken phrase. Starts saving when you start talking and stops after a short silence.
 * Resolves with a WAV Blob, or null if nobody spoke within `waitMs`.
 * Aborting the signal finishes early, keeping what was said so far.
 */
export async function recordUtterance({ maxMs = 20000, silenceMs = 1100, waitMs = 8000, onLevel, signal } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  const frameMs = (2048 / ctx.sampleRate) * 1000;

  return new Promise((resolve) => {
    const pre = []; // a little audio before speech starts, so the first word isn't clipped
    const chunks = [];
    let noise = 0.01;
    let frames = 0;
    let started = false;
    let loudRun = 0;
    let lastLoud = 0;
    let done = false;
    const t0 = performance.now();
    const finish = (keep) => {
      if (done) return;
      done = true;
      proc.onaudioprocess = null;
      try { src.disconnect(); proc.disconnect(); sink.disconnect(); } catch { /* ignore */ }
      stream.getTracks().forEach((tr) => tr.stop());
      ctx.close().catch(() => {});
      signal?.removeEventListener?.('abort', onAbort);
      onLevel?.(0);
      resolve(keep && chunks.length ? toWav(chunks, ctx.sampleRate) : null);
    };
    const onAbort = () => finish(started);
    signal?.addEventListener?.('abort', onAbort);
    proc.onaudioprocess = (e) => {
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      const rms = Math.sqrt(s / d.length);
      onLevel?.(Math.min(1, rms * 8));
      frames += 1;
      const now = performance.now();
      if (frames < 6) { noise = Math.max(0.004, (noise * (frames - 1) + rms) / frames); return; } // calibrate ~250 ms
      const thr = Math.max(0.015, noise * 3);
      if (!started) {
        pre.push(d); if (pre.length > 8) pre.shift();
        loudRun = rms > thr ? loudRun + 1 : 0;
        if (rms < thr) noise = noise * 0.95 + rms * 0.05;
        if (loudRun >= 2) { started = true; chunks.push(...pre); lastLoud = now; }
        else if (now - t0 > waitMs) finish(false);
        return;
      }
      chunks.push(d);
      if (rms > thr * 0.8) lastLoud = now;
      if (now - lastLoud > silenceMs || chunks.length * frameMs > maxMs) finish(true);
    };
  });
}

/** Speak `text` with a Piper voice on the PC. Returns { stop(), done: Promise }. */
export function speakLocal(cfg, text, { voice, onStart, onLevel } = {}) {
  let audio = null;
  let url = null;
  let ctx = null;
  let timer = null;
  let stopped = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let finished = false;
  const cleanup = (err) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    onLevel?.(0);
    if (url) URL.revokeObjectURL(url);
    ctx?.close?.().catch(() => {});
    resolveDone(err); // resolves with an Error when speaking failed, so the caller can fall back
  };
  (async () => {
    try {
      const blob = await companion.tts(cfg, text, voice);
      if (stopped) { cleanup(); return; }
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaElementSource(audio).connect(an);
        an.connect(ctx.destination);
        const buf = new Uint8Array(an.fftSize);
        timer = setInterval(() => {
          an.getByteTimeDomainData(buf);
          let s = 0;
          for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; }
          onLevel?.(Math.min(1, Math.sqrt(s / buf.length) * 5));
        }, 60);
      } catch { /* level meter is optional */ }
      audio.onended = () => cleanup();
      audio.onerror = () => cleanup(new Error('Audio playback failed'));
      await audio.play();
      onStart?.();
    } catch (e) {
      cleanup(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return {
    stop() { stopped = true; try { audio?.pause(); } catch { /* ignore */ } cleanup(); },
    done,
  };
}

/**
 * Wake word with offline speech: records short phrases and transcribes them on the PC,
 * looking for "Jarvis". Uses some CPU while armed. Same interface as createWake().
 */
export function createLocalWake({ cfg, onWake, onState, onFatal }) {
  let want = false;
  let ctl = null;
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    onState?.('armed');
    while (want) {
      ctl = new AbortController();
      let wav = null;
      try {
        wav = await recordUtterance({ maxMs: 6000, silenceMs: 700, waitMs: 60000, signal: ctl.signal });
      } catch (e) {
        want = false;
        onFatal?.(String(e?.name || e));
        break;
      }
      if (!want || !wav) continue;
      try {
        const r = await companion.stt(cfg, wav, { quick: true });
        const m = WAKE_RE.exec(r.text || '');
        if (m && want) {
          want = false;
          onWake?.((r.text.slice(m.index + m[0].length) || '').trim());
        }
      } catch {
        onState?.('retrying');
        await new Promise((res) => setTimeout(res, 3000));
        if (want) onState?.('armed');
      }
    }
    running = false;
    onState?.('off');
  };
  return {
    start() { if (want) return; want = true; loop(); },
    stop() { want = false; ctl?.abort(); },
    running: () => running,
  };
}
