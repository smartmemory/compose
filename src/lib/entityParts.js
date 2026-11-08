/**
 * entityParts.js — COMP-UI-LINKS-2: split free text into plain text and the entity tokens inside it, so a view can render each
 * token through EntityLink (feature code → the feature, repo path → the wiki). Pure: it only finds tokens. Whether a token has a
 * target is the renderer's question (`LinkedText` asks the navigation context and leaves an unresolvable token as plain text),
 * so a stray ALL-CAPS-WITH-DASHES word never turns into a dead link.
 *
 * A feature code is two or more dash-joined upper-case segments (`COMP-UI-LINKS-2`). A path is a repo-relative markdown doc with a directory part: the wiki opens documents, and its doc lookup answers 404 for a source file, so a code path (`lib/x.js`) is left as text.
 * COMP-INBOX-LOCAL-FILE-LINKS-1: a `localfile` is an absolute path under a home dir (`/Users/<name>/...`, `/home/<name>/...`
 * or `~/...`) with an optional `:<line>` suffix, opened on the Mac by `POST /api/fleet/open-path`. It is matched first, so a
 * unit code or a doc path inside it does not split it. No whitespace, quotes, `<>`, `%` or backslash can be in one (they end
 * it), and one with a `..` segment stays text. A trailing `.`, `,` `;` or `:` is sentence punctuation and stays text.
 */
const FEATURE = String.raw`\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,}\b`;
const PATH = String.raw`(?<![\w/.:-])(?:[\w.-]+/)+[\w.-]+\.md\b(?:#L?\d+)?`;
const LOCALFILE = String.raw`(?<![\w/.:~-])(?:~|/(?:Users|home)/[\w.-]+)(?:/[\w.@+,=-]+)+(?::\d+)?`;
const TOKEN = new RegExp(`(${LOCALFILE})|(${PATH})|(${FEATURE})`, 'g');
const TRAILING_PUNCT = /[.,;:]+$/;

/**
 * An absolute home-dir path the open-path route may be asked for (the server re-checks everything against the real home and
 * the real file): `/Users/<name>/...`, `/home/<name>/...` or `~/...`, an optional `:<line>`, no `..` or `.` or empty segment,
 * no whitespace, quote, `<>`, `%`, backslash or NUL.
 */
export function isSafeLocalPath(p) {
  if (typeof p !== 'string' || p.length > 4096) return false;
  const path = p.replace(/:\d+$/, '');
  if (!/^(?:~|\/(?:Users|home)\/[\w.-]+)(?:\/[\w.@+,=-]+)+$/.test(path)) return false;
  return !path.split('/').slice(1).some((seg) => seg === '..' || seg === '.' || seg === '');
}

/** The path to hand the opener: a `localfile` without its `:<line>` suffix (the opener takes no line). */
export const localPathOf = (p) => String(p ?? '').replace(/:\d+$/, '');

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

/** @returns {Array<{kind: 'text'|'localfile'|'file'|'feature', value: string}>} the parts, in order; their values join back to `text` */
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
    if (m[1]) {
      const tail = TRAILING_PUNCT.exec(m[0])?.[0] ?? '';
      const value = m[0].slice(0, m[0].length - tail.length);
      if (isSafeLocalPath(value)) parts.push({ kind: 'localfile', value }); else pushText(value);
      pushText(tail);
    } else if (m[2] && !isSafeRepoPath(m[0])) pushText(m[0]);
    else parts.push({ kind: m[2] ? 'file' : 'feature', value: m[0] });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return parts;
}

export const ENTITY_HREF = '#entity:';
/** The kinds an `#entity:<kind>:<id>` href may name (the keys EntityLink knows how to open). */
export const ENTITY_KINDS = ['item', 'feature', 'gate', 'view', 'unit', 'step', 'session', 'file', 'localfile'];

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
