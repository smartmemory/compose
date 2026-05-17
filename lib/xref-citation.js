/**
 * xref-citation.js — pure parser for inline cross-project external-reference
 * citations embedded in a ROADMAP/description cell (COMP-MCP-XREF-SCHEMA, #15).
 *
 * A citation is an HTML comment so it renders invisibly in markdown:
 *
 *   <!-- xref: github owner/repo#123 expect=open -->
 *   <!-- xref: github smartmemory/compose#7 expect=closed note="shipped X" -->
 *   <!-- xref: local compose COMP-MCP-VALIDATE expect=COMPLETE -->
 *   <!-- xref: url https://example.com/spec note="design ref" -->
 *
 * Grammar (spec §3.1 EBNF):
 *   citation   = "<!--" ws "xref:" ws provider ws target
 *                [ ws "expect=" expect ] [ ws "note=" qstring ] ws "-->"
 *   provider   = "github" | "local" | "url"                       ; resolvable
 *              | "jira" | "linear" | "notion" | "obsidian"         ; reserved url-class
 *   gh_target  = repo "#" issue          ; repo = owner "/" name
 *   local_target = repo_token ws feature_code
 *   url_target = URL                     ; url + every reserved provider
 *
 * This module performs ZERO I/O and ZERO network. It is a pure
 * string → object function. Consumed by #16 (`runExternalRefChecks`); #15
 * ships it standalone with no caller in the validator path.
 */

// url-class = `url` + every reserved provider (carry a url_target, never
// resolved in v1). ALL_PROVIDERS is the full accepted set.
const RESOLVABLE_PROVIDERS = ['github', 'local', 'url'];
const RESERVED_PROVIDERS = ['jira', 'linear', 'notion', 'obsidian'];
const ALL_PROVIDERS = new Set([...RESOLVABLE_PROVIDERS, ...RESERVED_PROVIDERS]);

const GITHUB_EXPECT = new Set(['open', 'closed']);
const LOCAL_EXPECT = new Set([
  'PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE',
  'SUPERSEDED', 'PARKED', 'BLOCKED', 'KILLED',
]);
const FEATURE_CODE_RE = /^[A-Z][A-Z0-9-]*[A-Z0-9]$/;
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;

// Anchored scan: only HTML comments whose body begins with `xref:` are
// considered. Any other `<!-- ... -->` is ignored entirely.
const CITATION_RE = /<!--\s*xref:\s*([\s\S]*?)\s*-->/g;

/**
 * Structured parse error for a comment that matched `<!--\s*xref:` but
 * failed the grammar. Consumed by #16 as the `XREF_MALFORMED` finding;
 * #15 only surfaces it via the return value (never throws, never logs).
 */
export class ParseError {
  constructor(raw, reason) {
    this.raw = raw;
    this.reason = reason;
  }
}

/**
 * @typedef {object} PartialExternalRef
 * @property {string} provider
 * @property {string|null} repo     github "owner/name" | local repo token | null
 * @property {number|null} issue    github only
 * @property {string|null} toCode   local only (target feature code)
 * @property {string|null} url      url-class only (url + reserved providers)
 * @property {string|null} expect   optional expected-state token
 * @property {string|null} note
 * @property {string} raw           the citation body (for locatability)
 */

/**
 * Parse every `xref:` citation in a description cell.
 * @param {string} descriptionCell
 * @returns {{ refs: PartialExternalRef[], errors: ParseError[] }}
 */
export function parseCitations(descriptionCell) {
  const refs = [];
  const errors = [];
  if (typeof descriptionCell !== 'string' || descriptionCell.length === 0) {
    return { refs, errors };
  }

  CITATION_RE.lastIndex = 0;
  let m;
  while ((m = CITATION_RE.exec(descriptionCell)) !== null) {
    const raw = m[1];
    try {
      refs.push(parseOne(raw));
    } catch (e) {
      if (e instanceof ParseError) errors.push(e);
      else errors.push(new ParseError(raw, String(e && e.message ? e.message : e)));
    }
  }
  return { refs, errors };
}

