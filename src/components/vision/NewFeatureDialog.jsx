/**
 * NewFeatureDialog — single-step dialog to scaffold a feature from a blank slate.
 *
 * Cockpit equivalent of `compose feature <CODE> "<description>"`. Collects a
 * feature code, a description, and an optional phase; validates the code with the
 * same contract as lib/feature-code.js (FEATURE_CODE_RE_STRICT); POSTs to the
 * auth-gated POST /api/features/scaffold via wsFetch (which injects the workspace
 * + sensitive-token / paired-JWT headers). Follows IdeaboxPromoteDialog UX
 * conventions (Dialog primitive, Button, success step) without the wizard.
 */

import React, { useState, useRef, useEffect } from 'react';
import { FilePlus, Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog.jsx';
import { Button } from '@/components/ui/button.jsx';
import { wsFetch } from '@/lib/wsFetch.js';

const CODE_RE = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/; // mirror lib/feature-code.js FEATURE_CODE_RE_STRICT

export default function NewFeatureDialog({ open, onClose, onCreated }) {
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { code, featurePath }
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setCode(''); setDescription(''); setPhase('');
      setError(''); setResult(null); setSubmitting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const submit = async () => {
    if (submitting) return;
    const c = code.trim().toUpperCase();
    if (!CODE_RE.test(c)) { setError('Use a code like COMP-FOO-1'); return; }
    if (!description.trim()) { setError('Description is required'); return; }
    setSubmitting(true); setError('');
    try {
      const res = await wsFetch('/api/features/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: c, description: description.trim(), phase: phase.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult({ code: data.code, featurePath: data.featurePath });
      onCreated?.(data);
    } catch (err) {
      setError(err.message || 'Failed to create feature');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilePlus className="w-4 h-4 text-accent" />
            New Feature
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="px-6 pb-2 flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-10 h-10 rounded-full bg-emerald-400/20 flex items-center justify-center">
              <Check className="w-5 h-5 text-emerald-400" />
            </div>
            <p className="text-sm font-semibold text-foreground">Created!</p>
            <p className="text-[12px] text-muted-foreground">
              <span className="font-mono text-accent font-semibold">{result.code}</span>
              {result.featurePath && <> · <span className="font-mono">{result.featurePath}</span></>}
            </p>
            <Button size="sm" onClick={onClose} className="mt-1">Close</Button>
          </div>
        ) : (
          <>
            <div className="px-6 pb-2 space-y-3">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1.5">Feature Code</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={code}
                  onChange={e => { setCode(e.target.value.toUpperCase()); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                  placeholder="e.g. COMP-FOO-1"
                  className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring font-mono"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1.5">Description</span>
                <input
                  type="text"
                  value={description}
                  onChange={e => { setDescription(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                  placeholder="One-line description for the ROADMAP cell"
                  className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring"
                />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold block mb-1.5">Phase <span className="opacity-60 normal-case">(optional)</span></span>
                <input
                  type="text"
                  value={phase}
                  onChange={e => setPhase(e.target.value)}
                  placeholder="Phase heading (default: Backlog)"
                  className="w-full text-sm bg-muted text-foreground px-3 py-2 rounded-md border border-border outline-none focus:border-ring"
                />
              </label>
              {error && <p className="text-[11px] text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
              <Button size="sm" onClick={submit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create Feature'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
