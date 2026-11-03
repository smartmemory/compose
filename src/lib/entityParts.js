/**
 * entityParts.js — COMP-UI-LINKS-2: split free text into plain text and the entity tokens inside it, so a view can render each
 * token through EntityLink (feature code → the feature, repo path → the wiki). Pure: it only finds tokens. Whether a token has a
 * target is the renderer's question (`LinkedText` asks the navigation context and leaves an unresolvable token as plain text),
 * so a stray ALL-CAPS-WITH-DASHES word never turns into a dead link.
 *
 * A feature code is two or more dash-joined upper-case segments (`COMP-UI-LINKS-2`). A path is repo-relative, has a directory part and a known doc/code extension.
 */
const FEATURE = String.raw`\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,}\b`;
const PATH = String.raw`(?<![\w/.:-])(?:[\w.-]+/)+[\w.-]+\.(?:md|json|jsonl|js|jsx|ts|tsx|py|ya?ml|toml|sh|css|html)\b(?:#L?\d+)?`;
const TOKEN = new RegExp(`(${PATH})|(${FEATURE})`, 'g');

/** @returns {Array<{kind: 'text'|'file'|'feature', value: string}>} the parts, in order; their values join back to `text` */
export function entityParts(text) {
  if (typeof text !== 'string' || !text) return [];
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ kind: 'text', value: text.slice(last, m.index) });
    parts.push({ kind: m[1] ? 'file' : 'feature', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/\S+)/g;
export const ENTITY_HREF = '#entity:';

// A whole inline-code span that is exactly one entity (`docs/a.md`, `COMP-X-1`) links, code styling kept: journals put most paths there.
function linkCodeSpan(seg, ok) {
  const inner = /^`([^`\n]+)`$/.exec(seg)?.[1];
  const parts = inner ? entityParts(inner) : [];
  return parts.length === 1 && parts[0].kind !== 'text' && ok(parts[0].kind, parts[0].value)
    ? `[${seg}](${ENTITY_HREF}${parts[0].kind}:${parts[0].value})` : seg;
}

/**
 * Markdown with each resolvable entity token turned into a `[token](#entity:<kind>:<token>)` link. Code fences, inline code that holds more than one token,
 * existing links, HTML and URLs are left alone. `ok(kind, value)` says whether a token has a target; one that does not stays text.
 */
export function linkEntitiesInMarkdown(md, ok) {
  if (typeof md !== 'string' || !md) return md ?? '';
  return md.split(PROTECTED).map((seg, i) => (i % 2 === 1 ? linkCodeSpan(seg, ok) : entityParts(seg)
    .map((p) => (p.kind !== 'text' && ok(p.kind, p.value) ? `[${p.value}](${ENTITY_HREF}${p.kind}:${p.value})` : p.value)).join(''))).join('');
}

/** The `{kind, id}` an entity href names, or null for any other href. */
export function parseEntityHref(href) {
  if (typeof href !== 'string' || !href.startsWith(ENTITY_HREF)) return null;
  const rest = href.slice(ENTITY_HREF.length);
  const at = rest.indexOf(':');
  return at > 0 ? { kind: rest.slice(0, at), id: rest.slice(at + 1) } : null;
}
