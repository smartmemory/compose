/**
 * test/fluid-portfolio.test.js — COMP-FOH FOH-7 S0 + S1.
 *
 * Membership rules and the cross-product aggregator. Real local providers over
 * temp roots, because the failures being defended against are about what
 * happens when a member is absent, empty, or unreadable — and a stub provider
 * cannot be absent in the way a real directory can.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePortfolioConfig } from '../lib/fluid/factory.js';
import { FluidConfigError } from '../lib/fluid/provider.js';

let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'portfolio-')); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** A real Compose project on disk. `bare` omits compose.json but keeps .compose/. */
function project(name, { bare = false } = {}) {
  const root = join(base, name);
  mkdirSync(join(root, '.compose'), { recursive: true });
  mkdirSync(join(root, 'docs', 'product'), { recursive: true });
  if (!bare) writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ workspaceId: name }));
  return root;
}

const withPortfolio = (root, members) => {
  writeFileSync(
    join(root, '.compose', 'compose.json'),
    JSON.stringify({ workspaceId: 'declaring', fluid: { provider: 'local', portfolio: { members } } }),
  );
  return root;
};

describe('FOH-7 S0 — portfolio membership is an explicit, validated list', () => {
  it('is absent by default, preserving single-product behaviour exactly', () => {
    const root = project('solo');
    assert.equal(parsePortfolioConfig(root), null, 'no portfolio block means no portfolio');
  });

  it('parses a declared list and resolves member roots against the declaring root', () => {
    const a = project('alpha');
    project('beta');
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);

    const portfolio = parsePortfolioConfig(a);
    assert.equal(portfolio.members.length, 2);
    assert.deepEqual(portfolio.members.map((m) => m.id), ['alpha', 'beta']);
    assert.ok(portfolio.members.every((m) => m.root.startsWith(base)), 'roots resolved to absolute');
  });

  it('refuses a duplicate member id', () => {
    const a = project('alpha');
    project('beta');
    withPortfolio(a, [{ id: 'same', root: '.' }, { id: 'same', root: '../beta' }]);
    assert.throws(() => parsePortfolioConfig(a), FluidConfigError, 'an ambiguous id is not a portfolio');
  });

  it('refuses an unresolvable member root', () => {
    const a = project('alpha');
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'ghost', root: '../nowhere' }]);
    assert.throws(() => parsePortfolioConfig(a), FluidConfigError);
  });

  // A bare `.compose/` would pass an existence check and fall through to the
  // local provider, contributing an empty corpus that reads as "a product with
  // no ideas" rather than "a member that is not a Compose project".
  it('refuses a member holding a bare .compose directory with no compose.json', () => {
    const a = project('alpha');
    project('hollow', { bare: true });
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'hollow', root: '../hollow' }]);
    assert.throws(() => parsePortfolioConfig(a), FluidConfigError);
  });

  // Never inferred — that would be the discovery D-FOH-7-2 forbids — but its
  // absence silently excludes the corpus the user is actually looking at, so it
  // gets its own named refusal rather than a smaller result.
  it('refuses a portfolio that does not list its own declaring root', () => {
    const a = project('alpha');
    project('beta');
    withPortfolio(a, [{ id: 'beta', root: '../beta' }]);
    assert.throws(
      () => parsePortfolioConfig(a),
      (e) => e instanceof FluidConfigError && /declaring root|itself|own/i.test(e.message),
      'omitting yourself is a misconfiguration, not a smaller portfolio',
    );
  });

  it('refuses a members list that is not an array, and an empty one', () => {
    const a = project('alpha');
    withPortfolio(a, {});
    assert.throws(() => parsePortfolioConfig(a), FluidConfigError);
    withPortfolio(a, []);
    assert.throws(() => parsePortfolioConfig(a), FluidConfigError);
  });
});

// ---------------------------------------------------------------------------
// S1 — the aggregator
// ---------------------------------------------------------------------------

import { openPortfolio, recallAcrossPortfolio, assertMemberWorkspacesDistinct } from '../lib/fluid/portfolio.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';

/** Seed a project with n ideas so it has a corpus to recall against. */
async function seed(root, titles) {
  const p = await new LocalFluidProvider().init(root);
  for (const title of titles) {
    await p.createRecord({ kind: 'idea', title, body: `body of ${title}`, provenance: { origin: 'cli:ideabox' } });
  }
  return p;
}

