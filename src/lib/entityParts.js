/**
 * entityParts.js — COMP-UI-LINKS-2: split free text into plain text and the entity tokens inside it, so a view can render each
 * token through EntityLink (feature code → the feature, repo path → the wiki). Pure: it only finds tokens. Whether a token has a
 * target is the renderer's question (`LinkedText` asks the navigation context and leaves an unresolvable token as plain text),
 * so a stray ALL-CAPS-WITH-DASHES word never turns into a dead link.
 *
 * A feature code is two or more dash-joined upper-case segments (`COMP-UI-LINKS-2`). A path is a repo-relative markdown doc with a directory part: the wiki opens documents, and its doc lookup answers 404 for a source file, so a code path (`lib/x.js`) is left as text.
 */
const FEATURE = String.raw`\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,}\b`;
const PATH = String.raw`(?<![\w/.:-])(?:[\w.-]+/)+[\w.-]+\.md\b(?:#L?\d+)?`;
const TOKEN = new RegExp(`(${PATH})|(${FEATURE})`, 'g');

/**
 * A repo-relative document path the wiki may be asked for: no `..` segment, not absolute, no `~`, no backslash, no `%` escape,
 * no URL scheme. The wiki refuses these too; refusing here keeps them text instead of a dead (or probing) link.
 */
export function isSafeRepoPath(p) {
  if (typeof p !== 'string') return false;
  const path = p.replace(/#.*$/, '');
  if (!path || /^[/~\\]/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || /[\\%]/.test(path)) return false;
  return !path.split('/').some((seg) => seg === '..' || seg === '');
}

/** @returns {Array<{kind: 'text'|'file'|'feature', value: string}>} the parts, in order; their values join back to `text` */
export function entityParts(text) {
  if (typeof text !== 'string' || !text) return [];
  const parts = [];
  const pushText = (value) => {
    if (!value) return;
    const prev = parts[parts.length - 1];
    if (prev?.kind === 'text') prev.value += value; else parts.push({ kind: 'text', value });
  };
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    pushText(text.slice(last, m.index));
    if (m[1] && !isSafeRepoPath(m[0])) pushText(m[0]);
    else parts.push({ kind: m[1] ? 'file' : 'feature', value: m[0] });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return parts;
}

export const ENTITY_HREF = '#entity:';
/** The kinds an `#entity:<kind>:<id>` href may name (the keys EntityLink knows how to open). */
export const ENTITY_KINDS = ['item', 'feature', 'gate', 'view', 'unit', 'step', 'session', 'file'];

/** The `{kind, id}` an entity href names, or null for any other href or an unknown kind. */
export function parseEntityHref(href) {
  if (typeof href !== 'string' || !href.startsWith(ENTITY_HREF)) return null;
  const rest = href.slice(ENTITY_HREF.length);
  const at = rest.indexOf(':');
  const kind = at > 0 ? rest.slice(0, at) : '';
  return ENTITY_KINDS.includes(kind) ? { kind, id: rest.slice(at + 1) } : null;
}

// Markdown nodes whose text is not prose to linkify: links (inline, reference), their definitions, code, raw html.
const SKIP = new Set(['link', 'linkReference', 'definition', 'code', 'inlineCode', 'html', 'image', 'imageReference']);

/**
 * remark plugin (COMP-UI-LINKS-2-FU-1): turns each resolvable entity token in the parsed tree's text nodes into a `link` node
 * to `#entity:<kind>:<token>`. It works on the parser's own tree, so reference links, link definitions, any-length code
 * spans, tilde fences and autolinks are never touched. An inline-code span that is exactly one entity (single backticks only)
 * links with its code styling kept: journals put most paths there. `ok(kind, value)` says whether a token has a target.
 */
export function remarkLinkEntities(ok) {
  const link = (kind, value, child) => ({ type: 'link', url: `${ENTITY_HREF}${kind}:${value}`, children: [child] });
  const walk = (node, source) => {
    if (!Array.isArray(node.children) || SKIP.has(node.type)) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text') {
        const parts = entityParts(child.value);
        if (!parts.some((p) => p.kind !== 'text' && ok(p.kind, p.value))) return [child];
        return parts.map((p) => (p.kind !== 'text' && ok(p.kind, p.value)
          ? link(p.kind, p.value, { type: 'text', value: p.value })
          : { type: 'text', value: p.value }));
      }
      if (child.type === 'inlineCode') {
        const start = child.position?.start?.offset;
        const single = typeof start === 'number' && source.charAt(start) === '`' && source.charAt(start + 1) !== '`';
        const parts = single ? entityParts(child.value) : [];
        return parts.length === 1 && parts[0].kind !== 'text' && ok(parts[0].kind, parts[0].value)
          ? [link(parts[0].kind, parts[0].value, child)] : [child];
      }
      walk(child, source);
      return [child];
    });
  };
  return () => (tree, file) => walk(tree, String(file?.value ?? ''));
}

/** True for a path the wiki can open as a document (markdown, optionally with a `#L<n>` anchor). */
export const isDocPath = (p) => typeof p === 'string' && /\.md(#.*)?$/i.test(p);
