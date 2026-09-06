/**
 * Tests for lib/colleague/context.js (FOH-6 S2) — the per-turn channel_context
 * composer, first production consumer of the FOH-3/4/5 capabilities.
 *
 * Contracts under test (design-foh-6.md §3):
 *   - per-capability inclusion is DECLARED-capability-derived (provider.has),
 *     absence ≠ omission
 *   - a capability call that throws is an omission naming the section, never a
 *     turn failure
 *   - truncation priority under the byte budget: contradictions > conviction >
 *     challenge > record body (truncated to headline first) > discussion
 *     (dropped first) — and every drop is NAMED in omissions
 *   - provenance authors are explicit (compose:idea <HANDLE>, compose:conviction, …)
 *   - no focus → corpus-level context (recent ideas list)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { composeColleagueContext } = await import(`${ROOT}/lib/colleague/context.js`);
const { contradictionsOf, IdeaboxNotFound } = await import(`${ROOT}/lib/fluid/ideabox-ops.js`);
const { CAP, FluidRecordNotFound } = await import(`${ROOT}/lib/fluid/provider.js`);

const IDEA = {
  handle: 'IDEA-42',
  kind: 'idea',
  title: 'Queue-based gate retries',
  body: 'Persist gate retries in Redis streams with a per-lane retry budget.',
  status: 'open',
  priority: 'P1',
  links: [],
  discussion: [
    { author: 'ruze', text: 'worth a spike?', ts: '2026-08-01T00:00:00Z' },
    { author: 'maya', text: 'yes — sized it S', ts: '2026-08-02T00:00:00Z' },
  ],
  updated_at: '2026-08-02T00:00:00Z',
};

const OTHER = {
  handle: 'IDEA-7', kind: 'idea', title: 'File-based retries', status: 'open',
  body: 'Keep retries on disk.', links: [], discussion: [], updated_at: '2026-08-01T00:00:00Z',
};

/** A seam-shaped fake provider with per-capability knobs. */
function fakeProvider({
  caps = [CAP.CHALLENGE, CAP.CONVICTION, CAP.CONTRADICTION],
  ideas = [IDEA, OTHER],
  conviction = {
    handle: 'IDEA-42', confidence: 0.5, challenged: true, challengeCount: 1,
    lastChallengedAt: '2026-08-10T00:00:00Z',
    history: [{
      timestamp: '2026-08-10T00:00:00Z', oldConfidence: 1, newConfidence: 0.5,
      decayFactor: 0.5, reason: 'manual_resolution:accept_new', conflictingFact: 'disk is fine',
    }],
  },
  contradictions = [{ handle: 'IDEA-7', kind: 'idea', record: OTHER }],
  challenge = {
    assertion: IDEA.body, hasConflicts: true, confidence: 0.6,
    conflicts: [{
      handle: 'IDEA-7', existingText: 'Keep retries on disk.',
      conflictType: 'direct_contradiction', confidence: 0.8,
      explanation: 'disk vs redis persistence', suggestedResolution: 'keep_existing',
    }],
  },
  throws = {},
} = {}) {
  const capSet = new Set(caps);
  const maybe = (name, value) => {
    if (throws[name]) throw throws[name];
    return value;
  };
  return {
    has: (cap) => capSet.has(cap),
    listRecords: async ({ kind } = {}) => maybe('listRecords', ideas.filter((i) => !kind || i.kind === kind)),
    conviction: async () => maybe('conviction', conviction),
    contradictions: async () => maybe('contradictions', contradictions),
    challenge: async () => maybe('challenge', challenge),
  };
}

function ctxWith(provider) {
  const cwd = mkdtempSync(join(tmpdir(), 'foh6-ctx-'));
  return { cwd, provider, ideaboxPath: join(cwd, 'ideabox.md'), config: {}, origin: 'ui:ideabox' };
}

const authors = (r) => r.blocks.map((b) => b.author);

