import React, { useState, useMemo, useId } from 'react';

export default function CaptureSheet({ open, onClose, onSubmit, existingClusters = [] }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [tags, setTags] = useState([]);
  const [cluster, setCluster] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);
  const clusterListId = useId();

  const dedupClusters = useMemo(() => {
    const set = new Set();
    for (const c of existingClusters) {
      if (c && typeof c === 'string') set.add(c);
    }
    return [...set].sort();
  }, [existingClusters]);

  if (!open) return null;

  function reset() {
    setTitle('');
    setDescription('');
    setTagDraft('');
    setTags([]);
    setCluster('');
    setErr(null);
    setSubmitting(false);
  }

  function close() {
    reset();
    onClose?.();
  }

  function commitTagDraft() {
    const t = tagDraft.trim();
    if (!t) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setTagDraft('');
  }

  async function handleSubmit(ev) {
    ev.preventDefault();
    if (!title.trim()) {
      setErr('Title is required');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await onSubmit?.({
        title: title.trim(),
        description: description.trim() || undefined,
        tags: tags.length ? tags : undefined,
        cluster: cluster.trim() || undefined,
      });
      close();
    } catch (e) {
      setErr(e.message || 'Failed to capture');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="m-sheet-overlay"
      data-testid="capture-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Capture idea"
      onClick={(ev) => { if (ev.target === ev.currentTarget) close(); }}
    >
      <div className="m-sheet">
        <header className="m-sheet-header">
          <button
            type="button"
            className="m-sheet-close"
            aria-label="Close capture"
            onClick={close}
            disabled={submitting}
          >×</button>
          <div className="m-sheet-title-row">
            <div className="m-sheet-title">Capture idea</div>
          </div>
        </header>

        <form className="m-sheet-body" onSubmit={handleSubmit}>
          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-capture-title">Title</label>
            <input
              id="m-capture-title"
              type="text"
              className="m-sheet-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's the idea?"
              data-testid="capture-title"
              autoFocus
              required
            />
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-capture-desc">Description (optional)</label>
            <textarea
              id="m-capture-desc"
              className="m-sheet-input m-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              data-testid="capture-description"
            />
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-capture-tag">Tags (optional)</label>
            <div className="m-tag-input-row">
              <input
                id="m-capture-tag"
                type="text"
                className="m-sheet-input"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    commitTagDraft();
                  }
                }}
                placeholder="Add tag and press Enter"
                data-testid="capture-tag-input"
              />
              <button
                type="button"
                className="m-sheet-btn m-sheet-btn-secondary m-tag-add"
                onClick={commitTagDraft}
              >Add</button>
            </div>
            {tags.length > 0 ? (
              <div className="m-idea-tags" data-testid="capture-tags">
                {tags.map(t => (
                  <span key={t} className="m-idea-tag">
                    {t}
                    <button
                      type="button"
                      className="m-tag-remove"
                      aria-label={`Remove tag ${t}`}
                      onClick={() => setTags(tags.filter(x => x !== t))}
                    >×</button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="m-sheet-section">
            <label className="m-sheet-label" htmlFor="m-capture-cluster">Cluster (optional)</label>
            <input
              id="m-capture-cluster"
              type="text"
              className="m-sheet-input"
              value={cluster}
              onChange={(e) => setCluster(e.target.value)}
              list={clusterListId}
              placeholder="Group into a theme"
              data-testid="capture-cluster"
            />
            <datalist id={clusterListId}>
              {dedupClusters.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>

          {err ? <div className="m-form-error" role="alert">{err}</div> : null}
        </form>

        <footer className="m-sheet-footer">
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-secondary"
            onClick={close}
            disabled={submitting}
            data-testid="capture-cancel"
          >Cancel</button>
          <button
            type="button"
            className="m-sheet-btn m-sheet-btn-primary"
            disabled={submitting || !title.trim()}
            data-testid="capture-submit"
            onClick={handleSubmit}
          >{submitting ? 'Saving…' : 'Capture'}</button>
        </footer>
      </div>
    </div>
  );
}
