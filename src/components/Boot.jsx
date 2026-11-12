import React, { useEffect, useState } from 'react';

const LINES = [
  'OPENJARVIS HUD v1.0 — cold start',
  'loading interface kernel ............ ok',
  'calibrating holographic display ..... ok',
  'mounting voice subsystem ............ ok',
  'opening secure local link ........... pending',
  'privacy mode: inference stays on your hardware',
  'all systems nominal. good to see you.',
];

export default function Boot({ onDone }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (n >= LINES.length) {
      const t = setTimeout(onDone, 550);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setN(n + 1), n === 0 ? 350 : 230);
    return () => clearTimeout(t);
  }, [n, onDone]);

  useEffect(() => {
    const skip = () => onDone();
    window.addEventListener('keydown', skip);
    return () => window.removeEventListener('keydown', skip);
  }, [onDone]);

  return (
    <div className="boot" onClick={onDone} role="button" tabIndex={0} aria-label="Skip boot sequence">
      <div className="boot__ring" />
      <div className="boot__title">OPEN<b>JARVIS</b></div>
      <pre className="boot__log">
        {LINES.slice(0, n).map((l, i) => (
          <div key={i}>{'> '}{l}</div>
        ))}
        <span className="caret">▌</span>
      </pre>
      <div className="boot__bar"><i style={{ width: `${(n / LINES.length) * 100}%` }} /></div>
      <div className="boot__skip">click or press any key to skip</div>
    </div>
  );
}
