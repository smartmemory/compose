/**
 * subappHost.js — COMP-SUBAPP-HOST-1: the one host object every mounted sub-app receives (contract:
 * `contracts/subapp-host.schema.json`). Pure, no React: App builds it here, the Stratum, Cadence and Wiki views pass it to
 * their package provider (`<DataClientProvider host>` / `<WikiDataProvider host>`), and each package reads it with `useHost()`.
 *
 * Why a provider prop and not a Compose context: the packages cannot import Compose, and their provider is the one
 * context their screens already read, so the host rides in it and the standalone shells (no host) are untouched.
 */
import { itemFeatureCode } from './focusedFeature.js';

/** The selection fields each room filters by, in the order its chip names them. */
export const ROOM_SCOPE = {
  stratum: ['featureCode'],
  cadence: ['unit', 'featureCode', 'lane'],
  wiki: ['featureCode'],
};

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * The selection: the selected item's feature, else the explicitly focused one (a session's feature never filters,
 * as `filterFeatureCode` rules for project views); the open project graph's lane; a unit when a surface selects one.
 * Empty fields are left out, so `{}` means nothing is selected.
 */
export function selectionOf({ selectedItem, focusedFeature, lane, unit } = {}) {
  const sel = {};
  const featureCode = str(itemFeatureCode(selectedItem)) ?? str(focusedFeature);
  if (featureCode) sel.featureCode = featureCode;
  if (str(lane)) sel.lane = str(lane);
  if (str(unit)) sel.unit = str(unit);
  return sel;
}

/** The host object (contract `subapp-host`). `authMode` is wsFetch's `getAuthMode()`; `attention` the sink's `publish`. */
export function buildSubappHost({ selectedItem, focusedFeature, lane, unit, authMode = 'cockpit', attention }) {
  return {
    selection: selectionOf({ selectedItem, focusedFeature, lane, unit }),
    auth: { mode: authMode === 'mobile-paired' ? 'mobile-paired' : 'cockpit', credentials: 'data-client' },
    attention,
  };
}

/** The first selection field `room` filters by, as `{key, value}`, or null when the selection holds none of them. */
export function roomScope(selection, room) {
  for (const key of ROOM_SCOPE[room] ?? []) {
    const value = str(selection?.[key]);
    if (value) return { key, value };
  }
  return null;
}

const SCOPE_WORD = { featureCode: '', lane: 'lane ', unit: 'unit ' };
/** The chip's words: `filtered to COMP-TUI-4`, `filtered to unit X-1`, `filtered to lane ops`. */
export const scopeLabel = (scope) => (scope ? `filtered to ${SCOPE_WORD[scope.key] ?? ''}${scope.value}` : '');

/** The same host with nothing selected: what a room shows after its chip's clear. */
export const withoutSelection = (host) => (host ? { ...host, selection: {} } : host);

const isRow = (r) => !!r && typeof r === 'object'
  && ['key', 'kind', 'title', 'sourceLabel'].every((k) => typeof r[k] === 'string' && r[k] !== '')
  && (r.severity === 'critical' || r.severity === 'warn');

/**
 * The attention sink (the host's `attention`). Each publisher (`source`) owns one current list of inbox rows
 * (notifyLogic.js row type, contract `#/definitions/inboxRow`); a publish replaces that source's list, `[]` clears it.
 * A malformed row is dropped with one WARNING naming the source and how many, never silently. Row 307 makes the inbox read it.
 */
export function createAttentionSink({ warn = console.warn } = {}) {
  const bySource = new Map();
  const listeners = new Set();
  let snapshot = [];
  const publish = (source, rows) => {
    if (typeof source !== 'string' || source === '') { warn('[subapp-host] attention publish without a source name; rows dropped'); return; }
    const list = Array.isArray(rows) ? rows : [];
    const good = list.filter(isRow);
    if (good.length !== list.length || !Array.isArray(rows)) warn(`[subapp-host] ${source}: ${Array.isArray(rows) ? list.length - good.length : 'a non-list of'} attention rows dropped (not inbox rows)`);
    if (good.length) bySource.set(source, good); else bySource.delete(source);
    snapshot = [...bySource.values()].flat();
    for (const fn of listeners) fn(snapshot);
  };
  return {
    publish,
    /** Every source's current rows, one flat list (a stable array between publishes). */
    read: () => snapshot,
    /** `fn(rows)` after each publish; returns the unsubscribe. */
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** Compose's one sink: the host's `attention` is its `publish`. */
export const attentionSink = createAttentionSink();
