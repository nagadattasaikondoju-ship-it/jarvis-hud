import React, { useEffect, useRef } from 'react';
import { download } from '../exporters.js';

const PALETTE = ['#3fe0ff', '#4dffb0', '#ffb547', '#b48cff', '#ff6fa8', '#7fb6ff', '#f2f27a', '#5ad1c6'];

function ChartCard({ chart }) {
  const ref = useRef(null);
  useEffect(() => {
    let inst;
    let dead = false;
    (async () => {
      const { Chart, registerables } = await import('chart.js');
      Chart.register(...registerables);
      if (dead || !ref.current) return;
      const round = chart.type === 'pie' || chart.type === 'doughnut';
      inst = new Chart(ref.current, {
        type: chart.type,
        data: {
          labels: chart.labels,
          datasets: (chart.series || []).map((s, i) => ({
            label: s.name,
            data: s.values,
            backgroundColor: round ? chart.labels.map((_, j) => PALETTE[j % PALETTE.length] + 'cc') : PALETTE[i % PALETTE.length] + (chart.type === 'line' ? '33' : 'aa'),
            borderColor: round ? '#061a26' : PALETTE[i % PALETTE.length],
            borderWidth: round ? 2 : 2,
            fill: chart.type === 'line',
            tension: 0.3,
            pointRadius: 3,
          })),
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 700 },
          plugins: {
            legend: { display: (chart.series || []).length > 1 || round, labels: { color: '#cfeff7', font: { family: 'Rajdhani', size: 13 } } },
            tooltip: { backgroundColor: '#04141e', borderColor: '#3fe0ff', borderWidth: 1, titleColor: '#b9f4ff', bodyColor: '#cfeff7' },
          },
          scales: round ? {} : {
            x: { ticks: { color: '#8fb8c6' }, grid: { color: 'rgba(63,224,255,.08)' } },
            y: { ticks: { color: '#8fb8c6' }, grid: { color: 'rgba(63,224,255,.08)' }, beginAtZero: true },
          },
        },
      });
    })();
    return () => { dead = true; inst?.destroy(); };
  }, [chart]);
  return (
    <div className="dash__chart frame">
      <h4>{chart.title}</h4>
      <div className="dash__canvas"><canvas ref={ref} role="img" aria-label={chart.title} /></div>
    </div>
  );
}

export function Dashboard({ spec, compact }) {
  if (!spec) return null;
  return (
    <div className={`dash ${compact ? 'dash--compact' : ''}`}>
      {!compact && <h3 className="dash__title">{spec.title}</h3>}
      {spec.summary ? <p className="dash__summary">{spec.summary}</p> : null}
      <div className="dash__kpis">
        {(spec.kpis || []).map((k, i) => (
          <div className="dash__kpi frame" key={i}>
            <span>{k.label}</span>
            <b>{k.value}</b>
            {k.note ? <em>{k.note}</em> : null}
          </div>
        ))}
      </div>
      <div className="dash__charts">
        {(spec.charts || []).slice(0, compact ? 2 : 6).map((c, i) => <ChartCard chart={c} key={i} />)}
      </div>
      {!compact && spec.table?.columns?.length ? (
        <div className="dash__table frame">
          <table>
            <thead><tr>{spec.table.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>{(spec.table.rows || []).slice(0, 50).map((r, i) => <tr key={i}>{spec.table.columns.map((_, j) => <td key={j}>{r[j]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

const DASH_HTML = (spec) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${(spec.title || 'Dashboard').replace(/</g, '&lt;')}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js"></script>
<style>body{margin:0;padding:24px;background:#02070c;color:#cfeff7;font-family:system-ui,sans-serif}h1{color:#3fe0ff;font-weight:600}.k{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.k div{border:1px solid #1d4a5a;padding:14px;background:#061a26}.k b{display:block;font-size:26px;color:#b9f4ff}.c{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px;margin-top:16px}.c div{border:1px solid #1d4a5a;padding:12px;background:#061a26;height:320px}</style></head>
<body><h1></h1><p id="s"></p><div class="k" id="k"></div><div class="c" id="c"></div>
<script>const spec=${JSON.stringify(spec).replace(/</g, '\\u003c')};const P=${JSON.stringify(PALETTE)};
document.querySelector('h1').textContent=spec.title;document.getElementById('s').textContent=spec.summary||'';
(spec.kpis||[]).forEach(k=>{const d=document.createElement('div');d.innerHTML='<span></span><b></b><em></em>';d.children[0].textContent=k.label;d.children[1].textContent=k.value;d.children[2].textContent=k.note||'';document.getElementById('k').appendChild(d)});
(spec.charts||[]).forEach(ch=>{const d=document.createElement('div');const h=document.createElement('h3');h.textContent=ch.title;const cv=document.createElement('canvas');d.append(h,cv);document.getElementById('c').appendChild(d);const r=ch.type==='pie'||ch.type==='doughnut';
new Chart(cv,{type:ch.type,data:{labels:ch.labels,datasets:ch.series.map((s,i)=>({label:s.name,data:s.values,backgroundColor:r?ch.labels.map((_,j)=>P[j%P.length]):P[i%P.length],borderColor:P[i%P.length]}))},options:{maintainAspectRatio:false,plugins:{legend:{labels:{color:'#cfeff7'}}},scales:r?{}:{x:{ticks:{color:'#8fb8c6'}},y:{ticks:{color:'#8fb8c6'},beginAtZero:true}}}})});</script></body></html>`;

export default function ArtifactPanel({ artifact, onClose }) {
  useEffect(() => {
    if (!artifact) return undefined;
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [artifact, onClose]);
  if (!artifact) return null;
  const isDash = artifact.kind === 'dashboard';
  const title = isDash ? artifact.spec.title : artifact.title || 'Artifact';
  const save = () => {
    const html = isDash ? DASH_HTML(artifact.spec) : artifact.html;
    download(new Blob([html], { type: 'text/html' }), `${(title || 'artifact').replace(/[^\w\- ]+/g, '').trim() || 'artifact'}.html`);
  };
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__box modal__box--wide frame">
        <div className="modal__head">
          <h2>{isDash ? 'DASHBOARD' : 'ARTIFACT'} · {title}</h2>
          <div className="btnrow" style={{ marginTop: 0 }}>
            <button className="btn btn--tiny" onClick={save}>DOWNLOAD HTML</button>
            <button className="btn btn--tiny" onClick={onClose} aria-label="Close">CLOSE ✕</button>
          </div>
        </div>
        <div className="artifact__body">
          {isDash ? (
            <Dashboard spec={artifact.spec} />
          ) : (
            <iframe title={title} className="artifact__frame" sandbox="allow-scripts allow-modals allow-forms allow-popups" srcDoc={artifact.html} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Find the first ```html block in a reply. */
export function extractHtml(text) {
  const m = /```html\s*([\s\S]*?)(```|$)/i.exec(text || '');
  if (!m) return null;
  const html = m[1].trim();
  return html.length > 40 ? html : null;
}
