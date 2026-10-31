/**
 * NowDrawer.jsx — COMP-COCKPIT-RIBBON-NOW-1: the right-hand drawer a WHAT-line count opens on the Day page. One of three
 * lists (`working`, `waiting`, `landed`) with the prototype's headings. Esc, the ✕ and the scrim close it; the caller
 * returns focus to the count. A list whose source is down says "source unavailable", never an empty list.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { workingNow, waitingNow, landedSince, agoWords, sinceWords } from './nowLists.js';

const UNAVAILABLE = 'source unavailable';
const sec = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground m-0 mb-1';
const rowCls = 'flex flex-col gap-0.5 py-1.5 border-b border-border last:border-b-0 text-[13px]';
const sub = 'text-[12px] text-muted-foreground';

const unitText = (r) => [r.unit, r.title].filter(Boolean).join(' · ') || 'no unit named';

function Unavailable({ why = UNAVAILABLE }) {
  return <p className={`m-0 ${sub}`} role="status" data-testid="now-unavailable">{why}</p>;
}

function Working({ rows, now }) {
  if (rows === null) return <Unavailable />;
  if (rows.length === 0) return <p className={`m-0 ${sub}`} data-testid="now-empty">Nothing is running right now.</p>;
  return (
    <ul className="m-0 p-0 list-none" data-testid="now-rows">
      {rows.map((r, i) => (
        <li key={`${r.kind}-${r.lane}-${r.unit}-${i}`} className={rowCls} data-testid="now-row">
          <span><b>{r.lane}</b>: {unitText(r)}</span>
          <span className={sub}>{r.kind === 'job' ? 'job' : r.kind === 'compose' ? 'agent' : 'session'} · {r.since === null ? 'start not recorded' : `running ${agoWords(r.since, now)}`}</span>
        </li>
      ))}
    </ul>
  );
}

function Waiting({ lists, now }) {
  if (lists === null) return <Unavailable />;
  const groups = [['review', 'Waiting on review', lists.review], ['you', 'Waiting on you', lists.you]];
  return (
    <div className="flex flex-col gap-3">
      {groups.map(([id, label, rows]) => (
        <section key={id} data-testid={`now-group-${id}`}>
          <h3 className={sec}>{label} ({rows.length})</h3>
          {rows.length === 0 ? <p className={`m-0 ${sub}`}>None.</p> : (
            <ul className="m-0 p-0 list-none">
              {rows.map((r) => (
                <li key={r.unit} className={rowCls} data-testid="now-row">
                  <span><b>{r.lane ?? '?'}</b>: {unitText(r)}</span>
                  <span className={sub}>{r.since === null ? 'time not recorded' : `waiting ${agoWords(r.since, now)}`}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function Landed({ data, now, sinceMs }) {
  if (data === null) return <Unavailable why={sinceMs === null ? 'no earlier visit recorded' : UNAVAILABLE} />;
  return (
    <div className="flex flex-col gap-3">
      <section data-testid="now-group-landed">
        <h3 className={sec}>Landed</h3>
        {data.rows.length === 0 ? <p className={`m-0 ${sub}`}>Nothing has landed since then.</p> : (
          <ul className="m-0 p-0 list-none">
            {data.rows.map((r) => (
              <li key={r.unit} className={rowCls} data-testid="now-row">
                <span><b>{r.lane ?? '?'}</b>: {unitText(r)}</span>
                <span className={sub}>{r.state} · landed {sinceWords(r.landedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="now-group-also">
        <h3 className={sec}>Also</h3>
        {data.also === null ? <Unavailable /> : data.also.length === 0 ? <p className={`m-0 ${sub}`}>No deploys or decisions.</p> : (
          <ul className="m-0 p-0 list-none">
            {data.also.map((m, i) => (
              <li key={`${m.kind}-${m.at}-${i}`} className={rowCls} data-testid="now-also-row">
                <span><b>{m.kind === 'decide' ? 'Decision' : m.kind === 'deployFail' ? 'Deploy failed' : 'Deployed'}</b> · {m.lane}: {m.text || unitText(m)}</span>
                <span className={sub}>{sinceWords(m.at, now)}</span>
              </li>
            ))}
          </ul>
        )}
        {data.alsoPartial && <p className={`m-0 mt-1 ${sub}`} data-testid="now-also-partial">The ribbon window starts after that time, so older deploys and decisions are not listed.</p>}
      </section>
    </div>
  );
}

export default function NowDrawer({ kind, onClose, fleet, index, feed, agent, lastVisitAt = null, now = Date.now() }) {
  const closeRef = useRef(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const working = useMemo(() => (kind === 'working' ? workingNow(fleet, feed, agent, now) : null), [kind, fleet, feed, agent, now]);
  const waiting = useMemo(() => (kind === 'waiting' ? waitingNow(index) : null), [kind, index]);
  const landed = useMemo(() => (kind === 'landed' ? landedSince(index, lastVisitAt, feed) : null), [kind, index, lastVisitAt, feed]);

  let title; let line; let body;
  if (kind === 'working') {
    title = working === null ? 'Working' : `${working.length} working`;
    line = 'Agents running a unit right now';
    body = <Working rows={working} now={now} />;
  } else if (kind === 'waiting') {
    title = waiting === null ? 'Waiting' : `${waiting.review.length + waiting.you.length} waiting`;
    line = waiting === null ? 'Units waiting on a review or on you' : `review ${waiting.review.length}, you ${waiting.you.length}`;
    body = <Waiting lists={waiting} now={now} />;
  } else {
    title = landed === null ? 'Landed since you left' : `${landed.rows.length} landed since you left`;
    line = lastVisitAt === null ? 'No earlier visit recorded' : `Since ${sinceWords(lastVisitAt, now)}, newest first`;
    body = <Landed data={landed} now={now} sinceMs={lastVisitAt} />;
  }

  return (
    <div className="fixed inset-0 z-40" data-testid="now-drawer-root">
      <button type="button" className="absolute inset-0 bg-black/30 cursor-default" aria-label="Close the list" tabIndex={-1} data-testid="now-scrim" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={title} data-kind={kind} data-testid="now-drawer" className="absolute right-0 top-0 h-full w-[min(420px,100vw)] bg-background border-l border-border shadow-xl flex flex-col">
        <header className="flex items-start justify-between gap-2 p-3 border-b border-border">
          <div>
            <h2 className="m-0 text-[15px] font-semibold" data-testid="now-title">{title}</h2>
            <p className={`m-0 ${sub}`} data-testid="now-subline">{line}</p>
          </div>
          <button ref={closeRef} type="button" className="text-[14px] text-muted-foreground hover:text-foreground px-1" aria-label="Close" data-testid="now-close" onClick={onClose}>✕</button>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <h3 className={sec} data-testid="now-section">{kind === 'working' ? 'Working now' : kind === 'waiting' ? 'Waiting now' : ''}</h3>
          {body}
        </div>
      </aside>
    </div>
  );
}