describe('composeColleagueContext', () => {
  test('focused turn with all capabilities: record + findings + discussion, provenance authors', async () => {
    const result = await composeColleagueContext(ctxWith(fakeProvider()), { focusId: 'idea-42' });
    assert.deepEqual(authors(result), [
      'compose:idea IDEA-42',
      'compose:conviction',
      'compose:contradiction',
      'compose:challenge',
      'compose:discussion',
    ]);
    assert.deepEqual(result.omissions, []);

    const text = (author) => result.blocks.find((b) => b.author === author).text;
    assert.match(text('compose:idea IDEA-42'), /Queue-based gate retries/);
    assert.match(text('compose:idea IDEA-42'), /Redis streams/);
    assert.match(text('compose:conviction'), /0\.5/);
    assert.match(text('compose:conviction'), /challenged 1/);
    assert.match(text('compose:contradiction'), /IDEA-7/);
    assert.match(text('compose:challenge'), /direct_contradiction/);
    assert.match(text('compose:discussion'), /worth a spike\?/);
  });

  test('undeclared capability → section absent, NOT an omission (absence ≠ failure)', async () => {
    const provider = fakeProvider({ caps: [CAP.CONVICTION] }); // no challenge/contradiction
    const result = await composeColleagueContext(ctxWith(provider), { focusId: 'IDEA-42' });
    assert.ok(!authors(result).includes('compose:challenge'));
    assert.ok(!authors(result).includes('compose:contradiction'));
    assert.ok(authors(result).includes('compose:conviction'));
    assert.deepEqual(result.omissions, []);
  });

  test('capability throw ≠ turn failure: section omitted and NAMED, others survive', async () => {
    const provider = fakeProvider({ throws: { conviction: new Error('service 500') } });
    const result = await composeColleagueContext(ctxWith(provider), { focusId: 'IDEA-42' });
    assert.ok(!authors(result).includes('compose:conviction'));
    assert.ok(authors(result).includes('compose:contradiction'));
    assert.ok(result.omissions.some((o) => /conviction unavailable/.test(o)));
  });

  test('truncation golden: discussion drops first, record truncates to headline, contradiction SURVIVES', async () => {
    const fat = 'x'.repeat(800);
    const provider = fakeProvider({
      ideas: [{ ...IDEA, body: fat, discussion: [{ author: 'ruze', text: fat, ts: 't' }] }, OTHER],
    });
    // Budget fits findings but not the fat body/discussion.
    const result = await composeColleagueContext(ctxWith(provider), { focusId: 'IDEA-42', byteBudget: 900 });
    const a = authors(result);
    assert.ok(!a.includes('compose:discussion'), 'discussion dropped first');
    assert.ok(a.includes('compose:contradiction'), 'contradiction must survive truncation');
    assert.ok(result.omissions.some((o) => /discussion/.test(o)));
    // Record survives but truncated to headline: title present, fat body gone.
    const record = result.blocks.find((b) => b.author.startsWith('compose:idea'));
    assert.match(record.text, /Queue-based gate retries/);
    assert.ok(!record.text.includes(fat));
    assert.ok(result.omissions.some((o) => /record body/.test(o)));
  });

  test('extreme budget: findings drop in reverse priority, every drop named', async () => {
    const result = await composeColleagueContext(ctxWith(fakeProvider()), { focusId: 'IDEA-42', byteBudget: 1 });
    // Nothing fits; contradiction is the LAST to go.
    assert.ok(result.omissions.some((o) => /challenge/.test(o)));
    assert.ok(result.omissions.some((o) => /conviction/.test(o)));
    assert.ok(result.omissions.some((o) => /contradiction/.test(o)));
  });

  test('long finding lists are capped per section, cap named in omissions', async () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({
      handle: `IDEA-${i + 100}`, kind: 'idea',
      record: { ...OTHER, handle: `IDEA-${i + 100}`, title: `alt ${i}` },
    }));
    const provider = fakeProvider({ contradictions: hits });
    const result = await composeColleagueContext(ctxWith(provider), { focusId: 'IDEA-42' });
    const block = result.blocks.find((b) => b.author === 'compose:contradiction');
    assert.match(block.text, /IDEA-104/);
    assert.ok(!block.text.includes('IDEA-105'), 'capped at 5');
    assert.ok(result.omissions.some((o) => /contradictions .*5 of 8/.test(o)));
  });

  test('no focus → corpus-level context: recent ideas list', async () => {
    const result = await composeColleagueContext(ctxWith(fakeProvider()), { focusId: null });
    assert.deepEqual(authors(result), ['compose:ideabox']);
    const block = result.blocks[0];
    assert.match(block.text, /IDEA-42/);
    assert.match(block.text, /IDEA-7/);
  });

  test('unknown focus → IdeaboxNotFound (the route maps it to the context funnel)', async () => {
    await assert.rejects(
      composeColleagueContext(ctxWith(fakeProvider()), { focusId: 'IDEA-999' }),
      (err) => err instanceof IdeaboxNotFound,
    );
  });
});