function parseOne(raw) {
  let rest = raw.trim();
  if (rest.length === 0) throw new ParseError(raw, 'empty xref citation');

  // Optional trailing options `expect=<tok>` and `note="..."`, order-
  // independent. They are stripped **end-anchored** (must be the trailing
  // whitespace-separated token), so a `note=`/`expect=` substring inside the
  // target itself — e.g. a URL query `https://x/?note=a&expect=b` — is left
  // in the target and never mis-consumed. Each option may appear at most once.
  //
  // Known v1 limitations (faithful to spec §3.1 EBNF, which defines
  // `qstring = DQUOTE *CHAR DQUOTE` with no escape and an HTML-comment
  // carrier): a `note="..."` value cannot contain `"` or the literal `-->`.
  let note = null;
  let expect = null;
  for (let i = 0; i < 2; i++) {
    let m;
    if (note === null && (m = rest.match(/\s+note="([^"]*)"\s*$/))) {
      note = m[1];
      rest = rest.slice(0, m.index).trimEnd();
      continue;
    }
    if (expect === null && (m = rest.match(/\s+expect=(\S+)\s*$/))) {
      expect = m[1];
      rest = rest.slice(0, m.index).trimEnd();
      continue;
    }
    break;
  }
  // A `note=` option token that exists but was not consumable as a trailing
  // quoted string is a hard parse error (don't silently fold it into target).
  if (note === null && /(^|\s)note=/.test(rest)) {
    if (/(^|\s)note="/.test(rest)) {
      throw new ParseError(raw, 'unterminated or misplaced note="..." (must be a trailing double-quoted token)');
    }
    throw new ParseError(raw, 'note= value must be a double-quoted string');
  }
  // Likewise a stray trailing `expect=` token that wasn't consumed.
  if (expect === null && /(^|\s)expect=\S*\s*$/.test(rest)) {
    throw new ParseError(raw, 'malformed expect= option');
  }
  rest = rest.replace(/\s+/g, ' ').trim();

  // Remaining: `<provider> <target...>`.
  const firstWs = rest.search(/\s/);
  if (firstWs === -1) {
    throw new ParseError(raw, `missing target after provider "${rest}"`);
  }
  const provider = rest.slice(0, firstWs);
  const target = rest.slice(firstWs + 1).trim();

  if (!ALL_PROVIDERS.has(provider)) {
    throw new ParseError(
      raw,
      `unknown provider "${provider}" (expected one of ${[...ALL_PROVIDERS].join(', ')})`,
    );
  }
  if (target.length === 0) {
    throw new ParseError(raw, `missing target for provider "${provider}"`);
  }

  const ref = {
    provider,
    repo: null,
    issue: null,
    toCode: null,
    url: null,
    expect: null,
    note,
    raw,
  };

  if (provider === 'github') {
    // No `#` in either repo half — `#` delimits the issue (owner/name#issue)
    // and GitHub owners/names cannot contain it. Keeps the citation carrier
    // carrier-equivalent with the feature.json-link writer (XREF_GH_REPO_RE).
    const gh = target.match(/^([^\s/#]+\/[^\s/#]+)#(\d+)$/);
    if (!gh) {
      throw new ParseError(raw, `github target must be "owner/name#issue", got "${target}"`);
    }
    ref.repo = gh[1];
    ref.issue = Number(gh[2]);
    if (expect !== null) {
      if (!GITHUB_EXPECT.has(expect)) {
        throw new ParseError(
          raw, `github expect must be open|closed, got "${expect}"`,
        );
      }
      ref.expect = expect;
    }
  } else if (provider === 'local') {
    const parts = target.split(/\s+/);
    if (parts.length !== 2) {
      throw new ParseError(
        raw, `local target must be "<repo> <FEATURE_CODE>", got "${target}"`,
      );
    }
    const [repoTok, code] = parts;
    // repo token must be a single safe directory name — it is resolved as a
    // sibling dir (path.join(cwd, '..', repoTok)); reject anything with a
    // path separator or traversal so a citation cannot escape the workspace.
    if (!/^[A-Za-z0-9._-]+$/.test(repoTok) || repoTok === '.' || repoTok === '..') {
      throw new ParseError(
        raw,
        `local repo token "${repoTok}" must be a single directory name `
        + '([A-Za-z0-9._-], no path separators or "."/"..")',
      );
    }
    if (!FEATURE_CODE_RE.test(code)) {
      throw new ParseError(raw, `local target feature code "${code}" is not a valid code`);
    }
    ref.repo = repoTok;
    ref.toCode = code;
    if (expect !== null) {
      if (!LOCAL_EXPECT.has(expect)) {
        throw new ParseError(
          raw,
          `local expect must be one of ${[...LOCAL_EXPECT].join('|')}, got "${expect}"`,
        );
      }
      ref.expect = expect;
    }
  } else {
    // url-class: provider `url` and every reserved provider. The target is a
    // single URL token; `expect=` is syntactically accepted but ignored
    // (these refs are never resolved in v1 — spec §5.2/§9), never a ParseError.
    if (/\s/.test(target)) {
      throw new ParseError(
        raw, `${provider} target must be a single URL, got "${target}"`,
      );
    }
    if (!URI_SCHEME_RE.test(target)) {
      throw new ParseError(
        raw, `${provider} target must be a scheme:// URL, got "${target}"`,
      );
    }
    ref.url = target;
    if (expect !== null) ref.expect = expect; // recorded, not validated, not resolved
  }

  return ref;
}
