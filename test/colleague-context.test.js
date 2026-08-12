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