describe('contradictionsOf (ideabox-ops wrapper)', () => {
  test('resolves case-insensitively and returns the provider hits', async () => {
    const provider = fakeProvider();
    const hits = await contradictionsOf(ctxWith(provider), 'idea-42');
    assert.equal(hits[0].handle, 'IDEA-7');
  });

  test('FluidRecordNotFound → IdeaboxNotFound', async () => {
    const provider = fakeProvider({ throws: { contradictions: new FluidRecordNotFound('IDEA-42') } });
    await assert.rejects(
      contradictionsOf(ctxWith(provider), 'IDEA-42'),
      (err) => err instanceof IdeaboxNotFound,
    );
  });
});

// ---------------------------------------------------------------------------
// FOH-7 S2 — portfolio scope
// ---------------------------------------------------------------------------

import { composePortfolioContext } from '../lib/colleague/context.js';

describe('FOH-7 S2 — the portfolio context', () => {
  const portfolioOf = (sources, omissions = []) => ({ sources, omissions });
  const hit = (handle, title) => ({ handle, score: null, record: { handle, title, body: `${title} body` } });

  test('emits one block per source, each carrying its source identity', async () => {
    const recall = async () => portfolioOf([
      { id: 'alpha', root: '/tmp/alpha', hits: [hit('IDEA-1', 'Caching')] },
      { id: 'beta', root: '/tmp/beta', hits: [hit('IDEA-1', 'Client caching')] },
    ]);
    const out = await composePortfolioContext({ text: 'caching' }, { recallAcross: recall });

    assert.equal(out.blocks.length, 2);
    for (const b of out.blocks) {
      assert.ok(b.source?.id && b.source?.root, 'structured source for the panel');
      assert.ok(b.text.includes(b.source.id), 'and the identity survives inside the text for Maya');
      assert.ok(b.text.includes(b.source.root), 'root too — two products can hold the same handle');
    }
  });

  // Maya's schema is flat `List[Dict[str, str]]`. A projection that merely drops
  // `source` would pass a "no nested source" assertion while handing Maya two
  // identical handles it cannot tell apart.
  test('projects flat for Maya with the source surviving in the prose', async () => {
    const recall = async () => portfolioOf([
      { id: 'alpha', root: '/tmp/alpha', hits: [hit('IDEA-1', 'Same title')] },
      { id: 'beta', root: '/tmp/beta', hits: [hit('IDEA-1', 'Same title')] },
    ]);
    const out = await composePortfolioContext({ text: 'q' }, { recallAcross: recall });
    const flat = out.blocks.map(({ author, text }) => ({ author, text }));

    for (const b of flat) assert.deepEqual(Object.keys(b).sort(), ['author', 'text']);
    assert.notEqual(flat[0].text, flat[1].text, 'the two blocks must not be indistinguishable to Maya');
    assert.ok(flat.some((b) => b.text.includes('alpha')) && flat.some((b) => b.text.includes('beta')));
  });

  test('passes every omission through, named', async () => {
    const recall = async () => portfolioOf(
      [{ id: 'alpha', root: '/tmp/alpha', hits: [] }],
      ['beta unreachable: connect ECONNREFUSED'],
    );
    const out = await composePortfolioContext({ text: 'q' }, { recallAcross: recall });
    assert.ok(out.omissions.some((o) => /beta/.test(o)));
  });

  test('marks a listed-not-searched source as such in its block', async () => {
    const recall = async () => portfolioOf([
      { id: 'alpha', root: '/tmp/alpha', hits: [hit('IDEA-1', 'Thing')], listedNotSearched: true },
    ]);
    const out = await composePortfolioContext({ text: 'q' }, { recallAcross: recall });
    assert.match(out.blocks[0].text, /listed|not searched/i, 'never passes for a search result');
  });

  test('uses the turn text as the recall query', async () => {
    let seen = null;
    const recall = async (_p, query) => { seen = query; return portfolioOf([{ id: 'a', root: '/r', hits: [] }]); };
    await composePortfolioContext({ text: 'what did we decide about caching' }, { recallAcross: recall });
    assert.equal(seen, 'what did we decide about caching');
  });
});

