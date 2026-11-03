/**
 * inboxLogic.js — COMP-COCKPIT-NOTIFY-INBOX-1 (phase 1, read-only): the owner queue regrouped for the inbox drawer.
 * Input is the rows sm_status already returns (`smPanel(data, 'queue')`: `{id, by, text, age, error, red}`), no type field.
 * The grouping lives in `groupOf` (notifyLogic.js), shared with the chip. Phase 2 (COMP-NOTIFY-ASKS-1, HITL-1 "Fix r1";
 * closes UX-ADJ-1 M38) replaces the tag parse with the envelope's `type/kind` and adds answering: that swap touches
 * `groupOf` only. This file never writes, answers or dismisses anything. No React imports.
 */
import { groupOf, tagOf, stripTag } from './notifyLogic.js';

/** Display order; `folded` is the drawer's default (decided and FYI start closed). */
import { entityParts } from '../../../lib/entityParts.js';

export const GROUPS = [
  { id: 'security', label: 'Security', folded: false, oldestFirst: true },
  { id: 'asks', label: 'Asks', folded: false, oldestFirst: true },
  { id: 'decided', label: 'Decided for you', folded: true, oldestFirst: false },
  { id: 'fyi', label: 'FYI', folded: true, oldestFirst: false },
];

/** The text after "reverse:" / "rollback:" / "to undo" on its line, or null. */
export function reverseLine(text) {
  const m = /(?:\b(?:reverse|rollback)\s*:|\bto undo\b)\s*[:,]?\s*([^\n]+)/i.exec(String(text ?? ''));
  const line = m?.[1]?.trim();
  return line || null;
}

/** First non-empty line, minus its leading tag. */
export function firstLine(text) {
  const line = String(text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return stripTag(line);
}

const ageKey = (r, oldestFirst) => {
  if (!Number.isFinite(r.age)) return Infinity; // no age sorts last either way
  return oldestFirst ? -r.age : r.age;
};

/**
 * Queue rows -> `[{id, label, folded, rows}]` in display order (empty groups kept, the drawer hides them).
 * Row: `{id, by, age, red, text, first, untyped, reverse}`; `reverse` is set for decided rows only.
 */
export function groupInbox(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return GROUPS.map(({ id, label, folded, oldestFirst }) => ({
    id,
    label,
    folded,
    rows: list
      .filter((q) => groupOf(q?.text) === id)
      .map((q) => ({
        id: String(q.id ?? ''),
        by: q.by ?? null,
        age: Number.isFinite(q.age) ? q.age : null,
        red: q.red === true,
        text: String(q.text ?? ''),
        first: firstLine(q.text),
        untyped: id === 'asks' && tagOf(q.text) === 'untyped',
        reverse: id === 'decided' ? reverseLine(q.text) : null,
      }))
      .sort((a, b) => ageKey(a, oldestFirst) - ageKey(b, oldestFirst) || a.id.localeCompare(b.id)),
  }));
}

/** The line under a decided row: its own reverse text, else the s1-chat instruction. */
export function reverseText(row) {
  return row.reverse ?? `Reply in s1-chat with id ${row.id} to reverse`;
}

/** Split text into `[{text}|{href, text}]` parts so URLs render as links without any HTML injection. */
export function linkParts(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"')\]]+/g;
  let last = 0;
  for (const m of String(text ?? '').matchAll(re)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ href: m[0], text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * COMP-UI-LINKS-2: `linkParts` with the plain-text parts split once more into entity parts: `{entity: 'feature'|'file', text}`.
 * URL parts and the text around them are unchanged. Whether an entity part has a target is the renderer's call.
 */
export function entityLinkParts(text) {
  return linkParts(text).flatMap((p) => (p.href ? [p] : entityParts(p.text).map((e) => (e.kind === 'text' ? { text: e.value } : { entity: e.kind, text: e.value }))));
}
