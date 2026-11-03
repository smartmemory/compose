import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WikiDataProvider, FeatureHub, Features, Search, Decisions, Sources, AreaDocs, Ledger, wikiPath } from '@wiki/components';
import './wiki-tab.css';
import { createWikiDataClient } from '../../lib/clients/wiki.js';
import PaneSwitcher, { usePaneMemory } from './PaneSwitcher.jsx';
import { useHostScope } from './HostScopeChip.jsx';
import { useNavigation } from '../../lib/navigation.jsx';

// COMP-COCKPIT-TAB-DEPTH-1: the eight panes sit in a pane switcher, not a tab row. WIKI-UI-LINKS-1: the `full` pane is "Document": the last clicked doc, framed alone.
const PANES = [
  { key: 'search', label: 'Search' }, { key: 'graph', label: 'Graph' }, { key: 'area', label: 'Area' }, { key: 'feature', label: 'Feature' },
  { key: 'decisions', label: 'Decisions' }, { key: 'sources', label: 'Sources' }, { key: 'ledger', label: 'Ledger' }, { key: 'full', label: 'Document' },
];
export const PANE_KEYS = PANES.map((p) => p.key);

// COMPOSE-WIKI-GRAPH-1b: the Graph (2D, 3D and WebGL inside it) is its own package entry, loaded only when someone opens it:
// WikiView is statically imported by App.jsx, so the cockpit chunk must not grow.
const graphEntry = () => import('@wiki/components/graph');
const GraphPage = lazy(() => graphEntry().then((m) => ({ default: m.GraphPage })));
const GraphHost = lazy(() => graphEntry().then((m) => ({ default: m.GraphHost })));

// COMP-ROADMAP-DOC-LINKS-1: a repo doc path (`docs/features/<CODE>/design.md`) opens as the wiki note for that file.
// The wiki addresses notes by doc id, so the path is matched against the feature hub's doc list (every DocItem carries both).
export const featureOfDocPath = (docPath) => /^docs\/features\/([^/]+)\//.exec(docPath ?? '')?.[1] ?? null;
const samePath = (wikiPathValue, docPath) => wikiPathValue === docPath || wikiPathValue?.endsWith(`/${docPath}`) || docPath.endsWith(`/${wikiPathValue}`);
/** @returns {Promise<{kind:'note', workspace:string, docId:string}|null>} null when the feature's hub lists no such file. */
export async function findDocTarget(client, { workspace, docPath, featureId }) {
  if (!workspace || !docPath || !featureId) return null;
  const hub = await client.featureHub({ workspace, featureId });
  const hit = (hub?.items ?? []).find((d) => d?.doc_id && samePath(d.path, docPath));
  return hit ? { kind: 'note', workspace, docId: hit.doc_id } : null;
}

