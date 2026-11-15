/**
 * ContextDocTab — COMP-PROJECT-GRAPH-DOC-PANEL-1 r2: the Doc tab of the right panel's item detail.
 *
 * A project graph double-click reads the item's design doc from its owning module and hands it here as
 * `doc` = {loading} | {error} | {text, path}. The doc renders with MarkdownViewer (the Library and gates renderer).
 * A missing doc and a failed read say so in words; the tab is never empty.
 */
import React from 'react';
import MarkdownViewer from '../vision/shared/MarkdownViewer.jsx';

const NO_DOC = /no (design )?doc|^no item/i;

export default function ContextDocTab({ doc }) {
  if (!doc) return null;
  return (
    <div className="p-3 text-sm" data-testid="context-doc">
      {doc.path ? <p className="mb-2 truncate text-[10px] text-muted-foreground" title={doc.path} data-testid="context-doc-path">{doc.path}</p> : null}
      {doc.loading ? <p className="text-xs text-muted-foreground" data-testid="context-doc-loading">Loading the doc…</p> : null}
      {doc.error ? (
        <p className="text-xs" style={{ color: 'hsl(var(--warning))' }} data-testid="context-doc-error">
          {NO_DOC.test(doc.error) ? `No design doc for this item: ${doc.error}` : `Could not load the doc: ${doc.error}`}
        </p>
      ) : null}
      {!doc.loading && !doc.error ? (
        doc.text?.trim()
          ? <div data-testid="context-doc-text"><MarkdownViewer content={doc.text} /></div>
          : <p className="text-xs" style={{ color: 'hsl(var(--warning))' }} data-testid="context-doc-error">No design doc for this item: the file is empty.</p>
      ) : null}
    </div>
  );
}
