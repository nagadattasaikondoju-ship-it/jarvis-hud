import React, { useRef, useState } from 'react';
import { ACCEPT, fmtSize } from '../files.js';

const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export default function Workspace({
  projects, project, setProjectId,
  chats, chatId, onNewChat, onOpenChat, onDeleteChat,
  onCreateProject, onUpdateProject, onDeleteProject,
  projectFiles, onAddProjectFiles, onRemoveProjectFile, fileBusy,
  memory, useMemory, setUseMemory, onAddMemory, onDeleteMemory,
}) {
  const [newName, setNewName] = useState('');
  const [memText, setMemText] = useState('');
  const [instr, setInstr] = useState(null);
  const fileRef = useRef(null);

  return (
    <div className="ws">
      <section className="panel frame">
        <header className="panel__head"><span>PROJECTS</span><em>PRJ-01</em></header>
        <div className="panel__body">
          <select className="ws__select" value={project?.id || ''} onChange={(e) => { setProjectId(e.target.value || null); setInstr(null); }} aria-label="Active project">
            <option value="">General (no project)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <form className="ws__row" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { onCreateProject(newName.trim()); setNewName(''); } }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New project name…" aria-label="New project name" />
            <button className="btn btn--tiny" disabled={!newName.trim()}>ADD</button>
          </form>

          {project && (
            <div className="ws__project">
              <label className="ws__label">Instructions for this project</label>
              <textarea
                rows={3}
                value={instr ?? project.instructions ?? ''}
                onChange={(e) => setInstr(e.target.value)}
                placeholder="e.g. You are helping me write my startup pitch. Keep answers short."
              />
              {instr !== null && instr !== (project.instructions || '') && (
                <button className="btn btn--tiny" onClick={() => { onUpdateProject({ ...project, instructions: instr }); setInstr(null); }}>SAVE INSTRUCTIONS</button>
              )}
              <label className="ws__label">Project files ({projectFiles.length})</label>
              <ul className="ws__files">
                {projectFiles.map((f) => (
                  <li key={f.id}>
                    <span title={f.name}>{f.kind === 'image' ? '▣' : '▤'} {f.name}</span>
                    <em>{f.kind === 'image' ? 'image' : `${(f.text || '').length.toLocaleString()} ch`}</em>
                    <button className="ws__x" onClick={() => onRemoveProjectFile(f.id)} aria-label={`Remove ${f.name}`}>×</button>
                  </li>
                ))}
              </ul>
              <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden onChange={(e) => { onAddProjectFiles([...e.target.files]); e.target.value = ''; }} />
              <div className="btnrow">
                <button className="btn btn--tiny" onClick={() => fileRef.current?.click()} disabled={fileBusy}>{fileBusy ? 'READING…' : '+ ADD FILES'}</button>
                <button className="btn btn--tiny btn--ghost" onClick={() => { if (confirm(`Delete project "${project.name}" and its chats?`)) onDeleteProject(project.id); }}>DELETE PROJECT</button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel frame">
        <header className="panel__head"><span>CHATS</span><em>{chats.length}</em></header>
        <div className="panel__body">
          <button className="btn btn--tiny btn--block" style={{ marginTop: 0 }} onClick={onNewChat}>+ NEW CHAT</button>
          <ul className="ws__chats">
            {chats.map((c) => (
              <li key={c.id} className={c.id === chatId ? 'on' : ''}>
                <button className="ws__chat" onClick={() => onOpenChat(c.id)} title={c.title}>
                  <span>{c.title || 'New chat'}</span><em>{ago(c.updatedAt)}</em>
                </button>
                <button className="ws__x" onClick={() => onDeleteChat(c.id)} aria-label={`Delete chat ${c.title}`}>×</button>
              </li>
            ))}
            {!chats.length && <li className="muted small">No chats yet.</li>}
          </ul>
        </div>
      </section>

      <section className="panel frame">
        <header className="panel__head"><span>MEMORY</span><em>{memory.length}</em></header>
        <div className="panel__body">
          <label className="toggle"><input type="checkbox" checked={useMemory} onChange={(e) => setUseMemory(e.target.checked)} /><span>Use memory in replies</span></label>
          <ul className="ws__mem">
            {memory.map((m) => (
              <li key={m.id}><span>{m.text}</span><button className="ws__x" onClick={() => onDeleteMemory(m.id)} aria-label="Forget">×</button></li>
            ))}
            {!memory.length && <li className="muted small">Tip: type “remember that I prefer short answers”.</li>}
          </ul>
          <form className="ws__row" onSubmit={(e) => { e.preventDefault(); if (memText.trim()) { onAddMemory(memText.trim()); setMemText(''); } }}>
            <input value={memText} onChange={(e) => setMemText(e.target.value)} placeholder="Add something to remember…" aria-label="Add memory" />
            <button className="btn btn--tiny" disabled={!memText.trim()}>SAVE</button>
          </form>
          <p className="muted small">{fmtSize(new Blob([JSON.stringify(memory)]).size)} · stored only in this browser</p>
        </div>
      </section>
    </div>
  );
}
