/**
 * EntityLink — COMP-COCKPIT-8 shared inline link for cross-view entity jumps.
 *
 * Props:
 *   kind      {string}  one of 'item' | 'feature' | 'gate' | 'view'
 *   id        {string}  entity id passed to the navigation callback
 *   label     {node}    visible text (defaults to id)
 *   className {string}  extra classes merged onto the element
 *
 * Navigation callbacks come from NavigationContext (provided by App.jsx).
 * When no provider is mounted — or the callback for `kind` is missing —
 * the link degrades to a plain muted <span> so consumers (tests, mobile)
 * never crash. A throwing navigation callback is swallowed: the link is a
 * convenience jump, never a load-bearing action.
 */
import React from 'react';
import { cn } from '@/lib/utils.js';
import { useNavigation } from '@/lib/navigation.jsx';

const KIND_TO_CALLBACK = {
  item: 'openItem',
  feature: 'openFeature',
  gate: 'openGate',
  view: 'openView',
};

export default function EntityLink({ kind, id, label, className }) {
  const nav = useNavigation();
  const text = label ?? id;
  const handler = nav?.[KIND_TO_CALLBACK[kind]];

  if (typeof handler !== 'function') {
    return (
      <span className={cn('text-[11px] font-mono text-muted-foreground', className)}>
        {text}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        try {
          handler(id);
        } catch {
          // Navigation is best-effort — a vanished target must not crash the view.
        }
      }}
      className={cn('text-[11px] font-mono text-blue-400 hover:underline cursor-pointer', className)}
    >
      {text}
    </button>
  );
}