describe('FOH-7 S1 — the aggregator fans out and names what it could not reach', () => {
  it('opens one provider per member, concurrently', async () => {
    const a = project('alpha'); const b = project('beta');
    await seed(a, ['Caching strategy']); await seed(b, ['Caching in the client']);
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);

    const portfolio = await openPortfolio(a);
    assert.equal(portfolio.sources.length, 2);
    assert.deepEqual(portfolio.sources.map((s) => s.id), ['alpha', 'beta']);
    assert.ok(portfolio.sources.every((s) => s.root && s.provider), 'each source carries root and provider');
  });

  it('returns results attributed to their source, never flattened', async () => {
    const a = project('alpha'); const b = project('beta');
    await seed(a, ['Caching strategy']); await seed(b, ['Caching in the client']);
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);

    const res = await recallAcrossPortfolio(await openPortfolio(a), 'caching');
    assert.equal(res.sources.length, 2);
    for (const s of res.sources) {
      assert.ok(s.id && s.root, 'id AND root — two products can hold the same handle');
      assert.ok(Array.isArray(s.hits));
    }
  });

  // Two products both allocate IDEA-1. Without root, the answer cannot say which.
  it('keeps two identical handles from two products distinguishable', async () => {
    const a = project('alpha'); const b = project('beta');
    await seed(a, ['Alpha first idea']); await seed(b, ['Beta first idea']);
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);

    const res = await recallAcrossPortfolio(await openPortfolio(a), 'idea');
    const handles = res.sources.flatMap((s) => s.hits.map((h) => h.handle));
    if (handles.filter((h) => h === 'IDEA-1').length > 1) {
      const roots = new Set(res.sources.map((s) => s.root));
      assert.equal(roots.size, 2, 'the same handle in two products is separated by root');
    }
  });

  it('names an unreachable member instead of dropping it, and does not fail the turn', async () => {
    const a = project('alpha'); const b = project('beta');
    await seed(a, ['Alpha idea']);
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);
    const portfolio = await openPortfolio(a);
    // Make beta CLAIM recall and then fail, the way an unreachable SmartMemory
    // member would. The local floor has no recall capability at all, so without
    // granting it the member would take the listed-not-searched path and never
    // exercise the failure being tested.
    const beta = portfolio.sources.find((s) => s.id === 'beta');
    beta.provider.has = () => true;
    beta.provider.recall = async () => { throw new Error('connect ECONNREFUSED'); };

    const res = await recallAcrossPortfolio(portfolio, 'idea');
    assert.equal(res.sources.length, 1, 'the reachable source still answers');
    // Alpha emits its own `recall unavailable` omission (it is on the local
    // floor, which has no recall capability), so assert on the one that matters
    // rather than on a total that couples this test to that unrelated fact.
    assert.ok(
      res.omissions.some((o) => /beta/.test(o) && /unreachable/.test(o)),
      `the omission NAMES the unreachable member: ${JSON.stringify(res.omissions)}`,
    );
  });

  it('errors when every member failed, rather than returning an empty result set', async () => {
    const a = project('alpha'); const b = project('beta');
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);
    const portfolio = await openPortfolio(a);
    for (const s of portfolio.sources) {
      s.provider.has = () => true;
      s.provider.recall = async () => { throw new Error('down'); };
    }

    await assert.rejects(
      () => recallAcrossPortfolio(portfolio, 'idea'),
      /all|every/i,
      'an empty answer and a total failure must not look the same',
    );
  });

  it('bounds each member with its own deadline', async () => {
    const a = project('alpha'); const b = project('beta');
    await seed(a, ['Alpha idea']);
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);
    const portfolio = await openPortfolio(a);
    const slow = portfolio.sources.find((s) => s.id === 'beta');
    slow.provider.has = () => true;
    slow.provider.recall = () => new Promise((r) => setTimeout(r, 10_000));

    const started = Date.now();
    const res = await recallAcrossPortfolio(portfolio, 'idea', { deadlineMs: 120 });
    assert.ok(Date.now() - started < 5_000, 'a slow member does not hold the turn open');
    assert.ok(
      res.omissions.some((o) => /beta/.test(o) && /unreachable/.test(o)),
      `the slow member is named, not dropped: ${JSON.stringify(res.omissions)}`,
    );
  });

  // A member on the local floor cannot search. It must contribute what it CAN
  // (its records, listed) and say so — never a synthesized query result.
  it('lists rather than searches a member without recall, and says so by name', async () => {
    const a = project('alpha'); const b = project('beta');
    await seed(a, ['Alpha idea']); await seed(b, ['Beta idea']);
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);
    const portfolio = await openPortfolio(a);
    const beta = portfolio.sources.find((s) => s.id === 'beta');
    beta.provider.has = (cap) => cap !== 'recall';

    const res = await recallAcrossPortfolio(portfolio, 'nothing will match this query', {});
    const betaOut = res.sources.find((s) => s.id === 'beta');
    assert.ok(betaOut, 'a storage-only member still contributes');
    assert.ok(betaOut.hits.length > 0, 'listed, not searched');
    assert.ok(betaOut.listedNotSearched, 'and flagged as such rather than passing for a search result');
    assert.ok(res.omissions.some((o) => /beta/.test(o) && /cannot search/i.test(o)), 'named capability omission');
  });
});

