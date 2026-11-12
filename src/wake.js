// "Jarvis" wake word, built on the browser's speech recognition.
//
// A continuous recogniser listens for the word "Jarvis". When it hears it:
//   * "Jarvis, what's the time?"  -> onWake("what's the time?")  (command said in one go)
//   * "Jarvis" ... (pause)        -> onWake("")                   (caller opens the mic for the command)
//
// Chrome and Edge normally send the audio to their speech service (Google / Microsoft).
// Where the browser offers on-device recognition, it is used instead and nothing leaves the PC.

export const WAKE_RE = /\b(?:(?:hey|hi|ok|okay|yo)[\s,]+)?(?:jarvis|jarvi|jervis|jarvas|javis|jarvus)\b[\s,.:;!?-]*/i;

export const speechApi = () => (typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null);

const KEY = 'ojh.speechLocal';
const readKey = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const writeKey = (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage unavailable */ } };

/**
 * The last known on-device speech status, without asking the browser.
 * 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported' | 'unknown' | 'broken'
 * ('broken' = an earlier check took the page down, so it is never tried again.)
 */
export function storedOnDeviceStatus() {
  const v = readKey();
  if (v === 'checking') { writeKey('broken'); return 'broken'; }
  return v || 'unknown';
}

/**
 * Ask the browser whether on-device speech recognition is available. Only run on a click:
 * in some browser builds this call can crash the tab, so a 'checking' marker is saved first
 * and, if the page dies, the check is never repeated.
 */
export async function onDeviceStatus(lang) {
  const SR = speechApi();
  if (!SR || typeof SR.available !== 'function') { writeKey('unsupported'); return 'unsupported'; }
  if (readKey() === 'broken') return 'broken';
  writeKey('checking');
  let r = 'unsupported';
  try {
    r = String(await SR.available({ langs: [lang], processLocally: true }));
  } catch { /* keep unsupported */ }
  writeKey(r);
  return r;
}

/** Ask the browser to download its on-device speech model (needs a click). */
export async function installOnDevice(lang) {
  const SR = speechApi();
  if (!SR || typeof SR.install !== 'function') return false;
  try {
    const ok = !!(await SR.install({ langs: [lang], processLocally: true }));
    if (ok) writeKey('available');
    return ok;
  } catch {
    return false;
  }
}

/** A short rising two-tone chime: "I'm listening". */
export function chime() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const t = ctx.currentTime;
    [[660, 0], [990, 0.11]].forEach(([f, d]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t + d);
      o.stop(t + d + 0.18);
    });
    setTimeout(() => ctx.close(), 600);
  } catch { /* audio unavailable */ }
}

/**
 * createWake({ lang, local, onWake, onState, onFatal })
 *   onState('armed' | 'off' | 'retrying')
 *   onFatal(code) — the microphone is blocked; the wake word turns itself off.
 * Returns { start(), stop(), running() }.
 */
export function createWake({ lang, local = false, onWake, onState, onFatal }) {
  const SR = speechApi();
  let rec = null;
  let want = false;
  let timer = null;
  let fails = 0;
  let useLocal = local;

  const spawn = () => {
    timer = null;
    if (!want || rec || !SR) return;
    const r = new SR();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    if (useLocal) { try { r.processLocally = true; } catch { /* not supported */ } }
    let fired = false;
    let heardAt = 0;
    let waitTimer = null;

    const fire = (rest) => {
      if (fired) return;
      fired = true;
      clearTimeout(waitTimer);
      want = false;
      try { r.abort(); } catch { /* ignore */ }
      onWake?.(rest.trim());
    };

    r.onresult = (ev) => {
      fails = 0;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0]?.transcript || '';
        const m = WAKE_RE.exec(text);
        if (!m) continue;
        const rest = text.slice(m.index + m[0].length);
        if (res.isFinal) { fire(rest); return; }
        // Heard "Jarvis" but the phrase is not final yet: wait briefly for the rest of the sentence,
        // and if the browser never finalises, answer anyway so the user is not left waiting.
        if (!heardAt) {
          heardAt = Date.now();
          waitTimer = setTimeout(() => fire(rest.trim().split(/\s+/).length > 2 ? rest : ''), 2600);
        }
      }
    };
    r.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        if (useLocal) { useLocal = false; return; } // on-device refused: fall back to the normal service
        want = false;
        onFatal?.(ev.error);
      } else if (ev.error === 'language-not-supported' && useLocal) {
        useLocal = false;
      } else if (ev.error !== 'no-speech' && ev.error !== 'aborted') {
        fails += 1;
      }
    };
    r.onend = () => {
      clearTimeout(waitTimer);
      if (rec === r) rec = null;
      if (want && !fired) {
        // Chrome ends continuous recognition every minute or so — re-arm, slower if it keeps failing.
        onState?.(fails > 2 ? 'retrying' : 'armed');
        timer = setTimeout(spawn, fails > 2 ? Math.min(30000, 2000 * fails) : 250);
      } else onState?.('off');
    };
    rec = r;
    try {
      r.start();
      onState?.('armed');
    } catch {
      rec = null;
      timer = setTimeout(spawn, 1000);
    }
  };

  return {
    start() {
      if (!SR) return;
      want = true;
      if (!rec && !timer) spawn();
    },
    stop() {
      want = false;
      clearTimeout(timer);
      timer = null;
      if (rec) { try { rec.abort(); } catch { /* ignore */ } rec = null; }
      onState?.('off');
    },
    running: () => !!rec,
  };
}
