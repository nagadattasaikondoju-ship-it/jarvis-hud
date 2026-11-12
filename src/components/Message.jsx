import React, { useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

function Md({ text }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text || '')), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export default function Message({ m, onSpeak }) {
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
  return (
    <div className={`msg ${isUser ? 'msg--user' : 'msg--ai'}`}>
      <div className="msg__head">
        <span className="msg__tag">{isUser ? 'YOU' : 'JARVIS'}</span>
        <span className="msg__time">{fmtTime(m.ts)}</span>
        {!isUser && m.stats ? <span className="msg__stats">{m.stats}</span> : null}
        {!isUser && m.content && !m.pending ? (
          <button className="msg__btn" onClick={() => onSpeak(m.content)} title="Read aloud" aria-label="Read aloud">
            ◉ VOICE
          </button>
        ) : null}
      </div>
      {m.steps?.length ? (
        <ul className="msg__steps" aria-label="Agent activity">
          {m.steps.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      ) : null}
      {m.reasoning ? (
        <div className="msg__reason">
          <button className="msg__btn" onClick={() => setShowR(!showR)} aria-expanded={showR}>
            {showR ? '▾' : '▸'} REASONING TRACE {m.pending && !m.content ? '· live' : ''}
          </button>
          {showR ? <pre>{m.reasoning}</pre> : null}
        </div>
      ) : null}
      {m.content ? <Md text={m.content} /> : m.pending ? <div className="dots"><i /><i /><i /></div> : null}
      {m.error ? <div className="msg__err">⚠ {m.error}</div> : null}
    </div>
  );
}
