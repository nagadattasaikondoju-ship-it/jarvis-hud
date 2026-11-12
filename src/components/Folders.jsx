import React, { useState } from 'react';

const short = (p) => {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : p;
};
const ago = (ts) => {
  if (!ts) return 'never';
  const s = Date.now() / 1000 - ts;
  return s < 90 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};

/** WORKSPACE → MY FOLDERS: pick folders for Jarvis to read, and set up folder search. */
export default function Folders({ info, compOk, hasFeature, onSetup, onAdd, onRemove, onReindex, onCompanion }) {
  const [path, setPath] = useState('');
  const [err, setErr] = useState('');
  const job = info?.job || {};
  const ready = info?.ready?.embed_model && info?.ready?.pypdf;
  const idx = info?.index || {};
  const folders = info?.folders || [];
  const add = async (p) => {
    setErr('');
    try { await onAdd(p.trim()); setPath(''); } catch (e) { setErr(e.message); }
  };

  return (
    <section className="panel frame">
      <header className="panel__head"><span>MY FOLDERS</span><em>FLD-04</em></header>
      <div className="panel__body">
        {!compOk || !hasFeature ? (
          <>
            <p className="muted small">Let Jarvis read folders on your PC, like Documents, and answer questions about your own files.</p>
            <button className="btn btn--tiny btn--block" onClick={onCompanion}>{compOk ? 'UPDATE COMPANION' : 'INSTALL COMPANION'}</button>
          </>
        ) : !ready ? (
          <>
            <p className="muted small">
              Jarvis reads your PDFs, Word, PowerPoint, Excel and text files <b>on this PC</b> and answers questions like
              “what did my physics notes say about the exam?”. One-time setup downloads a small search model (about 300 MB).
            </p>
            {job.state === 'running' ? (
              <div className="job"><div className="job__bar"><i style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div><span>{job.step}</span>{job.detail ? <em>{job.detail}</em> : null}</div>
            ) : (
              <button className="btn btn--tiny btn--block" onClick={onSetup}>SET UP FOLDER SEARCH</button>
            )}
            {job.state === 'error' ? <p className="err small">{job.error}</p> : null}
          </>
        ) : (
          <>
            <ul className="ws__list">
              {folders.map((f) => (
                <li key={f.path} title={f.path}>
                  <span className="ws__name">📁 {short(f.path)}</span>
                  <em>{f.docs} files{f.errors ? ` · ${f.errors} skipped` : ''}</em>
                  <button className="ws__x" onClick={() => onRemove(f.path)} aria-label={`Stop reading ${f.path}`}>×</button>
                </li>
              ))}
              {!folders.length && <li className="muted small">No folders yet. Add one below.</li>}
            </ul>
            {(info?.suggestions || []).filter((s) => !folders.some((f) => f.path === s)).length ? (
              <div className="chips chips--left">
                {(info.suggestions || []).filter((s) => !folders.some((f) => f.path === s)).map((s) => (
                  <button key={s} className="chip chip--tiny" onClick={() => add(s)}>+ {s.split(/[\\/]/).pop()}</button>
                ))}
              </div>
            ) : null}
            <div className="ws__row">
              <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Paste a folder path, e.g. D:\College" aria-label="Folder path"
                onKeyDown={(e) => { if (e.key === 'Enter' && path.trim()) add(path); }} spellCheck={false} />
              <button className="btn btn--tiny" disabled={!path.trim()} onClick={() => add(path)}>ADD</button>
            </div>
            {err ? <p className="err small">{err}</p> : null}
            <p className="muted small">
              {idx.state === 'indexing'
                ? <>Reading <b>{idx.file}</b> · {idx.done}/{idx.total}</>
                : <>Up to date · checked {ago(idx.last_run)} <button className="linkbtn" onClick={onReindex}>re-check</button></>}
            </p>
            <p className="muted small">Ask things like <i>“what did my physics notes say about the exam?”</i>. Files never leave this PC.</p>
          </>
        )}
      </div>
    </section>
  );
}
