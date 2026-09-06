/**
 * lib/fluid/portfolio.js — the cross-product aggregator (COMP-FOH FOH-7).
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ---------------------------------------------
 * A consumer-side aggregator that sits ABOVE the provider seam and fans a single
 * question out across N independently-configured products.
 *
 * It is **not** a `FluidProvider` and must not be registered as one. A provider
 * implies a store, and this has none; and putting fan-out below the seam would
 * place it under per-workspace capability semantics, where "does this support
 * recall" stops having a single answer. Members may use different providers —
 * that is the point of aggregating above the seam rather than below it.
 *
 * PARTIALITY IS THE NORMAL CASE
 * -----------------------------
 * With N independently-configured products reached over N connections, some
 * subset being unavailable is the expected steady state, not an error path. The
 * contract is therefore that **every absent source is NAMED**: a portfolio answer
 * that quietly covers three products when the user declared five is worse than
 * no answer, because nothing in it looks wrong.
 *
 * The one thing that is an error is EVERY member failing. An empty result set
 * and a total outage must never be presented identically.
 */

import { parsePortfolioConfig } from './factory.js';
import { getFluidWorkspaceId } from '../maya-config.js';
import { fluidProviderFor } from './factory.js';
import { KIND, SEMANTIC_CAP } from './provider.js';

/**
 * Per-member deadline.
 *
 * Explicit, and not inherited: the colleague composer's 35s `withDeadline` wraps
 * only its three findings calls, so there is no ambient whole-turn bound to sit
 * inside (blueprint C2). A portfolio turn costs one round trip per member with no
 * server-side batching, so an unbounded member holds the whole turn open.
 */
export const MEMBER_DEADLINE_MS = 20_000;

/** How many records a storage-only member contributes when it cannot search. */
const LISTED_FALLBACK_LIMIT = 25;

/**
 * @typedef {object} PortfolioSource
 * @property {string} id    the declared label
 * @property {string} root  the member's absolute root — carried because two
 *   products can hold the same handle, and the id alone is a name the user chose
 *   while the root is what actually disambiguates
 * @property {import('./provider.js').RecallHit[]} hits
 * @property {boolean} [listedNotSearched] true when the member could not search
 *   and these are its records listed, never a synthesized query result
 */

/**
 * Construct one provider per declared member, concurrently.
 *
 * A member that cannot be opened is an omission, never a thrown turn: the whole
 * point is that one broken product does not silence the others.
 *
 * @param {string} cwd the declaring root
 * @returns {Promise<{sources: Array<{id, root, provider}>, omissions: string[]}>}
 */
export async function openPortfolio(cwd) {
  const config = parsePortfolioConfig(cwd);
  if (!config) return { sources: [], omissions: [], declared: 0 };

  const settled = await Promise.allSettled(
    config.members.map(async (m) => ({ ...m, provider: await fluidProviderFor(m.root) })),
  );

  const sources = [];
  const omissions = [];
  settled.forEach((outcome, i) => {
    const member = config.members[i];
    if (outcome.status === 'fulfilled') sources.push(outcome.value);
    else omissions.push(`${member.id} misconfigured: ${reasonOf(outcome.reason)}`);
  });
  return { sources, omissions, declared: config.members.length };
}

/**
 * Ask every member the same question.
 *
 * @param {{sources: Array<{id, root, provider}>, omissions: string[]}} portfolio
 * @param {string} query
 * @param {{deadlineMs?: number, limit?: number}} [opts]
 * @returns {Promise<{sources: PortfolioSource[], omissions: string[]}>}
 */