// COMP-WIKI-DOC-PATH-LINKS-1: any other repo path (`coordination/ledger.md#L12`) resolves through the wiki's path lookup
// (`docByPath`, Compose's `/api/wiki/query/doc_by_path`). A `#...` anchor is dropped before the lookup: the wiki's note page
// opens at the top (it has no line anchor). The hub is asked first, so a feature doc opens exactly as before.
export const docFileOf = (docPath) => (typeof docPath === 'string' ? docPath.replace(/#.*$/, '') : '');
/** @returns {Promise<{kind:'note', workspace:string, docId:string}|null>} null (with one WARNING naming the path) when nothing holds it. */
export async function resolveDocTarget(client, { workspace, docPath, featureId, warn = console.warn }) {
  const file = docFileOf(docPath);
  if (!workspace || !file) return null;
  const hub = featureId ? await findDocTarget(client, { workspace, docPath: file, featureId }).catch(() => null) : null;
  if (hub) return hub;
  try {
    const hit = await client.docByPath({ workspace, path: file });
    if (typeof hit?.id === 'string' && hit.id) return { kind: 'note', workspace, docId: hit.id };
    warn(`[wiki] no wiki doc for ${file}: the lookup answered no id; the feature hub stays open`);
  } catch (e) {
    warn(`[wiki] no wiki doc for ${file} (${e?.code ?? 'error'}); the feature hub stays open`);
  }
  return null;
}

/** Compose's resolved colour mode as the Graph's `useColorMode` wants it: `{resolved}`. Read from `<html class="dark">`, which App.jsx owns; never written here. */
function useHtmlColorMode() {
  const read = () => (typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const [resolved, setResolved] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setResolved(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return { resolved };
}

// WIKI-UI-LINKS-1: the wiki's embed route (`/ui/embed/w/:workspace/note`, document body only) posts `{source, type: 'navigate', target}` to
// its parent for every link; the target is a NavTarget (@wiki/components data-client.d.ts). Only a well-formed one is routed.
export const WIKI_MESSAGE_SOURCE = 'smartmemory-wiki';
const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
export function validTarget(t) {
  if (!t || typeof t !== 'object') return false;
  switch (t.kind) {
    case 'note': return str(t.workspace) && str(t.docId);
    case 'feature': return str(t.featureId);
    case 'features': return true;
    case 'area': return str(t.area);
    case 'source': return str(t.workspace) && str(t.source);
    case 'search': return t.query === undefined || typeof t.query === 'string';
    default: return false;
  }
}

/** The NavTarget a wiki app path names (the Graph's links are paths): a note, a feature, an area, a search; null for any other (graph, folder, ...). */
export function targetOfPath(to) {
  let u;
  try { u = new URL(to, 'http://wiki.invalid'); } catch { return null; }
  const note = /^\/w\/([^/]+)\/note$/.exec(u.pathname);
  if (note && u.searchParams.get('id')) return { kind: 'note', workspace: decodeURIComponent(note[1]), docId: u.searchParams.get('id') };
  const feature = /^\/feature\/([^/]+)$/.exec(u.pathname);
  if (feature) return { kind: 'feature', featureId: decodeURIComponent(feature[1]) };
  const area = /^\/area\/([^/]+)$/.exec(u.pathname);
  if (area) return { kind: 'area', area: decodeURIComponent(area[1]) };
  if (u.pathname === '/search') return { kind: 'search', query: u.searchParams.get('q') ?? '' };
  return null;
}

/** The framed document: the wiki's embed route for one doc, in the parent's colour mode (`theme` is what Compose's `<html class>` says). */
export const documentSrc = (frameBase, { workspace, docId }, theme) => `${frameBase}/ui/embed/w/${encodeURIComponent(workspace)}/note?${new URLSearchParams({ id: docId, theme })}`;

/** Feature codes and areas for the two boxes' suggestions: one page of the wiki's feature list (`featuresPage`, 50 rows), a client without it offers none. */
function useSuggestions(client, workspace) {
  const [s, setS] = useState({ codes: [], areas: [] });
  useEffect(() => {
    if (typeof client?.featuresPage !== 'function' || !workspace) return undefined;
    let live = true;
    Promise.resolve(client.featuresPage({ workspace, size: 50 }))
      .then((r) => {
        if (!live) return;
        const items = r?.items ?? [];
        setS({ codes: items.map((f) => ({ id: f.feature_id, title: f.title })), areas: [...new Set(items.flatMap((f) => f.areas ?? []))].sort() });
      })
      .catch((e) => console.warn(`[wiki] no feature or area suggestions: ${e?.code ?? e?.message ?? 'error'}`));
    return () => { live = false; };
  }, [client, workspace]);
  return s;
}

// The Graph keeps its whole view state in URL params; Compose has no router, so they live in this view's state (the window URL is never written).
const GRAPH_ASPECT_HINT = 'grouping by feature aspect is not built yet';

/**
 * Wiki tab (COMPOSE-WIKI-TAB-1): the wiki's FeatureHub, Search, Decisions, Sources, AreaDocs, Ledger and Graph screens from `@wiki/components`,
 * fed by Compose's DataClient (all data through `/api/wiki`, `wiki-eng` only), plus the Document pane (WIKI-UI-LINKS-1):
 * the last clicked doc in a frame of the wiki's embed route (body only, in Compose's colour mode; it rides the browser's wiki sign-in,
 * WIKI-FRAME-LOOSEN-1 lets http://127.0.0.1:4001 and :5195 frame it) whose links come back by postMessage. A `feature` target opens the
 * Compose feature when the roadmap holds it. Navigation is this component's state; the screens never route.
 * `client` is injectable for tests. `docOpen` ({path}, a new object per request) opens that repo doc as a wiki note (the hub's
 * list, else the wiki's path lookup); a doc neither finds leaves the feature hub open, with a console WARNING naming the path.
 * COMP-SUBAPP-HOST-1: `host` (contracts/subapp-host.schema.json) goes into the provider; its selected feature wins over
 * `featureCode` (the session's, a display fallback) and opens that feature's hub. The chip's × goes back to Search, unscoped.
 */
export default function WikiView({ featureCode: fallbackCode, host, workspace, frameBase, client, docOpen, availability, urlPane, onPaneChange }) {
  const dataClient = useMemo(() => client ?? createWikiDataClient(), [client]);
  const scoped = useHostScope(host, 'wiki');
  const featureCode = scoped.scope ? (scoped.cleared ? '' : scoped.scope.value) : (fallbackCode ?? '');
  const [code, setCode] = useState(featureCode);
  const [draft, setDraft] = useState(featureCode);
  // COMP-COCKPIT-WIKI-TAB-ORDER-1: open on Search, the widest view; a caller deep-linking a feature (featureCode) still lands on its hub.
  // COMP-UI-LINKS-3: `urlPane` (the shell's `?pane=`) opens that pane, and again on Back; `onPaneChange` tells the shell which pane is showing.
  const wantPane = PANE_KEYS.includes(urlPane) ? urlPane : null;
  const [pane, setPane] = usePaneMemory('wiki', wantPane ?? (featureCode ? 'feature' : 'search'), PANE_KEYS, !!featureCode || !!wantPane);
  useEffect(() => { if (wantPane && wantPane !== pane) setPane(wantPane); }, [wantPane]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onPaneChange?.(pane); }, [pane]); // eslint-disable-line react-hooks/exhaustive-deps
  const [search, setSearch] = useState({ query: featureCode, workspace: undefined });
  const [doc, setDoc] = useState(null); // WIKI-UI-LINKS-1: the last clicked doc, {workspace, docId}
  const nav = useNavigation();
  const suggestions = useSuggestions(dataClient, workspace);
  const frameRef = useRef(null);
  const [area, setArea] = useState('');
  const [areaDraft, setAreaDraft] = useState('');
  const graphParamsRef = useRef(new URLSearchParams());
  const [graphParams, setGraphParamsState] = useState(graphParamsRef.current);
  const colorMode = useHtmlColorMode();

  // A new selected feature replaces the code and prefills Search with it; after mount it also opens that feature's hub
  // when the HOST scope moved (COMP-SUBAPP-HOST-1; a session's feature change only prefills Search), and the chip's clear empties both and goes back to Search.
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    if (!featureCode && !scoped.cleared) return;
    setCode(featureCode);
    setDraft(featureCode);
    setSearch({ query: featureCode, workspace: undefined });
    if (!first && (scoped.scope || scoped.cleared)) setPane(featureCode ? 'feature' : 'search');
  }, [featureCode]); // eslint-disable-line react-hooks/exhaustive-deps

  // COMP-UI-LINKS-3: a request made while the workspace is still null (the availability fetch is in flight) waits for it and then opens,
  // once: `handledDoc` is the request object already resolved, so a later workspace change does not reopen it. A Wiki that resolves
  // to unavailable never gets a workspace; `docWaiting` then says so in the pane.
  const handledDoc = useRef(null);
  useEffect(() => {
    const docPath = docOpen?.path;
    if (!docPath || !workspace || handledDoc.current === docOpen) return undefined;
    let live = true;
    const done = (fn) => { if (!live) return; handledDoc.current = docOpen; fn(); };
    resolveDocTarget(dataClient, { workspace, docPath, featureId: featureOfDocPath(docFileOf(docPath)) ?? featureCode })
      .then((target) => done(() => { if (target) onNavigate(target); else setPane('feature'); }))
      .catch(() => done(() => setPane('feature')));
    return () => { live = false; };
  }, [docOpen, workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  const docWaiting = docOpen?.path && !workspace && (availability === 'no' || availability === 'yes') ? docOpen.path : null;

  const appUrl = `${frameBase}/ui/`;
  const hrefFor = (target) => `${frameBase}/ui${wikiPath(target)}`;
  const showHub = (featureId) => { setCode(featureId); setDraft(featureId); setSearch({ query: featureId, workspace: undefined }); setPane('feature'); };
  // A feature target opens the Compose feature (the cockpit's own open-feature path) when the roadmap holds it, else the wiki's hub for it in the Feature pane.
  const onNavigate = (target) => {
    if (target.kind === 'search') setSearch({ query: target.query ?? '', workspace: target.workspace });
    else if (target.kind === 'area') { setArea(target.area); setAreaDraft(target.area); setPane('area'); }
    else if (target.kind === 'feature') {
      if (nav?.canNavigate?.('feature', target.featureId)) nav.openFeature(target.featureId); else showHub(target.featureId);
    } else if (target.kind === 'features') { setCode(''); setDraft(''); setPane('feature'); }
    else if (target.kind === 'note') { setDoc({ workspace: target.workspace, docId: target.docId }); setPane('full'); }
    else window.open(hrefFor(target), '_blank', 'noopener'); // a source's folder view: the wiki app, in its own tab
  };
  // A row of the Features list sets the code and opens its hub, here (not the Compose item): the list is the wiki's.
  const pickFeature = (target) => (target.kind === 'feature' ? showHub(target.featureId) : onNavigate(target));
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  useEffect(() => {
    let origin = null;
    try { origin = new URL(frameBase).origin; } catch { /* no frame base: no frame */ }
    const onMessage = (e) => {
      if (!origin || e.origin !== origin || !frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data;
      if (d?.source !== WIKI_MESSAGE_SOURCE || d.type !== 'navigate' || !validTarget(d.target)) return;
      onNavigateRef.current(d.target);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameBase]);
  const open = (next) => {
    if (next === 'search') setSearch({ query: code, workspace: undefined });
    setPane(next);
  };
  const submit = (e) => {
    e.preventDefault();
    const next = draft.trim();
    setCode(next);
    setSearch({ query: next, workspace: undefined });
  };
  const submitArea = (e) => {
    e.preventDefault();
    setArea(areaDraft.trim());
  };
  // react-router's setter shape: a value or an updater of the CURRENT params (the ref, so two calls in one handler both land). `replace` has no meaning here.
  const setGraphParams = useCallback((next) => {
    const resolved = new URLSearchParams(typeof next === 'function' ? next(graphParamsRef.current) : next);
    graphParamsRef.current = resolved;
    setGraphParamsState(resolved);
  }, []);
  // A graph link routes like any other screen's link (a note opens in the Document pane, a feature as a feature); a path with no target
  // (the graph itself, a folder) opens the wiki app in its own tab. Modified clicks go to the browser.
  const GraphLink = useMemo(() => function GraphLink({ to, children, ...rest }) {
    const click = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || typeof to !== 'string' || !to.startsWith('/')) return;
      e.preventDefault();
      const target = targetOfPath(to);
      if (target) onNavigateRef.current(target); else window.open(`${frameBase}/ui${to}`, '_blank', 'noopener');
    };
    return <a href={`${frameBase}/ui${to}`} onClick={click} {...rest}>{children}</a>;
  }, [frameBase]);
  const graphHost = useMemo(() => ({
    workspace,
    useSearchParams: () => [graphParams, setGraphParams],
    Link: GraphLink,
    useColorMode: () => colorMode,
    aspectHint: GRAPH_ASPECT_HINT,
  }), [workspace, graphParams, setGraphParams, GraphLink, colorMode]);
  // The wiki lists 127.0.0.1 parents only (a `localhost` page is another site: no cookie, no frame).
  const frameable = typeof window === 'undefined' || window.location.hostname === '127.0.0.1';

  return (
    <WikiDataProvider client={dataClient} host={scoped.host}>
      <div className="wiki-tab h-full flex flex-col min-h-0" data-testid="wiki-view">
        <PaneSwitcher
          panes={PANES}
          active={pane}
          onChange={open}
          label="Wiki panes"
          trailing={(
            <>
              <form onSubmit={submit}>
                <input
                  aria-label="Feature code"
                  list="wiki-feature-codes"
                  className="h-7 w-48 rounded border border-border bg-background px-2 text-sm font-mono"
                  placeholder="Feature code"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <datalist id="wiki-feature-codes">{suggestions.codes.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</datalist>
              </form>
              {scoped.chip}
              <span className="ml-auto text-xs text-muted-foreground">{workspace}</span>
            </>
          )}
        />
        {docWaiting && (
          <p className="px-3 py-2 text-xs text-muted-foreground border-b border-border" data-testid="wiki-doc-unavailable">
            The Wiki is not available here, so {docWaiting} cannot be opened.
            {availability === 'yes' ? ' The Wiki answered without a workspace.' : ' Its package is not built in, or the project has no wiki configured.'}
          </p>
        )}
        <div className={`flex-1 min-h-0 ${pane === 'full' ? 'flex flex-col' : pane === 'graph' ? 'relative' : 'overflow-auto p-4'}`}>
          {pane === 'feature' && (code
            ? <FeatureHub featureId={code} workspace={workspace} onNavigate={onNavigate} hrefFor={hrefFor} />
            : <Features workspace={workspace} onNavigate={pickFeature} hrefFor={hrefFor} />)}
          {pane === 'search' && (
            <Search query={search.query} workspace={search.workspace} workspaces={[workspace]} onNavigate={onNavigate} hrefFor={hrefFor} />
          )}
          {pane === 'decisions' && <Decisions workspace={workspace} onNavigate={onNavigate} hrefFor={hrefFor} />}
          {pane === 'sources' && <Sources workspace={workspace} onNavigate={onNavigate} hrefFor={hrefFor} />}
          {pane === 'area' && (
            <>
              <form onSubmit={submitArea} className="mb-4">
                <input
                  aria-label="Area"
                  list="wiki-areas"
                  className="h-7 w-64 rounded border border-border bg-background px-2 text-sm font-mono"
                  placeholder="Area name"
                  maxLength={200}
                  value={areaDraft}
                  onChange={(e) => setAreaDraft(e.target.value)}
                />
                <datalist id="wiki-areas">{suggestions.areas.map((a) => <option key={a} value={a} />)}</datalist>
              </form>
              {area
                ? <AreaDocs area={area} workspace={workspace} onNavigate={onNavigate} hrefFor={hrefFor} />
                : <p className="text-sm text-muted-foreground">Type an area name above, or follow an area link on a doc.</p>}
            </>
          )}
          {pane === 'ledger' && <Ledger workspace={workspace} onNavigate={onNavigate} hrefFor={hrefFor} />}
          {pane === 'graph' && (
            <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading the graph…</p>}>
              <GraphHost value={graphHost}><GraphPage /></GraphHost>
            </Suspense>
          )}
          {pane === 'full' && (
            <>
              {!frameable && (
                <p className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
                  The wiki can be framed only by Compose opened at http://127.0.0.1:5195 or :4001. <a className="underline" href={appUrl} target="_blank" rel="noopener">Open it in a new tab</a>.
                </p>
              )}
              {doc
                ? <iframe ref={frameRef} title="wiki" src={documentSrc(frameBase, doc, colorMode.resolved)} referrerPolicy="origin" className="flex-1 w-full border-0 bg-background" />
                : (
                  <div className="p-4 text-sm text-muted-foreground" data-testid="document-empty">
                    <p>Click a document in Search, Decisions, Ledger or the Graph to read it here.</p>
                    <p className="mt-2"><a className="underline" href={appUrl} target="_blank" rel="noopener">Open the wiki app in a new tab</a></p>
                  </div>
                )}
            </>
          )}
        </div>
      </div>
    </WikiDataProvider>
  );
}
