/**
 * ask-options.js — COMP-COCKPIT-NOTIFY-ACTIONS-1: the ONE parser for an owner ask's answer options, shared by the
 * server's answer route (it validates `choice` against it) and the cockpit (it draws one button per option). Pure.
 *
 * An envelope `options` array wins: `{value, label}` objects or plain strings (a string is its own value and label).
 * Otherwise the text is parsed: a marker is `(a)`, `a)` or `a.` at the start of a line or after whitespace, `:` or `;`,
 * followed by whitespace or the end. Letters must run a, b, c... in order, at least 2, all one style, every label
 * non-empty; a label runs to the next marker or the end of its line. Anything else gives `[]`: the ask is free text only.
 * Labels are plain text; the UI renders them as text, never as HTML.
 */

const MARKER = /(^|[\s:;])(?:\(([a-z])\)|([a-z])\)|([a-z])\.)(?=\s|$)/gm;

const trimLabel = (s) => s.replace(/[\s;,.]+$/u, '').trim();

/** `[{value, label}]` for a queue record (`{text, options?}`); `[]` when the ask has no options. */
export function optionsOf(record) {
  const env = record?.options;
  if (Array.isArray(env) && env.length) {
    const out = [];
    for (const o of env) {
      if (typeof o === 'string' && o.trim()) out.push({ value: o.trim(), label: o.trim() });
      else if (o && typeof o === 'object' && typeof o.value === 'string' && o.value.trim()) {
        out.push({ value: o.value.trim(), label: String(o.label ?? o.value).trim() || o.value.trim() });
      } else return [];
    }
    return out;
  }
  const text = String(record?.text ?? '');
  const marks = [];
  for (const m of text.matchAll(MARKER)) {
    const style = m[2] ? 'paren' : m[3] ? 'close' : 'dot';
    const letter = m[2] ?? m[3] ?? m[4];
    const start = m.index + m[1].length;
    marks.push({ letter, style, start, end: m.index + m[0].length });
  }
  if (marks.length < 2) return [];
  if (marks.some((k) => k.style !== marks[0].style)) return [];
  if (marks.some((k, i) => k.letter !== String.fromCharCode(97 + i))) return [];
  const out = [];
  for (let i = 0; i < marks.length; i += 1) {
    const stop = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const rest = text.slice(marks[i].end, stop);
    const label = trimLabel(rest.split('\n')[0]);
    if (!label) return [];
    out.push({ value: marks[i].letter, label });
  }
  return out;
}

/** The answer text the server writes for a choice: `(<value>) <label>`. */
export function choiceText(option) {
  return `(${option.value}) ${option.label}`;
}