describe('FOH-7 S1 — a total outage is never an empty answer', () => {
  // The guard originally keyed off surviving sources, so failing to OPEN every
  // provider left the list empty before the check ran and the turn returned an
  // empty result set — indistinguishable from "these products have nothing".
  it('errors when every member fails to OPEN, not only when every recall fails', async () => {
    const a = project('alpha');
    const b = project('beta');
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);

    const portfolio = await openPortfolio(a);
    // Simulate both providers failing to construct.
    const broken = { sources: [], omissions: ['alpha misconfigured: boom', 'beta misconfigured: boom'], declared: 2 };
    await assert.rejects(
      () => recallAcrossPortfolio(broken, 'idea'),
      (e) => e.code === 'PORTFOLIO_ALL_FAILED',
      'every member unavailable must raise, never return nothing',
    );
    assert.equal(portfolio.declared, 2, 'openPortfolio reports how many were declared');
  });

  it('a member answering with zero hits is not the same as a member that failed', async () => {
    const a = project('alpha'); project('beta');
    await seed(a, ['Alpha idea']);
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);
    const portfolio = await openPortfolio(a);

    const res = await recallAcrossPortfolio(portfolio, 'nothing matches');
    assert.equal(res.sources.length, 2, 'both answered');
    assert.ok(res.sources.every((s) => Array.isArray(s.hits)), 'an empty answer is still an answer');
    // A capability omission ("cannot search") is not a failure omission — both
    // members are on the local floor and genuinely cannot search, which is a
    // fact about them rather than something going wrong.
    assert.ok(
      !res.omissions.some((o) => /unreachable|unauthorized|unavailable:/.test(o)),
      `no member FAILED: ${JSON.stringify(res.omissions)}`,
    );
  });
});

describe('FOH-7 — a member may not be the colleague\'s own workspace', () => {
  // The existing guard compares Maya's identity claim against the DECLARING
  // root's workspace only. A portfolio adds N more workspaces the turn reads
  // from, none of which that check ever saw — so a member pointed at Maya's own
  // workspace reached a successful chat.
  const smProject = (name, workspaceId) => {
    const root = join(base, name);
    mkdirSync(join(root, '.compose'), { recursive: true });
    writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({
      workspaceId: name,
      fluid: { provider: 'smartmemory', smartmemory: { workspaceId, baseUrl: 'http://x', apiKeyEnv: 'K' } },
    }));
    return root;
  };

  it('refuses a member configured at the colleague\'s workspace', () => {
    const a = project('alpha');
    smProject('beta', 'team_maya_own');
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);
    assert.throws(
      () => assertMemberWorkspacesDistinct(a, 'team_maya_own'),
      (e) => e.code === 'PORTFOLIO_WORKSPACE_COLLISION' && /beta/.test(e.message),
      'the colliding member is named',
    );
  });

  it('allows members on other workspaces', () => {
    const a = project('alpha');
    smProject('beta', 'team_beta');
    withPortfolio(a, [{ id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }]);
    assert.doesNotThrow(() => assertMemberWorkspacesDistinct(a, 'team_maya_own'));
  });

  // Two declared products sharing one workspace is a legitimate configuration,
  // not something to refuse on our opinion (blueprint gate, round 1).
  it('does not impose member-vs-member distinctness', () => {
    const a = project('alpha');
    smProject('beta', 'team_shared');
    smProject('gamma', 'team_shared');
    withPortfolio(a, [
      { id: 'alpha', root: '.' }, { id: 'beta', root: '../beta' }, { id: 'gamma', root: '../gamma' },
    ]);
    assert.doesNotThrow(() => assertMemberWorkspacesDistinct(a, 'team_maya_own'));
  });
});
