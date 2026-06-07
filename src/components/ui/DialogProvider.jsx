/**
 * DialogProvider.jsx — COMP-COCKPIT-1.
 *
 * Promise-based replacement for synchronous window.confirm / window.prompt.
 * Mounts a single Radix Dialog at the app root and exposes imperative hooks so
 * call sites read like the native API they replace:
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Delete?', destructive: true })) onDelete();
 *
 *   const prompt = usePrompt();
 *   const code = await prompt({ title: 'Feature code', required: true });
 *   if (code) start(code);  // null === cancelled
 *
 *   const confirmWithReason = useConfirmWithReason();  // COCKPIT-6
 *   const reason = await confirmWithReason({ title: 'Kill gate?', destructive: true });
 *   if (reason) resolveGate(id, 'killed', reason);     // null === cancelled / empty
 *
 * One dialog is shown at a time (sequential). This is an additive provider —
 * mounting it changes no existing behavior until a hook is called.
 */
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog.jsx';
import { Button } from './button.jsx';
import { Input } from './input.jsx';

const DialogContext = createContext(null);

// kinds: 'confirm' (→ boolean) | 'prompt' (→ string|null) | 'reason' (→ string|null)
export function DialogProvider({ children }) {
  const [req, setReq] = useState(null); // { kind, opts } | null
  const [value, setValue] = useState('');
  const resolveRef = useRef(null);
  const reqRef = useRef(null); // synchronous mirror of `req` for reentrancy handling

  const open = useCallback((kind, opts = {}) => {
    return new Promise((resolve) => {
      // Reentrancy guard: if a dialog is already pending, settle the prior caller
      // with its cancel value first so its promise never strands (Codex review).
      if (resolveRef.current) {
        const prev = resolveRef.current;
        const prevKind = reqRef.current?.kind;
        resolveRef.current = null;
        prev(prevKind === 'confirm' ? false : null);
      }
      resolveRef.current = resolve;
      reqRef.current = { kind, opts };
      setValue(opts.defaultValue || '');
      setReq({ kind, opts });
    });
  }, []);

  const settle = useCallback((outcome) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    reqRef.current = null;
    setReq(null);
    setValue('');
    if (resolve) resolve(outcome);
  }, []);

  const confirm = useCallback((opts) => open('confirm', opts), [open]);
  const prompt = useCallback((opts) => open('prompt', opts), [open]);
  const confirmWithReason = useCallback((opts) => open('reason', opts), [open]);

  const needsInput = !!req && (req.kind === 'prompt' || req.kind === 'reason');
  // 'reason' always requires a value; 'prompt' requires one only when opts.required.
  const requiresValue = !!req && (req.kind === 'reason' || req.opts?.required);
  const confirmDisabled = requiresValue && !value.trim();

  const onCancel = useCallback(() => {
    settle(req?.kind === 'confirm' ? false : null);
  }, [req, settle]);

  const onConfirm = useCallback(() => {
    if (!req) return;
    if (req.kind === 'confirm') return settle(true);
    const trimmed = value.trim();
    if ((req.kind === 'reason' || req.opts?.required) && !trimmed) return; // blocked
    settle(req.kind === 'reason' ? trimmed : value);
  }, [req, value, settle]);

  const api = { confirm, prompt, confirmWithReason };

  return (
    <DialogContext.Provider value={api}>
      {children}
      <Dialog open={!!req} onOpenChange={(o) => { if (!o) onCancel(); }}>
        {req && (
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{req.opts.title}</DialogTitle>
              {req.opts.body && <DialogDescription>{req.opts.body}</DialogDescription>}
            </DialogHeader>
            <div className="px-6 pb-2 space-y-3">
              {needsInput && (
                <Input
                  autoFocus
                  value={value}
                  placeholder={req.opts.label || ''}
                  onChange={(e) => setValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onConfirm();
                  }}
                  data-testid="dialog-input"
                />
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onCancel} data-testid="dialog-cancel">
                Cancel
              </Button>
              <Button
                variant={req.opts.destructive ? 'destructive' : 'default'}
                size="sm"
                disabled={confirmDisabled}
                onClick={onConfirm}
                data-testid="dialog-confirm"
              >
                {req.opts.confirmLabel || (req.opts.destructive ? 'Confirm' : 'OK')}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </DialogContext.Provider>
  );
}

// Fallback used only when no <DialogProvider> is mounted (e.g. a component
// rendered in isolation in a test). main.jsx always mounts the provider in the
// real app, so the in-app modals are what users see; this just degrades to the
// native dialogs instead of crashing, and warns so a missing provider is visible.
let warned = false;
const nativeFallback = {
  confirm: (opts = {}) =>
    Promise.resolve(
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(opts.title || 'Are you sure?')
        : false,
    ),
  prompt: (opts = {}) =>
    Promise.resolve(
      typeof window !== 'undefined' && typeof window.prompt === 'function'
        ? window.prompt(opts.title || '') ?? null
        : null,
    ),
  confirmWithReason: (opts = {}) =>
    Promise.resolve(
      typeof window !== 'undefined' && typeof window.prompt === 'function'
        ? window.prompt(opts.title || 'Reason:')?.trim() || null
        : null,
    ),
};

function useDialogContext() {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    if (!warned && typeof console !== 'undefined') {
      warned = true;
      console.warn('[DialogProvider] no provider mounted — falling back to native dialogs');
    }
    return nativeFallback;
  }
  return ctx;
}

export const useConfirm = () => useDialogContext().confirm;
export const usePrompt = () => useDialogContext().prompt;
export const useConfirmWithReason = () => useDialogContext().confirmWithReason;
