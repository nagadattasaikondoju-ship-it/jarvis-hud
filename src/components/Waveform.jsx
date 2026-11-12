import React, { useEffect, useRef } from 'react';

// Mirrored bar waveform. `getLevel()` returns 0..1 (mic or synthetic).
export default function Waveform({ getLevel, state }) {
  const ref = useRef(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const c = ref.current;
    const ctx = c.getContext('2d');
    let raf;
    const N = 48;
    const hist = new Array(N).fill(0);
    let t = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      t += 1;
      const s = stateRef.current;
      let lv = getLevel ? getLevel() : 0;
      if (s === 'thinking') lv = Math.max(lv, 0.18 + 0.12 * Math.sin(t / 6));
      if (s === 'standby') lv = Math.max(lv, 0.04 + 0.03 * Math.sin(t / 20));
      if (s === 'offline') lv = 0.02;
      hist.push(lv);
      hist.shift();
      const css = getComputedStyle(c);
      const col = css.getPropertyValue('--wave').trim() || '#3fe0ff';
      const bw = w / N;
      for (let i = 0; i < N; i++) {
        const v = hist[i] * (0.6 + 0.4 * Math.sin(i * 1.7 + t / 9));
        const bh = Math.max(1.5, v * h * 0.9);
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.25 + 0.75 * (i / N);
        ctx.fillRect(i * bw + 1, h / 2 - bh / 2, bw - 2, bh);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [getLevel]);

  return <canvas ref={ref} className="wave" aria-hidden="true" />;
}
