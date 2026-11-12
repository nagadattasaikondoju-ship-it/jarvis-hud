import React from 'react';

// Original holographic core: concentric instrument rings whose speed and
// colour follow the assistant state (standby / listening / thinking / speaking / offline).
const LABELS = {
  standby: 'STANDBY',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'RESPONDING',
  offline: 'LINK OFFLINE',
  connecting: 'HANDSHAKE',
};

function ticks(count, r1, r2, every = 0, r3 = r2) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const long = every && i % every === 0;
    const rr = long ? r3 : r2;
    out.push(
      <line
        key={i}
        x1={200 + Math.cos(a) * r1}
        y1={200 + Math.sin(a) * r1}
        x2={200 + Math.cos(a) * rr}
        y2={200 + Math.sin(a) * rr}
        strokeWidth={long ? 2 : 1}
      />
    );
  }
  return out;
}

function arc(r, start, end) {
  const s = (start * Math.PI) / 180;
  const e = (end * Math.PI) / 180;
  const large = end - start > 180 ? 1 : 0;
  return `M ${200 + r * Math.cos(s)} ${200 + r * Math.sin(s)} A ${r} ${r} 0 ${large} 1 ${200 + r * Math.cos(e)} ${200 + r * Math.sin(e)}`;
}

export default function Core({ state = 'standby', sub, level = 0 }) {
  const scale = 1 + Math.min(level, 1) * 0.06;
  return (
    <div className={`core core--${state}`} aria-live="polite">
      <svg viewBox="0 0 400 400" className="core__svg" role="img" aria-label={`Core status: ${LABELS[state]}`}>
        <defs>
          <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--core-hi)" stopOpacity="0.95" />
            <stop offset="35%" stopColor="var(--core)" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--core)" stopOpacity="0" />
          </radialGradient>
          <filter id="blur6"><feGaussianBlur stdDeviation="6" /></filter>
        </defs>

        <g className="ring ring--outer">{ticks(120, 188, 194, 10, 199)}</g>
        <g className="ring ring--dash">
          <circle cx="200" cy="200" r="176" fill="none" strokeDasharray="2 7" />
        </g>
        <g className="ring ring--arcs">
          <path d={arc(160, -20, 70)} />
          <path d={arc(160, 110, 160)} />
          <path d={arc(160, 190, 300)} />
          <path d={arc(160, 320, 335)} />
        </g>
        <g className="ring ring--mid">{ticks(60, 132, 142, 5, 146)}</g>
        <g className="ring ring--seg">
          {Array.from({ length: 12 }).map((_, i) => (
            <path key={i} d={arc(118, i * 30 + 3, i * 30 + 24)} />
          ))}
        </g>
        <g className="ring ring--inner">
          <circle cx="200" cy="200" r="98" fill="none" strokeDasharray="40 12 4 12" />
        </g>

        <g style={{ transform: `scale(${scale})`, transformOrigin: '200px 200px', transition: 'transform 90ms linear' }}>
          <circle cx="200" cy="200" r="90" fill="url(#coreGlow)" className="core__glow" />
          <circle cx="200" cy="200" r="62" fill="none" className="core__halo" filter="url(#blur6)" />
          <circle cx="200" cy="200" r="62" fill="none" className="core__rim" />
        </g>
      </svg>
      <div className="core__label">
        <span className="core__state">{LABELS[state]}</span>
        {sub ? <span className="core__sub">{sub}</span> : null}
      </div>
    </div>
  );
}
