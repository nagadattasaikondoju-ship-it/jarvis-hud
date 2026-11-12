import React, { useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Dashboard, extractHtml } from './ArtifactPanel.jsx';
import { fmtSize } from '../files.js';

marked.setOptions({ breaks: true, gfm: true });

function Md({ text }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || '')), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const FILE_ICON = { docx: 'W', pptx: 'P', xlsx: 'X', pdf: 'PDF' };

export default function Message({ m, onSpeak, onOpenArtifact, onDownloadFile, onExport, onOpenFile }) {
  const [showR, setShowR] = useState(false);
  if (m.role === 'system') {
    return (
      <div className={`msg msg--sys ${m.level ? `msg--${m.level}` : ''}`}>
        <span className="msg__tag">SYS {fmtTime(m.ts)}</span>
        <Md text={m.content} />
      </div>
    );
  }
  const isUser = m.role === 'user';
  const html = !isUser && !m.pending ? extractHtml(m.content) : null;
  const shown = html ? m.content.replace(/```html[\s\S]*?(```|$)/i, '') : m.content;
  return (
    <div className={`msg ${isUser ? 'msg--user' : 'msg--ai'}`}>
      <div className="msg__head">
        <span className="msg__tag">{isUser ? 'YOU' : 'JARVIS'}</span>
        <span className="msg__time">{fmtTime(m.ts)}</span>
        {m.modeLabel ? <span className="msg__mode">{m.modeLabel}</span> : null}
        {!isUser && m.stats ? <span className="msg__stats">{m.stats}</span> : null}
        {!isUser && m.content && !m.pending ? (
          <>
            <button className="msg__btn" onClick={() => onSpeak(m.content)} title="Read aloud">◉ VOICE</button>
            {!m.file && !m.dashboard && (
              <>
                <button className="msg__btn" onClick={() => onExport(m, 'docx')} title="Download this answer as Word">⬇ DOCX</button>
                <button className="msg__btn" onClick={() => onExport(m, 'pdf')} title="Download this answer as PDF">⬇ PDF</button>
              </>
            )}
          </>
        ) : null}
      </div>

      {m.attachments?.length ? (
        <div className="atts">
          {m.attachments.map((a) => (
            <span className="att" key={a.id} title={a.name}>
              {a.thumb ? <img src={a.thumb} alt="" /> : <i>{a.kind === 'pdf' ? 'PDF' : a.kind === 'sheet' ? 'XLS' : a.kind === 'docx' ? 'DOC' : 'TXT'}</i>}
              <span>{a.name}</span>
              <em>{fmtSize(a.size || 0)}</em>
            </span>
          ))}
        </div>
      ) : null}

      {m.steps?.length ? (
        <ul className="msg__steps" aria-label="Agent activity">{m.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
      ) : null}

      {m.reasoning ? (
        <div className="msg__reason">
          <button className="msg__btn" onClick={() => setShowR(!showR)} aria-expanded={showR}>
            {showR ? '▾' : '▸'} REASONING TRACE {m.pending && !m.content ? '· live' : ''}
          </button>
          {showR ? <pre>{m.reasoning}</pre> : null}
        </div>
      ) : null}

      {m.file ? (
        <div className="filecard frame">
          <i className={`filecard__ic filecard__ic--${m.file.format}`}>{FILE_ICON[m.file.format]}</i>
          <div>
            <b>{m.file.spec.title || 'Untitled'}</b>
            <span>{m.file.label}</span>
          </div>
          <button className="btn" onClick={() => onDownloadFile(m)}>DOWNLOAD</button>
        </div>
      ) : null}

      {m.dashboard ? (
        <div className="dashprev">
          <Dashboard spec={m.dashboard} compact />
          <button className="btn btn--tiny" onClick={() => onOpenArtifact({ kind: 'dashboard', spec: m.dashboard })}>◳ OPEN FULL DASHBOARD</button>
        </div>
      ) : null}

      {html ? (
        <button className="artbtn frame" onClick={() => onOpenArtifact({ kind: 'html', html, title: (m.content.replace(/```[\s\S]*?(```|$)/g, '').trim().split('\n')[0] || 'Artifact').slice(0, 60) })}>
          <i>◳</i><span><b>Open artifact</b><em>Runs in a safe sandbox · {Math.max(1, Math.round(html.length / 1024))} KB</em></span>
        </button>
      ) : null}

      {shown?.trim() ? <Md text={shown} /> : m.pending ? (
        <div className="dots-wrap"><div className="dots"><i /><i /><i /></div>{m.progress ? <span className="msg__progress">{m.progress}</span> : null}</div>
      ) : null}

      {m.sources?.length ? (
        <ol className="sources">
          {m.sources.map((s, i) => (
            s.local ? (
              <li key={i}><span className="src-local" title={s.url}>📄 {s.title}</span>{onOpenFile ? <button className="msg__btn src-open" onClick={() => onOpenFile(s.url)}>OPEN</button> : null}</li>
            ) : (
              <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a><span>{(() => { try { return new URL(s.url).hostname.replace(/^www\./, ''); } catch { return ''; } })()}</span></li>
            )
          ))}
        </ol>
      ) : null}

      {m.error ? <div className="msg__err">⚠ {m.error}</div> : null}
    </div>
  );
}
