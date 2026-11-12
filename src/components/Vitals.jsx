import React from 'react';

const GB = 1024 ** 3;
const pct = (v) => (v == null || Number.isNaN(v) ? null : Math.max(0, Math.min(100, v)));
const fmtGB = (b) => (b == null ? '—' : `${(b / GB).toFixed(b >= 10 * GB ? 0 : 1)} GB`);

/** Derive the numbers every view needs from the Companion snapshot + Ollama's /api/ps. */
export function vitalsView(sys, loaded) {
  const gpu = sys?.gpus?.[0] || null;
  const vramPct = gpu && gpu.mem_total_mb ? (100 * gpu.mem_used_mb) / gpu.mem_total_mb : null;
  const model = loaded?.[0] || null;
  let placement = null;
  if (model) {
    placement = model.gpuPct >= 99 ? '100% GPU' : model.gpuPct <= 1 ? '100% CPU' : `${100 - model.gpuPct}% CPU / ${model.gpuPct}% GPU`;
  }
  return {
    cpu: pct(sys?.cpu?.percent),
    ram: pct(sys?.ram?.percent),
    gpu: gpu ? pct(gpu.util) : null,
    vram: pct(vramPct),
    gpuInfo: gpu,
    model,
    placement,
    tone: !model ? null : model.gpuPct >= 99 ? 'ok' : model.gpuPct <= 1 ? 'bad' : 'warn',
  };
}