describe('FOH-7 S2 — the portfolio context has a budget, and every trim is named', () => {
  const hit = (handle, title) => ({ handle, score: null, record: { handle, title, body: `${title} body` } });

  // Without this, a large portfolio silently answers for fewer products than it
  // shows: Maya caps the context section and keeps a prefix, so later products
  // are discarded upstream while the panel still reports every source as sent.
  test('stays within the byte budget across many members', async () => {
    const sources = Array.from({ length: 16 }, (_, i) => ({
      id: `p${i}`,
      root: `/r/p${i}`,
      hits: Array.from({ length: 40 }, (_, j) => hit(`IDEA-${j}`, `A fairly long idea title number ${j} for product ${i}`)),
    }));
    const recall = async () => ({ sources, omissions: [] });

    const out = await composePortfolioContext({ text: 'q' }, { recallAcross: recall, byteBudget: 8000 });
    const bytes = out.blocks.reduce((n, b) => n + Buffer.byteLength(b.text, 'utf8'), 0);
    // A HARD bound. The first version of this allowed 20% overage, which made
    // the assertion unfalsifiable for the exact failure it names — a budget that
    // is only mostly respected is not a budget, and the test said so while
    // permitting the opposite.
    assert.ok(bytes <= 8000, `context stayed within the budget (was ${bytes} bytes)`);
  });

  test('names every source it truncated, so a trimmed turn never looks clean', async () => {
    const sources = Array.from({ length: 4 }, (_, i) => ({
      id: `p${i}`,
      root: `/r/p${i}`,
      hits: Array.from({ length: 50 }, (_, j) => hit(`IDEA-${j}`, `Long idea title ${j} in product ${i}`)),
    }));
    const out = await composePortfolioContext(
      { text: 'q' }, { recallAcross: async () => ({ sources, omissions: [] }), byteBudget: 600 },
    );
    for (const s of sources) {
      assert.ok(
        out.omissions.some((o) => o.startsWith(`${s.id} truncated`)),
        `${s.id} truncation is named: ${JSON.stringify(out.omissions)}`,
      );
    }
  });

  // A budget consumed in order privileges whichever product sorts first and
  // starves the rest for a reason no reader could infer.
  test('shares the budget evenly rather than first-come', async () => {
    const sources = ['alpha', 'beta', 'gamma'].map((id) => ({
      id, root: `/r/${id}`,
      hits: Array.from({ length: 30 }, (_, j) => hit(`IDEA-${j}`, `Idea ${j} of ${id} with a reasonably long title`)),
    }));
    const out = await composePortfolioContext(
      { text: 'q' }, { recallAcross: async () => ({ sources, omissions: [] }), byteBudget: 900 },
    );
    const sizes = out.blocks.map((b) => Buffer.byteLength(b.text, 'utf8'));
    const spread = Math.max(...sizes) - Math.min(...sizes);
    assert.ok(spread < Math.max(...sizes) * 0.5, `no product is starved (sizes ${sizes})`);
    assert.equal(out.blocks.length, 3, 'and none is dropped entirely');
  });
});

describe('FOH-7 S2 — a dropped source must not read as an empty one', () => {
  const hit = (h, t) => ({ handle: h, score: null, record: { handle: h, title: t, body: t } });

  // Omissions travel to the PANEL, not into Maya's context. A source whose
  // results were all dropped for size would otherwise tell the MODEL "(nothing)"
  // — that this product has no matching ideas — which is the opposite of what
  // happened, and exactly the silent partial answer this feature exists to stop.
  test('says results were omitted, not that there were none', async () => {
    const long = 'x'.repeat(400);
    const recall = async () => ({
      sources: [{ id: 'alpha', root: '/r/a', hits: [hit('IDEA-1', long), hit('IDEA-2', long)] }],
      omissions: [],
    });
    const out = await composePortfolioContext({ text: 'q' }, { recallAcross: recall, byteBudget: 120 });
    assert.doesNotMatch(out.blocks[0].text, /\(nothing\)/, 'never claims the product is empty');
    assert.match(out.blocks[0].text, /omitted/i, 'the model is told results exist and were dropped');
  });

  test('still says "(nothing)" when a source genuinely returned no results', async () => {
    const recall = async () => ({ sources: [{ id: 'alpha', root: '/r/a', hits: [] }], omissions: [] });
    const out = await composePortfolioContext({ text: 'q' }, { recallAcross: recall });
    assert.match(out.blocks[0].text, /\(nothing\)/);
  });
});

describe('FOH-7 S2 — a source that does not fit at all still says so', () => {
  test('names a source whose header alone exceeds its share', async () => {
    const recall = async () => ({
      sources: [{ id: 'alpha', root: '/a/very/long/path/that/eats/the/entire/share/on/its/own', hits: [] }],
      omissions: [],
    });
    const out = await composePortfolioContext({ text: 'q' }, { recallAcross: recall, byteBudget: 1 });
    assert.ok(
      out.omissions.some((o) => /alpha/.test(o) && /over budget/.test(o)),
      `an over-budget source is never silent: ${JSON.stringify(out.omissions)}`,
    );
  });
});
