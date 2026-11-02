import { Component, useCallback, useEffect, useState } from 'react';
import { FlowBuilder } from '@smartmemory/stratum-ui/builder';

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// COMP-UI-LINKS-1: FlowBuilder throws while rendering a document it cannot import, and the cockpit's main view has no panel boundary
// (only App's safe mode), so a run spec the builder cannot read would take the whole page down. This shows the error instead and
// clears when another document is opened.
class BuilderBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) { if (prev.doc !== this.props.doc && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div role="alert" data-testid="builder-load-error" className="p-3 text-xs text-red-400">The builder cannot open this spec: {this.state.error.message}</div>;
  }
}

/**
 * Stratum tab "New pipeline" pane (COMP-SUBAPP-STRAT-AUTHOR-1): `FlowBuilder` from
 * `@smartmemory/stratum-ui/builder` plus Save / Open, which this pane owns (FlowBuilder only hands
 * the spec out through `onChange`). Save needs the client's optional `saveSpec`, Open its `listSpecs`
 * and `readSpec`; a client without them shows neither. A server refusal (bad name, not a builder
 * file, invalid spec) is shown as the server wrote it. Rendered inside StratumView's DataClientProvider,
 * so FlowBuilder's Validate and Plan reach the same client.
 */
// COMP-UI-LINKS-1: `openRun` ({runId, stepId, at}) opens that run's own spec (`client.getRunSpec`, a read) at that step: the
// Stratum drawer's "builder" link and a run's flow name land here.
export default function StratumBuilderPane({ client, openRun = null }) {
  const canSave = typeof client?.saveSpec === 'function';
  const canOpen = typeof client?.listSpecs === 'function' && typeof client?.readSpec === 'function';
  const [spec, setSpec] = useState(null); // the latest document FlowBuilder exported, or the one opened
  const [opened, setOpened] = useState(undefined); // FlowBuilder's initialSpec: a new object only on Open
  const [name, setName] = useState('');
  const [saved, setSaved] = useState([]);
  const [status, setStatus] = useState(null); // { tone: 'ok'|'error', text, errors? }

  const refresh = useCallback(async () => {
    if (!canOpen) return;
    try {
      setSaved(await client.listSpecs());
    } catch (error) {
      setStatus({ tone: 'error', text: `Could not list saved pipelines: ${error.message}` });
    }
  }, [client, canOpen]);

  useEffect(() => { refresh(); }, [refresh]);

  const [runOpened, setRunOpened] = useState({ key: 0, stepId: null });
  useEffect(() => {
    if (!openRun?.runId) return undefined;
    let live = true;
    const read = typeof client?.getRunSpec === 'function' ? client.getRunSpec(openRun.runId) : Promise.reject(new Error('this host cannot read a run spec'));
    read.then((doc) => {
      if (!live) return;
      if (!doc) { setStatus({ tone: 'error', text: `Run ${openRun.runId} has no spec on disk` }); return; }
      setOpened(doc);
      setSpec(doc);
      setRunOpened({ key: openRun.at, stepId: openRun.stepId ?? null });
      setStatus({ tone: 'ok', text: `Opened run ${openRun.runId}'s spec${openRun.stepId ? ` at ${openRun.stepId}` : ''} (save to keep a copy)` });
    }, (error) => { if (live) setStatus({ tone: 'error', text: error.message }); });
    return () => { live = false; };
  }, [client, openRun]);

  const save = async () => {
    const result = await client.saveSpec(name, spec);
    if (result.ok) {
      setStatus({ tone: 'ok', text: `${result.created ? 'Saved' : 'Updated'} ${result.name} (pipelines/${result.name}.stratum.yaml)` });
      refresh();
    } else {
      setStatus({ tone: 'error', text: result.message, errors: result.errors });
    }
  };

  const open = async (which) => {
    try {
      const doc = await client.readSpec(which);
      if (!doc) return setStatus({ tone: 'error', text: `${which} is no longer saved` });
      setOpened(doc);
      setSpec(doc);
      setName(which);
      setStatus({ tone: 'ok', text: `Opened ${which}` });
    } catch (error) {
      setStatus({ tone: 'error', text: error.message });
    }
  };

  const nameOk = NAME.test(name);
  return (
    <div className="dark h-full flex flex-col min-h-0 bg-background text-foreground" data-testid="stratum-builder-pane">
      {(canSave || canOpen) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          {canSave && (
            <>
              <input
                aria-label="Pipeline name"
                data-testid="builder-save-name"
                className="h-7 w-56 rounded border border-border bg-background px-2 font-mono text-xs"
                placeholder="pipeline-name"
                value={name}
                onChange={(e) => setName(e.target.value.trim())}
              />
              <button
                type="button"
                data-testid="builder-save"
                className="h-7 rounded border border-border px-3 hover:bg-accent disabled:opacity-50"
                disabled={!spec || !nameOk}
                title={!spec ? 'Make an edit first' : nameOk ? `Save to pipelines/${name}.stratum.yaml` : 'Lowercase letters, digits and dashes'}
                onClick={save}
              >
                Save
              </button>
            </>
          )}
          {canOpen && (
            <label className="flex items-center gap-1 text-muted-foreground">
              Open
              <select
                aria-label="Open saved pipeline"
                data-testid="builder-open"
                className="h-7 rounded border border-border bg-background px-1 font-mono text-xs text-foreground"
                value=""
                onChange={(e) => e.target.value && open(e.target.value)}
              >
                <option value="">{saved.length ? 'saved pipelines…' : 'none saved yet'}</option>
                {saved.map((row) => <option key={row.name} value={row.name}>{row.name}</option>)}
              </select>
            </label>
          )}
          {status && (
            <div role={status.tone === 'error' ? 'alert' : 'status'} data-testid="builder-status" className={status.tone === 'error' ? 'text-red-400' : 'text-emerald-400'}>
              {status.text}
              {status.errors?.length > 0 && (
                <ul className="mt-1 list-disc pl-4 font-mono">
                  {status.errors.map((e, i) => <li key={i}>{e.path}: {e.message}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <BuilderBoundary doc={opened}>
          <FlowBuilder key={runOpened.key} initialSpec={opened} initialStepId={runOpened.stepId ?? undefined} onChange={setSpec} />
        </BuilderBoundary>
      </div>
    </div>
  );
}
