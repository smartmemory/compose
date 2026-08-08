/**
 * trace.js — read-side ancestry for judgment positions (COMP-JUDGMENT-PRECEDENT
 * slice A).
 *
 * The store persists full causal history — revision chains, the
 * `supersedes: <slug>#r<N>` reference, retraction tombstones — and exposes none
 * of it. `get_judgment_state` returns the latest revision per position and drops
 * everything behind it, so a decision's precedent is on disk and unreadable.
 *
 * Two additions, both read-only:
 *   - buildSupersessionIndex: one pass over the slugs yielding forward AND
 *     reverse refs. Replaces the O(n^2) rescan inside derivePositionStatus,
 *     which reads every other slug's full chain to answer "am I superseded".
 *   - tracePosition: the ancestry walk, pinned to the referenced revision and
 *     cycle-guarded.
 *
 * No writes, no schema change, no migration — every field read here is already
 * persisted.
 */

/** Same shape as the writer's private helper (judgment-writer.js:65). */
function typedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** `<slug>#r<N>` → {slug, rev}, or null when the ref is absent/malformed. */
export function parseRevisionRef(ref) {
  if (typeof ref !== 'string') return null;
  const m = ref.match(/^(.+)#r(\d+)$/);
  if (!m) return null;
  return { slug: m[1], rev: Number(m[2]) };
}

/**
 * Forward + reverse supersession refs for every position, in a single pass.
 *
 * Status semantics mirror `derivePositionStatus` EXACTLY — this is a
 * behaviour-preserving replacement for its O(n^2) rescan, so it reproduces two
 * of its quirks deliberately:
 *
 *   1. **Self-edges do not count.** The original skips `other === slug`, so a
 *      position superseding its own earlier revision (`a#r2 supersedes a#r1`)
 *      stays `live`. Treating that as `superseded` would strand every position
 *      that ever re-based on itself.
 *   2. **Matching is prefix-based, not strictly parsed.** The original tests
 *      `ref.startsWith(`${slug}#r`)`, so a malformed tail (`a#rX`) still counts
 *      as superseding `a`. Strict parsing here would silently change status for
 *      malformed records.
 *
 * `supersededBy` is an ARRAY, not a scalar: `supersedes` refs are unconstrained,
 * so two distinct live positions can both supersede the same target (a fork —
 * `nextA -> old#r1` and `nextB -> old#r1`). A scalar was last-writer-wins and
 * silently dropped every fork but the last. Each entry also records WHICH target
 * revision it superseded (`rev`, or null when the tail is malformed), so a
 * revision-pinned reader can filter reverse refs to the revision it is showing
 * rather than mixing in ones aimed at a different revision of the same slug.
 *
 * @param {object} store  effective judgment store (createJudgmentStore)
 * @returns {Map<string, {supersedes: string|null, supersededBy: Array<{ref: string, rev: number|null}>, status: string}>}
 */
export function buildSupersessionIndex(store) {
  const index = new Map();
  const latestBySlug = new Map();

  for (const slug of store.listPositionSlugs()) {
    const latest = store.latestPositionRevision(slug);
    if (!latest) continue;
    latestBySlug.set(slug, latest);
    index.set(slug, {
      supersedes: typeof latest.supersedes === 'string' ? latest.supersedes : null,
      supersededBy: [],
      status: latest.retracted === true ? 'retracted' : 'live',
    });
  }

  for (const [slug, latest] of latestBySlug) {
    if (latest.retracted === true) continue;
    const ref = latest.supersedes;
    if (typeof ref !== 'string') continue;
    // `target.startsWith(ref + '#r')` for every target would be O(n) per ref and
    // put the quadratic cost straight back. A target can only match if the ref
    // literally begins with it followed by '#r', so enumerate the ref's own '#r'
    // split points instead — same result, O(occurrences) per ref. A ref like
    // `a#rb#r1` still matches BOTH `a` and `a#rb`, matching the original.
    for (let i = ref.indexOf('#r'); i !== -1; i = ref.indexOf('#r', i + 1)) {
      const targetSlug = ref.slice(0, i);
      if (targetSlug === slug) continue;             // quirk 1: no self-edges
      const target = index.get(targetSlug);
      if (!target) continue;
      // The chars after this split point are the target revision. A clean integer
      // pins it; a malformed tail (e.g. `a#rb#r1` matching target `a`) leaves it
      // null — unknown, so a pinned reader treats it as matching any revision,
      // preserving the permissive prefix quirk.
      const tail = ref.slice(i + 2);
      const rev = /^\d+$/.test(tail) ? Number(tail) : null;
      target.supersededBy.push({ ref: `${slug}#r${latest.rev}`, rev });
      if (target.status !== 'retracted') target.status = 'superseded';
    }
  }

  return index;
}

/**
 * The writer-legal fields of `position_revision` / `claim` that a delta must
 * cover, i.e. every schema property EXCEPT identity/derived ones
 * (position_revision.{slug,rev,provenance}, claim.id — those don't describe a
 * belief change). These lists are the whole point of finding-1's fix: earlier
 * rounds hand-picked a subset (level + grounding), which silently rendered
 * source / elicitation / supports / rejected_alternatives / provider_ids /
 * retraction changes as "no change". A test locks both lists to
 * contracts/judgment-record.schema.json — if the contract grows a field, that
 * test fails until it is diffed here. Enumerate the schema; do not cherry-pick.
 */
export const REVISION_DELTA_FIELDS = Object.freeze([
  'conviction', 'claims', 'rejected_alternatives', 'supersedes', 'retracted', 'provider_ids',
]);
export const CLAIM_DELTA_FIELDS = Object.freeze([
  'text', 'grounding', 'supports', 'owner_locked', 'elicitation',
]);

/** Normalised, LOSSLESS view of a claim — every writer-legal field, none dropped. */
function claimView(c) {
  return {
    id: c.id,
    text: c.text ?? null,
    grounding: c.grounding ?? null,
    supports: Array.isArray(c.supports) ? c.supports : [],
    owner_locked: c.owner_locked === true,
    elicitation: c.elicitation ?? null,
  };
}

const jsonEq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field-by-field diff of two claim views (both already normalised). */
function claimDelta(before, after) {
  const changes = [];
  if (before.text !== after.text) changes.push(`claim ${after.id} text changed`);
  if (before.grounding !== after.grounding) {
    changes.push(`claim ${after.id} grounding ${before.grounding} -> ${after.grounding}`);
  }
  if (!jsonEq(before.supports, after.supports)) changes.push(`claim ${after.id} supports changed`);
  if (before.owner_locked !== after.owner_locked) {
    changes.push(`claim ${after.id} owner_locked ${before.owner_locked} -> ${after.owner_locked}`);
  }
  if (!jsonEq(before.elicitation, after.elicitation)) changes.push(`claim ${after.id} elicitation changed`);
  return changes;
}

/**
 * Diff two claim-view lists. `id` is the natural key, but the contract does NOT
 * constrain claim ids to be unique within a revision, so an id-keyed map would
 * collapse duplicates and could hide a change entirely (delete one of two `c1`
 * claims -> `delta: []`). When either side has duplicate ids, fall back to a
 * multiset diff over the full normalised claim so nothing is silent; the common
 * unique-id path keeps the field-level messages (`grounding X -> Y`, etc.).
 */
function claimsDelta(before, after) {
  const hasDup = (list) => new Set(list.map((c) => c.id)).size !== list.length;
  if (hasDup(before) || hasDup(after)) {
    const changes = [];
    const bag = new Map(); // normalised-claim JSON -> count in `before`
    for (const c of before) { const k = JSON.stringify(c); bag.set(k, (bag.get(k) ?? 0) + 1); }
    for (const c of after) {
      const k = JSON.stringify(c);
      const n = bag.get(k) ?? 0;
      if (n > 0) bag.set(k, n - 1);
      else changes.push(`claim ${c.id} added`);
    }
    for (const [k, n] of bag) {
      if (n <= 0) continue;
      const { id } = JSON.parse(k);
      for (let i = 0; i < n; i++) changes.push(`claim ${id} removed`);
    }
    return changes;
  }

  const changes = [];
  const prev = new Map(before.map((c) => [c.id, c]));
  for (const c of after) {
    const b = prev.get(c.id);
    if (!b) { changes.push(`claim ${c.id} added`); continue; }
    changes.push(...claimDelta(b, c));
    prev.delete(c.id);
  }
  for (const id of prev.keys()) changes.push(`claim ${id} removed`);
  return changes;
}

/**
 * Per-revision view + a schema-complete delta against the previous revision.
 *
 * Both the claim view and the delta cover every field in REVISION_DELTA_FIELDS /
 * CLAIM_DELTA_FIELDS — see that comment. `judgment_position_amend` is restricted
 * to grounding and conviction, so those are the commonest changes, but a create
 * with `supersedes` / `rejected_alternatives` / `provider_ids`, and a retraction,
 * are all legal and must show up too.
 */
function summarizeRevision(record, previous) {
  const claims = (Array.isArray(record.claims) ? record.claims : []).map(claimView);

  let delta = null;
  if (previous) {
    const changes = [];

    // conviction — level AND source
    const prevConviction = previous.conviction?.level ?? null;
    const conviction = record.conviction?.level ?? null;
    if (prevConviction !== conviction) changes.push(`conviction ${prevConviction} -> ${conviction}`);
    const prevSource = previous.conviction?.source ?? null;
    const source = record.conviction?.source ?? null;
    if (prevSource !== source) changes.push(`conviction source ${prevSource} -> ${source}`);

    // claims — added / removed / every writer-legal field per claim (duplicate-id safe)
    const prevViews = (Array.isArray(previous.claims) ? previous.claims : []).map(claimView);
    changes.push(...claimsDelta(prevViews, claims));

    // rejected_alternatives, provider_ids, supersedes. rejected_alternatives has
    // a schema default of [], so a revision that omits it and one that writes []
    // are the SAME state — normalise both before diffing or every such pair reads
    // as a spurious change.
    const normRA = (x) => (Array.isArray(x) ? x : []);
    if (!jsonEq(normRA(previous.rejected_alternatives), normRA(record.rejected_alternatives))) {
      changes.push('rejected_alternatives changed');
    }
    if (!jsonEq(previous.provider_ids, record.provider_ids)) changes.push('provider_ids changed');
    const prevSupersedes = typeof previous.supersedes === 'string' ? previous.supersedes : null;
    const supersedes = typeof record.supersedes === 'string' ? record.supersedes : null;
    if (prevSupersedes !== supersedes) changes.push(`supersedes ${prevSupersedes} -> ${supersedes}`);

    // retraction — both directions (a tombstone, and the rare un-retraction)
    if (record.retracted === true && previous.retracted !== true) changes.push('retracted');
    if (previous.retracted === true && record.retracted !== true) changes.push('unretracted');

    delta = changes;
  }

  return {
    rev: record.rev,
    written_at: record.provenance?.written_at ?? null,
    conviction: record.conviction?.level ?? null,
    conviction_source: record.conviction?.source ?? null,
    claim_count: claims.length,
    claims,
    rejected_alternatives: Array.isArray(record.rejected_alternatives) ? record.rejected_alternatives : [],
    provider_ids: record.provider_ids ?? null,
    retracted: record.retracted === true,
    supersedes: typeof record.supersedes === 'string' ? record.supersedes : null,
    delta,
  };
}

/**
 * Status of ONE revision, not of the slug's latest.
 *
 * A pinned ancestor node (`b -> a#r1`) must report a#r1's status, not a's. Reading
 * the slug-level index would stamp the node with the latest revision's status —
 * so `a#r1`, live when `b` was decided, would read `retracted` after a later
 * `a#r2` tombstone. Instead:
 *   - this revision itself carries `retracted: true` -> 'retracted'
 *   - a later revision of the same slug exists -> 'superseded' (self-succession)
 *   - this IS the latest revision -> defer to the slug-level index, which is the
 *     only thing that knows about cross-position supersession
 */
function revisionStatus(chain, head, indexEntry) {
  if (head.retracted === true) return 'retracted';
  const latestRev = chain[chain.length - 1].rev;
  if (head.rev < latestRev) return 'superseded';
  return indexEntry?.status ?? 'live';
}

/**
 * Full causal ancestry for one position.
 *
 * **Ancestry is pinned to the referenced revision.** When `b` supersedes
 * `a#r1`, the ancestor node shows `a` as it stood at r1 — not `a`'s current
 * latest. Following the latest would report state that did not exist when the
 * decision was made, which is the exact question this feature exists to answer.
 *
 * `supersedes` is a free-form string ref and nothing in the write path prevents
 * a cycle (a → b → a) or a dangling target, so the walk carries a visited set
 * and reports both rather than recursing forever or throwing.
 *
 * @param {object} store
 * @param {string} slug
 * @param {object} [opts]  {index} to reuse a prebuilt supersession index
 */
export function tracePosition(store, slug, opts = {}) {
  const index = opts.index ?? buildSupersessionIndex(store);
  const warnings = [];
  const visited = new Set();
  let cycle = null;

  /**
   * @param {string} currentSlug
   * @param {number|null} atRev  pin: show state as of this revision (null = latest)
   */
  const walk = (currentSlug, atRev) => {
    const chain = store.readPositionChain(currentSlug);
    if (!chain || chain.length === 0) return null;

    let pinned = atRev;
    if (pinned !== null && !chain.some((r) => r.rev === pinned)) {
      warnings.push(
        `${currentSlug}#r${pinned} referenced but that revision does not exist ` +
        `(chain has r1..r${chain[chain.length - 1].rev}) — showing latest`,
      );
      pinned = null;
    }

    // State as of the pinned revision: everything up to and including it.
    const upTo = pinned === null ? chain : chain.filter((r) => r.rev <= pinned);
    const head = upTo[upTo.length - 1];

    // Cycle check keys on the RESOLVED revision, not the requested pin —
    // otherwise the root (entered unpinned) and a return visit to that same
    // concrete revision look like different nodes and a real cycle escapes.
    // Ancestry is a DAG over (slug, rev), so revisiting (a, r1) is the cycle;
    // revisiting slug `a` at a different revision is not.
    const key = `${currentSlug}#r${head.rev}`;
    if (visited.has(key)) {
      cycle = [...visited, key].join(' -> ');
      return null;
    }
    visited.add(key);

    const entry = index.get(currentSlug);

    // Follow the ref recorded on the PINNED record, not on the latest one.
    let ancestor = null;
    const parsed = parseRevisionRef(head.supersedes);
    if (parsed) {
      if (!index.has(parsed.slug)) {
        warnings.push(
          `${currentSlug} supersedes "${head.supersedes}" but position "${parsed.slug}" does not exist`,
        );
      } else {
        ancestor = walk(parsed.slug, parsed.rev);
      }
    } else if (typeof head.supersedes === 'string') {
      warnings.push(`${currentSlug} has a malformed supersedes ref "${head.supersedes}"`);
    }

    // Reverse refs are scoped by whether this node was reached by a specific
    // `#rN` reference. The queried root — and a dangling ref that fell back to
    // latest — is UNPINNED: `status` is slug-level, so show every reverse ref
    // (otherwise a slug superseded at an earlier revision reads `superseded` with
    // an empty supersededBy). A node reached by a specific reference is PINNED:
    // keep only refs aimed at that revision (plus unknown-rev/malformed ones,
    // matched by prefix and so inseparable), EVEN when that revision happens to
    // be the slug's latest — otherwise a pinned `a#r2` would inherit the ref that
    // superseded `a#r1`.
    const unpinned = pinned === null;
    const supersededBy = (entry?.supersededBy ?? [])
      .filter((e) => unpinned || e.rev === null || e.rev === head.rev)
      .map((e) => parseRevisionRef(e.ref))
      .filter(Boolean);

    return {
      slug: currentSlug,
      rev: head.rev,
      pinned: pinned !== null,
      status: revisionStatus(chain, head, entry),
      revisions: upTo.map((r, i) => summarizeRevision(r, i > 0 ? upTo[i - 1] : null)),
      supersedes: ancestor,
      supersededBy,
    };
  };

  const root = walk(slug, null);
  if (!root) throw typedError('JUDGMENT_NOT_FOUND', `position ${slug} does not exist`);

  let depth = 0;
  for (let node = root; node; node = node.supersedes) depth++;

  return { ...root, depth, cycle, warnings };
}
