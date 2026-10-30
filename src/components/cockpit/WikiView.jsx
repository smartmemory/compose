import { useEffect, useMemo, useState } from 'react';
import { WikiDataProvider, FeatureHub, Search, Decisions, Sources, AreaDocs, Ledger, wikiPath } from '@wiki/components';
import './wiki-tab.css';
import { createWikiDataClient } from '../../lib/clients/wiki.js';

/**
 * Wiki tab (COMPOSE-WIKI-TAB-1): the wiki's FeatureHub, Search, Decisions, Sources, AreaDocs and Ledger screens from `@wiki/components`,
 * fed by Compose's DataClient (all data through `/api/wiki`, `wiki-eng` only), plus "Open full wiki":
 * the Mac wiki's own UI in a frame, which rides the browser's wiki sign-in (WIKI-FRAME-LOOSEN-1 lets
 * http://127.0.0.1:4001 and :5195 frame it). Navigation is this component's state; the screens never route.
 * `client` is injectable for tests.
 */
export default function WikiView({ featureCode, workspace, frameBase, client }) {
  const dataClient = useMemo(() => client ?? createWikiDataClient(), [client]);
  const [code, setCode] = useState(featureCode ?? '');
  const [draft, setDraft] = useState(featureCode ?? '');
  const [pane, setPane] = useState('feature');
  const [search, setSearch] = useState({ query: featureCode ?? '', workspace: undefined });
  const [framePath, setFramePath] = useState(null);
  const [area, setArea] = useState('');
  const [areaDraft, setAreaDraft] = useState('');

  // A new selected feature replaces the code and prefills Search with it.
  useEffect(() => {
    if (!featureCode) return;
    setCode(featureCode);
    setDraft(featureCode);
    setSearch({ query: featureCode, workspace: undefined });
  }, [featureCode]);

  const frameSrc = `${frameBase}/ui${framePath ?? (code ? `/feature/${encodeURIComponent(code)}` : '/')}`;
  const hrefFor = (target) => `${frameBase}/ui${wikiPath(target)}`;
  const onNavigate = (target) => {
    if (target.kind === 'search') setSearch({ query: target.query ?? '', workspace: target.workspace });
    else if (target.kind === 'area') { setArea(target.area); setAreaDraft(target.area); setPane('area'); }
    else { setFramePath(wikiPath(target)); setPane('full'); }
  };
  const open = (next) => {
    if (next === 'search') setSearch({ query: code, workspace: undefined });
    if (next === 'full') setFramePath(null);
    setPane(next);
  };
  const submit = (e) => {
    e.preventDefault();
    const next = draft.trim();
    setCode(next);
    setSearch({ query: next, workspace: undefined });
    setFramePath(null);
  };
  const submitArea = (e) => {
    e.preventDefault();
    setArea(areaDraft.trim());
  };
  const tabClass = (name) => `px-3 py-1 text-sm rounded ${pane === name ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'}`;
  // The wiki lists 127.0.0.1 parents only (a `localhost` page is another site: no cookie, no frame).
  const frameable = typeof window === 'undefined' || window.location.hostname === '127.0.0.1';

  return (
    <WikiDataProvider client={dataClient}>
      <div className="wiki-tab h-full flex flex-col min-h-0" data-testid="wiki-view">
        <nav className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0" aria-label="wiki">
          <form onSubmit={submit} className="mr-2">
            <input
              aria-label="Feature code"
              className="h-7 w-48 rounded border border-border bg-background px-2 text-sm font-mono"
              placeholder="Feature code"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </form>
          <button type="button" className={tabClass('feature')} onClick={() => open('feature')}>Feature</button>
          <button type="button" className={tabClass('search')} onClick={() => open('search')}>Search</button>
          <button type="button" className={tabClass('decisions')} onClick={() => open('decisions')}>Decisions</button>
          <button type="button" className={tabClass('sources')} onClick={() => open('sources')}>Sources</button>
          <button type="button" className={tabClass('area')} onClick={() => open('area')}>Area</button>
          <button type="button" className={tabClass('ledger')} onClick={() => open('ledger')}>Ledger</button>
          <button type="button" className={tabClass('full')} onClick={() => open('full')}>Open full wiki</button>
          <span className="ml-auto text-xs text-muted-foreground">{workspace}</span>
        </nav>
        <div className={`flex-1 min-h-0 ${pane === 'full' ? 'flex flex-col' : 'overflow-auto p-4'}`}>
          {pane === 'feature' && (code
            ? <FeatureHub featureId={code} workspace={workspace} />
            : <p className="text-sm text-muted-foreground">Select a feature, or type its code above.</p>)}
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
                  className="h-7 w-64 rounded border border-border bg-background px-2 text-sm font-mono"
                  placeholder="Area name"
                  maxLength={200}
                  value={areaDraft}
                  onChange={(e) => setAreaDraft(e.target.value)}
                />
              </form>
              {area
                ? <AreaDocs area={area} workspace={workspace} onNavigate={onNavigate} hrefFor={hrefFor} />
                : <p className="text-sm text-muted-foreground">Type an area name above, or follow an area link on a doc.</p>}
            </>
          )}
          {pane === 'ledger' && <Ledger workspace={workspace} onNavigate={onNavigate} hrefFor={hrefFor} />}
          {pane === 'full' && (
            <>
              {!frameable && (
                <p className="px-3 py-2 text-xs text-muted-foreground border-b border-border">
                  The wiki can be framed only by Compose opened at http://127.0.0.1:5195 or :4001. <a className="underline" href={frameSrc} target="_blank" rel="noopener">Open it in a new tab</a>.
                </p>
              )}
              <iframe title="wiki" src={frameSrc} referrerPolicy="origin" className="flex-1 w-full border-0 bg-background" />
            </>
          )}
        </div>
      </div>
    </WikiDataProvider>
  );
}
