/**
 * ContextSources — COMP-SUBAPP-CONTEXT-1: for the selected feature code, four cards: its Roadmap item (the store, no fetch),
 * the Wiki hub, the last Stratum run and the Cadence unit(s). The three reads go only through the existing data clients
 * (`createWikiDataClient().featureHub`, `createStratumDataClient().listRuns`, `createCadenceDataClient().getBelt`).
 *
 * Every source is in exactly one of five states and each names its source: loading, data, "No <source> data for <code>" (the read
 * succeeded, nothing matched), "<source> unavailable" (the read failed or the body is not the contract's shape; one WARNING),
 * "<source> not connected" (availability `no`; the client is not called). Reads happen when the feature code changes, never on a timer.
 *
 * Props: featureCode, item, availability {stratum, cadence, wiki}, wikiWorkspace, clients {stratum, cadence, wiki} (tests inject).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { createStratumDataClient } from '../../lib/clients/stratum.js';
import { createCadenceDataClient } from '../../lib/clients/cadence.js';
import { createWikiDataClient } from '../../lib/clients/wiki.js';
import { useNavigation } from '../../lib/navigation.jsx';
import {
  SOURCES, pickLastRun, pickUnits, pickHub, roadmapOf, sourceGate, stateLine,
} from './contextSources.js';

const MAX_UNITS = 5;

/**
 * One source's read for `key`. The result remembers the key it answered, so an answer for a previous feature is never
 * shown for the current one (it reads as loading), and an effect that outlives its key drops its answer.
 * @returns {{state: 'loading'|'notConnected'|'data'|'empty'|'unavailable', value: any}}
 */
function useSourceRead({ source, key, availability, ready = true, read, pick }) {
  const [answer, setAnswer] = useState(null);
  const gate = sourceGate(availability);
  useEffect(() => {
    if (!key || gate === 'notConnected' || !ready) return undefined;
    let live = true;
    Promise.resolve()
      .then(read)
      .then((body) => {
        const value = pick(body);
        if (live) setAnswer({ key, state: value === null ? 'empty' : 'data', value });
      })
      .catch((err) => {
        console.warn(`[context-sources] ${SOURCES[source]} unavailable for ${key}: ${err?.message ?? err}`);
        if (live) setAnswer({ key, state: 'unavailable', value: null });
      });
    return () => { live = false; };
    // read and pick are rebuilt per render by the caller; a read is keyed by the feature code, workspace and gate alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, gate, ready]);
  if (gate === 'notConnected') return { state: 'notConnected', value: null };
  if (!answer || answer.key !== key) return { state: 'loading', value: null };
  return answer;
}

const btn = 'text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2';

function Card({ source, state, code, children }) {
  return (
    <div
      data-testid={`context-source-${source}`}
      data-state={state}
      className="rounded border px-3 py-2 text-[12px]"
      style={{ borderColor: 'hsl(var(--border))' }}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">{SOURCES[source]}</p>
      {state === 'data' ? children : <p data-testid={`context-source-${source}-line`}>{stateLine(source, state, code)}</p>}
    </div>
  );
}

export default function ContextSources({ featureCode, item, availability = {}, wikiWorkspace = null, clients = {} }) {
  const nav = useNavigation();
  const stratum = useMemo(() => clients.stratum ?? createStratumDataClient(), [clients.stratum]);
  const cadence = useMemo(() => clients.cadence ?? createCadenceDataClient(), [clients.cadence]);
  const wiki = useMemo(() => clients.wiki ?? createWikiDataClient(), [clients.wiki]);

  const roadmap = roadmapOf(item, featureCode);
  // The wiki read needs the wiki's served workspace: while availability is still unknown the card waits for it; once the wiki
  // is `yes` with no workspace the read is attempted with none and fails honestly (unavailable).
  const wikiReady = Boolean(wikiWorkspace) || availability.wiki === 'yes';
  const hubRead = useSourceRead({
    source: 'wiki', key: featureCode, availability: availability.wiki, ready: wikiReady,
    read: () => wiki.featureHub({ workspace: wikiWorkspace, featureId: featureCode }),
    pick: pickHub,
  });
  const runRead = useSourceRead({
    source: 'stratum', key: featureCode, availability: availability.stratum,
    read: () => stratum.listRuns(),
    pick: (runs) => pickLastRun(runs, featureCode),
  });
  const unitRead = useSourceRead({
    source: 'cadence', key: featureCode, availability: availability.cadence,
    read: () => cadence.getBelt(),
    pick: (belt) => pickUnits(belt, featureCode),
  });

  if (!featureCode) return null;
  const hub = hubRead.value;
  const run = runRead.value;
  const units = unitRead.value;

  return (
    <div data-testid="context-sources" className="flex flex-col gap-2 px-4 py-2" style={{ borderTop: '1px solid hsl(var(--border))' }}>
      <Card source="roadmap" state={roadmap ? 'data' : 'empty'} code={featureCode}>
        {roadmap && (
          <p>
            <span className="font-mono">{roadmap.code}</span>
            {roadmap.title ? ` · ${roadmap.title}` : ''}
            {roadmap.status ? ` · ${roadmap.status}` : ''}
          </p>
        )}
      </Card>

      <Card source="wiki" state={hubRead.state} code={featureCode}>
        {hub && (
          <>
            <p>
              {hub.feature?.title ? `${hub.feature.title} · ` : ''}
              {hub.feature?.roadmap_status ? `${hub.feature.roadmap_status} · ` : ''}
              {hub.docCount} {hub.docCount === 1 ? 'doc' : 'docs'}
            </p>
            {nav?.openRoom && <button type="button" className={btn} onClick={() => nav.openRoom('wiki')}>Open in Wiki</button>}
          </>
        )}
      </Card>

      <Card source="stratum" state={runRead.state} code={featureCode}>
        {run && (
          <>
            <p>
              <span className="font-mono">{run.run.flowName ?? run.run.id}</span> · {run.run.displayStatus ?? run.run.status}
              {run.run.label ? ` · ${run.run.label}` : ''}
            </p>
            <p className="text-[10px] text-muted-foreground" data-testid="context-source-stratum-basis">
              {run.basis ? `latest by ${run.basis}: ${run.run[run.basis]}` : 'no timestamp recorded on this run'}
            </p>
            {nav?.openRoom && <button type="button" className={btn} onClick={() => nav.openRoom('stratum', { kind: 'run', id: run.run.id })}>Open run</button>}
          </>
        )}
      </Card>

      <Card source="cadence" state={unitRead.state} code={featureCode}>
        {units && (
          <>
            <ul>
              {units.slice(0, MAX_UNITS).map((u) => (
                <li key={`${u.lane}/${u.id}`} className="flex items-center gap-2">
                  <span className="font-mono">{u.id}</span>
                  <span className="text-muted-foreground">{u.column}{u.lane ? ` · ${u.lane}` : ''}</span>
                  {nav?.openRoom && <button type="button" className={btn} onClick={() => nav.openRoom('cadence', { kind: 'unit', id: u.id })}>Open unit {u.id}</button>}
                </li>
              ))}
            </ul>
            {units.length > MAX_UNITS && <p className="text-[10px] text-muted-foreground">+{units.length - MAX_UNITS} more</p>}
          </>
        )}
      </Card>
    </div>
  );
}