/** A small instrument ring. */
export function Gauge({ label, value, sub, tone }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const v = value == null ? 0 : value;
  const hot = value != null && value >= 90 ? 'hot' : value != null && value >= 70 ? 'warm' : '';
  return (
    <div className={`gauge ${hot ? `gauge--${hot}` : ''} ${tone ? `gauge--${tone}` : ''} ${value == null ? 'gauge--na' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : Math.round(v)}>
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="30" className="gauge__ticks" />
        <circle cx="32" cy="32" r={r} className="gauge__track" />
        <circle cx="32" cy="32" r={r} className="gauge__bar" strokeDasharray={`${(c * v) / 100} ${c}`} transform="rotate(-90 32 32)" />
      </svg>
      <div className="gauge__val">{value == null ? '—' : Math.round(v)}<small>{value == null ? '' : '%'}</small></div>
      <div className="gauge__label">{label}</div>
      {sub ? <div className="gauge__sub">{sub}</div> : null}
    </div>
  );
}

/** Gauges flanking the core (desktop). */
export function StageVitals({ sys, loaded, tps }) {
  const v = vitalsView(sys, loaded);
  if (!sys && !v.model) return null;
  const hasGpu = !!v.gpuInfo;
  return (
    <>
      <div className="stagev stagev--l" aria-label="Processor and memory">
        <Gauge label="CPU" value={v.cpu} sub={sys?.cpu?.temp_c ? `${sys.cpu.temp_c}°C` : null} />
        <Gauge label="RAM" value={v.ram} sub={sys?.ram?.used ? fmtGB(sys.ram.used) : null} />
      </div>
      <div className="stagev stagev--r" aria-label="Graphics and model">
        {hasGpu ? (
          <>
            <Gauge label="GPU" value={v.gpu} sub={v.gpuInfo.temp_c != null ? `${Math.round(v.gpuInfo.temp_c)}°C` : null} />
            <Gauge label="VRAM" value={v.vram} sub={v.gpuInfo.mem_used_mb != null ? `${(v.gpuInfo.mem_used_mb / 1024).toFixed(1)} GB` : null} />
          </>
        ) : (
          <Gauge label="MODEL" value={v.model ? v.model.gpuPct : null} sub={v.model ? 'ON GPU' : 'IDLE'} tone={v.tone} />
        )}
        {tps ? <div className="stagev__tps"><b>{tps.toFixed(1)}</b><span>TOK/S</span></div> : null}
      </div>
    </>
  );
}

function Lines({ series }) {
  const w = 200;
  const h = 40;
  const any = series.some((s) => s.data.filter((d) => d != null).length > 1);
  if (!any) return <div className="spark spark--empty">awaiting samples</div>;
  return (
    <svg className="spark spark--multi" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="CPU and GPU load history">
      {series.map((s) => {
        const pts = s.data;
        const n = Math.max(2, pts.length);
        const d = pts.map((p, i) => (p == null ? null : `${(i / (n - 1)) * w},${h - (p / 100) * (h - 4) - 2}`)).filter(Boolean).join(' ');
        return <polyline key={s.key} className={`line--${s.key}`} points={d} fill="none" />;
      })}
    </svg>
  );
}

/** The full VITALS panel for SYSTEMS. */
export function VitalsPanel({ sys, loaded, hist, tps, lastTps, comp, compHasSystem, onSetup }) {
  const v = vitalsView(sys, loaded);
  const g = v.gpuInfo;
  return (
    <section className="panel frame">
      <header className="panel__head"><span>VITALS</span><em>SYS-07</em></header>
      <div className="panel__body">
        <div className="vitals__gauges">
          <Gauge label="CPU" value={v.cpu} />
          <Gauge label="RAM" value={v.ram} />
          {g ? <Gauge label="GPU" value={v.gpu} /> : <Gauge label="MODEL" value={v.model ? v.model.gpuPct : null} sub={v.model ? 'ON GPU' : 'IDLE'} tone={v.tone} />}
        </div>
        <Lines series={[{ key: 'cpu', data: hist.cpu }, { key: 'gpu', data: hist.gpu }]} />
        <div className="vitals__legend"><span className="lg lg--cpu">CPU</span>{g ? <span className="lg lg--gpu">GPU</span> : null}</div>

        <div className="ws__label">AI model</div>
        <div className="row"><span>Loaded</span><b>{v.model ? v.model.name : 'none (sleeping)'}</b></div>
        {v.model ? <div className="row"><span>Runs on</span><b className={`tone-${v.tone === 'ok' ? 'ok' : 'bad'}`}>{v.placement}</b></div> : null}
        {v.model ? <div className="row"><span>Memory</span><b>{fmtGB(v.model.size)}{v.model.ctx ? ` · ${v.model.ctx.toLocaleString()} ctx` : ''}</b></div> : null}
        <div className="row"><span>Speed</span><b>{tps ? `${tps.toFixed(1)} tok/s (live)` : lastTps ? `${lastTps.toFixed(1)} tok/s` : '—'}</b></div>
        {v.model && v.model.gpuPct < 99 && g ? (
          <p className="muted small">Part of the model is on the CPU because graphics memory is full. A smaller model or a lower <b>Max context</b> will answer faster.</p>
        ) : null}

        {sys ? (
          <>
            <div className="ws__label">This PC</div>
            {sys.cpu?.name ? <div className="row"><span>CPU</span><b title={sys.cpu.name}>{sys.cpu.name.replace(/\(R\)|\(TM\)|CPU|Processor|with Radeon Graphics/gi, '').replace(/\s+/g, ' ').trim()}</b></div> : null}
            <div className="row"><span>Memory</span><b>{fmtGB(sys.ram?.used)} / {fmtGB(sys.ram?.total)}</b></div>
            {g ? (
              <>
                <div className="row"><span>GPU</span><b title={g.name}>{g.name.replace(/NVIDIA|GeForce/gi, '').trim()}</b></div>
                <div className="row"><span>Graphics memory</span><b>{g.mem_used_mb != null ? `${(g.mem_used_mb / 1024).toFixed(1)} / ${(g.mem_total_mb / 1024).toFixed(1)} GB` : '—'}</b></div>
                <div className="row"><span>GPU temperature</span><b className={g.temp_c >= 85 ? 'tone-bad' : ''}>{g.temp_c != null ? `${Math.round(g.temp_c)}°C` : '—'}{g.power_w ? ` · ${Math.round(g.power_w)} W` : ''}</b></div>
              </>
            ) : <div className="row"><span>GPU</span><b>no NVIDIA GPU found</b></div>}
            {sys.battery ? (
              <div className="row"><span>Battery</span><b className={sys.battery.percent <= 20 && !sys.battery.plugged ? 'tone-bad' : ''}>{sys.battery.percent}% · {sys.battery.plugged ? 'charging' : 'on battery'}</b></div>
            ) : null}
          </>
        ) : (
          <p className="muted small">
            {comp?.ok && !compHasSystem
              ? <>Update Jarvis Companion to see CPU, GPU, temperature and battery. </>
              : <>Install Jarvis Companion to see CPU, GPU, temperature and battery. </>}
            <button className="linkbtn" onClick={onSetup}>{comp?.ok ? 'How to update' : 'Set up'}</button>
          </p>
        )}
      </div>
    </section>
  );
}
