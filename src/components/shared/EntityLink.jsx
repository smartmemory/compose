/**
 * EntityLink — COMP-COCKPIT-8 shared inline link for cross-view entity jumps.
 *
 * Props:
 *   kind      {string}  one of 'item' | 'feature' | 'gate' | 'view', or (COMP-UI-LINKS-2) 'unit' (Cadence room), 'session'
 *                       (Fleet room, by session name), 'file' (a repo doc path, opened in the wiki)
 *   id        {string}  entity id passed to the navigation callback
 *   label     {node}    visible text (defaults to id)
 *   className {string}  extra classes merged onto the element
 *   title     {string}  tooltip; when the link degrades to text it carries the reason (`noTarget` or a generic one)
 *
 * Navigation callbacks come from NavigationContext (provided by App.jsx).
 * When no provider is mounted, the callback for `kind` is missing, or the
 * provider's canNavigate(kind, id) says the target is unresolvable (stale
 * gate id, unknown feature code), the link degrades to a plain muted <span>
 * so consumers (tests, mobile) never crash and never show dead blue links.
 * A throwing navigation callback is swallowed: the link is a convenience
 * jump, never a load-bearing action.
 */
import React from 'react';
import { cn } from '@/lib/utils.js';
import { useNavigation } from '@/lib/navigation.jsx';
import { entityParts, isSafeRepoPath } from '@/lib/entityParts.js';

const KIND_TO_CALLBACK = {
  item: 'openItem',
  feature: 'openFeature',
  gate: 'openGate',
  view: 'openView',
  unit: 'openRoom',
  step: 'openRoom',
  session: 'openRoom',
  file: 'openFile',
};

// The call each kind makes. Room kinds file a focus (roomFocus.js) the target room applies when it opens.
const CALL = {
  unit: (h, id) => h('cadence', { kind: 'unit', id }),
  // a Stratum step: id is `<run id>#<step id>` (a flow's run id is its flow id)
  step: (h, id) => h('stratum', { kind: 'step', runId: id.slice(0, id.indexOf('#')), stepId: id.slice(id.indexOf('#') + 1) }),
  session: (h, id) => h('fleet', { kind: 'session', name: id }),
};

/** Whether `nav` can open `kind`/`id` right now: the callback exists, the id is well formed, and the provider does not call the target stale or its room unavailable. The one question every link path asks. */
export function canOpenEntity(nav, kind, id) {
  const cb = nav?.[KIND_TO_CALLBACK[kind]];
  if (typeof cb !== 'function' || !id) return false;
  if (kind === 'file' && !isSafeRepoPath(id)) return false;
  return typeof nav.canNavigate === 'function' ? nav.canNavigate(kind, id) : true;
}

/** Why a link that cannot open is text: shown as its tooltip. */
export function noTargetReason(nav, kind, id) {
  if (typeof nav?.[KIND_TO_CALLBACK[kind]] !== 'function') return 'No link here: this view has no place to open it';
  if (kind === 'file' && !isSafeRepoPath(id)) return `${id} is not a repo document path, so it cannot be opened`;
  if (kind === 'unit') return `The Cadence room is not available here, so unit ${id} cannot be opened`;
  if (kind === 'step') return `The Stratum room is not available here, so step ${id} cannot be opened`;
  if (kind === 'file') return `The Wiki tab is not available here, so ${id} cannot be opened`;
  return `No ${kind} named ${id} to open`;
}

/** Opens `kind`/`id` through `nav` (the same call EntityLink makes). Best-effort: a throwing callback is swallowed. */
export function openEntity(nav, kind, id) {
  try { (CALL[kind] ?? ((h, i) => h(i)))(nav[KIND_TO_CALLBACK[kind]], id); } catch { /* a vanished target must not crash the view */ }
}

export default function EntityLink({ kind, id, label, className, title }) {
  const nav = useNavigation();
  const text = label ?? id;
  const handler = nav?.[KIND_TO_CALLBACK[kind]];

  if (!canOpenEntity(nav, kind, id)) { // providers without canNavigate keep the old optimistic behavior
    return (
      <span
        className={cn('text-[11px] font-mono text-muted-foreground', className)}
        title={title ?? noTargetReason(nav, kind, id)}
        data-no-target=""
      >
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
          (CALL[kind] ?? ((h, i) => h(i)))(handler, id);
        } catch {
          // Navigation is best-effort — a vanished target must not crash the view.
        }
      }}
      title={title}
      className={cn('text-[11px] font-mono text-blue-400 hover:underline focus-visible:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-blue-400 cursor-pointer text-left', className)}
    >
      {text}
    </button>
  );
}

/**
 * COMP-UI-LINKS-2: free text with its feature codes and repo paths as EntityLinks. A token the navigation context cannot resolve
 * (no provider, unknown feature code, no file handler) stays plain text, unstyled: prose never grows dead links.
 */
export function LinkedText({ text, className }) {
  const nav = useNavigation();
  const parts = entityParts(text);
  if (!nav || parts.length === 0) return <>{text}</>;
  const ok = (kind, value) => canOpenEntity(nav, kind, value);
  return (
    <>
      {parts.map((p, i) => (p.kind !== 'text' && ok(p.kind, p.value)
        ? <EntityLink key={i} kind={p.kind} id={p.value} className={cn('text-[length:inherit]', className)} />
        : <React.Fragment key={i}>{p.value}</React.Fragment>))}
    </>
  );
}
