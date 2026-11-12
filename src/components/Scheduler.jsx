import React, { useCallback, useEffect, useState } from 'react';
import { companion } from '../companion.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EMPTY = { name: '', prompt: '', type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5], minutes: 60, research: false, enabled: true };

export function describeSchedule(s) {
  if (!s) return '';
  if (s.type === 'daily') return `Every day at ${s.time}`;
  if (s.type === 'weekly') return `${(s.days || []).map((d) => DAYS[d]).join(', ')} at ${s.time}`;
  if (s.type === 'hourly') return 'Every hour';
  if (s.type === 'interval') return `Every ${s.minutes} min`;
  return '';
}

const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Scheduler({ cfg, online, onOpenRun, onSetup, onUnread }) {
  const [tasks, setTasks] = useState([]);
  const [runs, setRuns] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    if (!online) return;
    try {
      const [t, r] = await Promise.all([companion.tasks(cfg), companion.runs(cfg)]);
      setTasks(t.tasks || []);
      setRuns(r.runs || []);
      onUnread?.((r.runs || []).filter((x) => !x.read && x.status === 'done').length);
      setErr('');
    } catch (e) { setErr(e.message); }
  }, [cfg, online, onUnread]);

  useEffect(() => { refresh(); const i = setInterval(refresh, 20000); return () => clearInterval(i); }, [refresh]);

  const save = async () => {
    const f = form;
    if (!f.name.trim() || !f.prompt.trim()) { setErr('Give the task a name and an instruction.'); return; }
    try {
      await companion.saveTask(cfg, {
        id: f.id, name: f.name.trim(), prompt: f.prompt.trim(), research: !!f.research, enabled: f.enabled !== false,
        schedule: { type: f.type, time: f.time, days: f.days, minutes: Number(f.minutes) || 60 },
        tz_offset_min: -new Date().getTimezoneOffset(),
      });
      setForm(null);
      refresh();
    } catch (e) { setErr(e.message); }
  };

  if (!online) {
    return (
      <section className="panel frame">
        <header className="panel__head"><span>SCHEDULER</span><em>OFF</em></header>
        <div className="panel__body">
          <p className="muted small">Background tasks and web research need <b>Jarvis Companion</b> running on your PC.</p>
          <button className="btn btn--tiny btn--block" onClick={onSetup}>INSTALL COMPANION</button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel frame">
      <header className="panel__head"><span>SCHEDULER</span><em>{tasks.length} TASKS</em></header>
      <div className="panel__body">
        {err ? <p className="err small">{err}</p> : null}
        {!form && (
          <>
            <ul className="sched">
              {tasks.map((t) => (
                <li key={t.id} className={t.enabled ? '' : 'off'}>
                  <div>
                    <b>{t.name}</b>
                    <span>{describeSchedule(t.schedule)}{t.research ? ' · web' : ''}</span>
                    <em>next {when(t.next_run)}</em>
                  </div>
                  <div className="sched__btns">
                    <button className="msg__btn" onClick={async () => { await companion.runTask(cfg, t.id).catch((e) => setErr(e.message)); setTimeout(refresh, 1500); }}>RUN</button>
                    <button className="msg__btn" onClick={() => setForm({ ...EMPTY, ...t, ...t.schedule })}>EDIT</button>
                    <button className="msg__btn" onClick={async () => { if (confirm(`Delete task "${t.name}"?`)) { await companion.deleteTask(cfg, t.id); refresh(); } }}>✕</button>
                  </div>
                </li>
              ))}
              {!tasks.length && <li className="muted small">No tasks yet. Example: “Every day at 8:00 — give me a motivating quote and 3 focus tips.”</li>}
            </ul>
            <button className="btn btn--tiny btn--block" onClick={() => setForm({ ...EMPTY })}>+ NEW TASK</button>

            <div className="inbox">
              <div className="ws__label">Results inbox</div>
              <ul>
                {runs.slice(0, 8).map((r) => (
                  <li key={r.id} className={!r.read && r.status === 'done' ? 'new' : ''}>
                    <button onClick={() => { onOpenRun(r); if (!r.read) companion.markRead(cfg, r.id).then(refresh).catch(() => {}); }}>
                      <b>{r.task_name}</b>
                      <span>{r.status === 'running' ? 'running…' : r.status === 'error' ? 'failed' : when(r.finished)}</span>
                    </button>
                  </li>
                ))}
                {!runs.length && <li className="muted small">Results of scheduled tasks appear here.</li>}
              </ul>
            </div>
          </>
        )}

        {form && (
          <div className="form form--tight">
            <label>Task name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Morning briefing" /></label>
            <label>What should Jarvis do?
              <textarea rows={3} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Give me today's top tech news in 5 bullets." />
            </label>
            <label>Repeat
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="daily">Every day</option>
                <option value="weekly">On chosen days</option>
                <option value="hourly">Every hour</option>
                <option value="interval">Every N minutes</option>
              </select>
            </label>
            {(form.type === 'daily' || form.type === 'weekly') && (
              <label>Time<input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
            )}
            {form.type === 'weekly' && (
              <div className="days">
                {DAYS.map((d, i) => (
                  <label key={d} className="check">
                    <input type="checkbox" checked={form.days.includes(i)} onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, i].sort() : form.days.filter((x) => x !== i) })} />{d}
                  </label>
                ))}
              </div>
            )}
            {form.type === 'interval' && (
              <label>Minutes<input type="number" min="5" max="1440" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} /></label>
            )}
            <label className="check"><input type="checkbox" checked={form.research} onChange={(e) => setForm({ ...form, research: e.target.checked })} /> Search the web first (uses your search key)</label>
            <label className="check"><input type="checkbox" checked={form.enabled !== false} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
            <div className="btnrow">
              <button className="btn btn--tiny btn--ghost" onClick={() => setForm(null)}>CANCEL</button>
              <button className="btn btn--tiny" onClick={save}>SAVE TASK</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