export async function recallAcrossPortfolio(portfolio, query, opts = {}) {
  const deadlineMs = opts.deadlineMs ?? MEMBER_DEADLINE_MS;
  const omissions = [...portfolio.omissions];

  const settled = await Promise.allSettled(
    portfolio.sources.map((source) => withDeadline(askOne(source, query, opts), deadlineMs, source.id)),
  );

  const sources = [];
  settled.forEach((outcome, i) => {
    const source = portfolio.sources[i];
    if (outcome.status === 'rejected') {
      omissions.push(`${source.id} ${classify(outcome.reason)}`);
      return;
    }
    const { hits, listedNotSearched, omission } = outcome.value;
    if (omission) omissions.push(omission);
    sources.push({
      id: source.id,
      root: source.root,
      hits,
      ...(listedNotSearched ? { listedNotSearched: true } : {}),
    });
  });

  // An empty answer and a total outage must not look the same. This is the one
  // partiality that is NOT the normal case.
  const declared = portfolio.declared ?? portfolio.sources.length;
  if (!sources.length && declared > 0) {
    const err = new Error(
      `compose: every portfolio member failed — ${omissions.join('; ')}`,
    );
    err.code = 'PORTFOLIO_ALL_FAILED';
    err.omissions = omissions;
    throw err;
  }

  return { sources, omissions };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * One member's contribution.
 *
 * A member that cannot search is not skipped and is not faked: it contributes
 * what it genuinely has — its records, listed — flagged as such, plus a named
 * omission. Returning its list as if it were a query result would be the silent
 * substitution this feature exists to avoid.
 */
async function askOne(source, query, opts) {
  const { provider, id } = source;
  // The DECLARED constant, never a bare string: `has()` is a plain Set lookup
  // on `capabilities()`, and the FOH-7 live-fire (2026-09-06) found `'recall'`
  // here against a provider declaring `'RECALL'` — every member, SmartMemory
  // included, silently took the listed-not-searched path and the suite stayed
  // green because its stubs replaced `has()` outright.
  const canRecall = typeof provider.has === 'function' ? provider.has(SEMANTIC_CAP.RECALL) : true;

  if (!canRecall) {
    const records = await provider.listRecords({ kind: KIND.IDEA });
    // BY RECENCY, before the limit. `listRecords` returns the local provider's
    // storage order (cluster, then handle number), so slicing it directly hands
    // back a product's OLDEST ideas — an established product would omit its
    // newest decisions every time, which is the worst possible subset to show
    // for a question about what was recently decided.
    const recent = [...records].sort((a, b) =>
      String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
    return {
      hits: recent.slice(0, opts.limit ?? LISTED_FALLBACK_LIMIT).map((record) => ({
        handle: record.handle,
        // Null, never 0: this member did not rank anything, and 0 would read as
        // "ranked, and terrible" (see RecallHit in provider.js).
        score: null,
        record,
      })),
      listedNotSearched: true,
      omission: `${id} cannot search (no recall capability) — listed its records instead`,
    };
  }

  const hits = await provider.recall(query, opts.limit ? { limit: opts.limit } : {});
  return { hits: hits ?? [], listedNotSearched: false, omission: null };
}

/** Reject after `ms`, naming the member so the omission can name it too. */
function withDeadline(promise, ms, id) {
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`did not answer within ${ms}ms`);
      err.code = 'PORTFOLIO_MEMBER_TIMEOUT';
      err.memberId = id;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

const reasonOf = (err) => String(err?.message ?? err ?? 'unknown').slice(0, 160);

/**
 * Turn a failure into the omission's reason class.
 *
 * The vocabulary reuses wording the cockpit already uses ("SmartMemory
 * unreachable", `RecallTab.jsx:29`) rather than coining a parallel one, and the
 * 403 branch depends on `scopeError` being retained on the error — see the
 * blueprint's D1.
 */
function classify(err) {
  if (err?.code === 'PORTFOLIO_MEMBER_TIMEOUT') return `unreachable: ${reasonOf(err)}`;
  const status = typeof err?.status === 'number' ? err.status : null;
  if (status === 403 || status === 401) {
    const scope = err?.scopeError;
    if (scope === 'not-a-member') return 'unauthorized: not a member of that workspace';
    if (scope === 'missing-scope') return 'unauthorized: the key lacks the required scope';
    return 'unauthorized: reason undetermined';
  }
  if (status === 0 || /ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(reasonOf(err))) {
    return `unreachable: ${reasonOf(err)}`;
  }
  return `unavailable: ${reasonOf(err)}`;
}

/**
 * Refuse a portfolio where any member's fluid workspace is the colleague's own.
 *
 * The existing guard (`lib/maya-identity.js`) compares Maya's identity claim
 * against ONE configured workspace — the declaring root's. A portfolio adds N
 * more workspaces the turn will read from, and none of them was checked: the
 * shallow-binding isolation this protects is not a property of the declaring
 * root, it is a property of every workspace the turn touches. Without it a
 * member configured at Maya's own workspace reaches a successful chat, which is
 * the isolation failure the declaring-root check exists to prevent, arriving
 * through a door that check does not cover.
 *
 * Deliberately NOT member-vs-member: two declared products may legitimately
 * share a workspace, and refusing that would be our policy rather than a
 * required invariant.
 *
 * @param {string} cwd the declaring root
 * @param {string|null} identityWorkspaceId Maya's own verified workspace
 * @throws {Error} code PORTFOLIO_WORKSPACE_COLLISION
 */
export function assertMemberWorkspacesDistinct(cwd, identityWorkspaceId) {
  if (!identityWorkspaceId) return;
  const config = parsePortfolioConfig(cwd);
  if (!config) return;

  const collisions = config.members
    .filter((m) => getFluidWorkspaceId(m.root) === identityWorkspaceId)
    .map((m) => m.id);

  if (collisions.length) {
    const err = new Error(
      `compose: portfolio member(s) ${collisions.join(', ')} are configured at the colleague's own ` +
      `workspace (${identityWorkspaceId}) — a turn cannot read the memory it is writing from`,
    );
    err.code = 'PORTFOLIO_WORKSPACE_COLLISION';
    err.collisions = collisions;
    throw err;
  }
}
