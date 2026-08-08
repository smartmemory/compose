/**
 * judgment-trace.test.js — COMP-JUDGMENT-PRECEDENT slice A.
 *
 * The judgment store persists full causal history (revision chains, the
 * `supersedes: <slug>#r<N>` reference, retraction tombstones) and exposes none
 * of it: get_judgment_state returns latest-only. These cover the two additions
 * that make it readable — a single-pass supersession index and a cycle-guarded
 * ancestry walk.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { RecordsStore } from '../lib/judgment/store/records.js';
import { createJudgmentStore } from '../lib/judgment/store/index.js';
import {
  buildSupersessionIndex, tracePosition,
  REVISION_DELTA_FIELDS, CLAIM_DELTA_FIELDS,
} from '../lib/judgment/trace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const provenance = { actor: 'agent', session: null, written_at: '2026-08-08T12:00:00Z' };

function freshStore() {
  const cwd = mkdtempSync(join(tmpdir(), 'judgment-trace-'));
  return { cwd, raw: new RecordsStore(cwd), store: createJudgmentStore(cwd) };
}

function rev(slug, overrides = {}) {
  return {
    slug,
    claims: [{ id: 'c1', text: `claim for ${slug}`, grounding: 'INT', supports: [] }],
    conviction: { level: 'high', source: 'stated' },
    provenance,
    ...overrides,
  };
}

describe('buildSupersessionIndex', () => {
  test('reports forward and reverse refs for a supersession pair', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('old'));
    raw.writePositionRevision(rev('new', { supersedes: 'old#r1' }));

    const idx = buildSupersessionIndex(store);

    assert.equal(idx.get('new').supersedes, 'old#r1');
    assert.deepEqual(idx.get('new').supersededBy, []);
    assert.equal(idx.get('old').supersedes, null);
    assert.deepEqual(idx.get('old').supersededBy, [{ ref: 'new#r1', rev: 1 }]);
  });

  test('a fork — two live positions superseding the same revision — keeps BOTH', () => {
    // Review r3 P2: supersededBy was scalar and last-writer-wins, so one of the
    // two successors vanished. `supersedes` is unconstrained, nothing stops a
    // fork, and the reverse index must not silently drop one arm of it.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('root'));
    raw.writePositionRevision(rev('forkA', { supersedes: 'root#r1' }));
    raw.writePositionRevision(rev('forkB', { supersedes: 'root#r1' }));

    const idx = buildSupersessionIndex(store);
    const by = idx.get('root').supersededBy.map((e) => e.ref).sort();
    assert.deepEqual(by, ['forkA#r1', 'forkB#r1'], 'both successors preserved');
    assert.equal(idx.get('root').status, 'superseded');
  });

  test('agrees with derivePositionStatus on every slug', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('a'));
    raw.writePositionRevision(rev('b', { supersedes: 'a#r1' }));
    raw.writePositionRevision(rev('c'));
    raw.writePositionRevision(rev('c', { retracted: true, claims: [] }));

    const idx = buildSupersessionIndex(store);
    for (const slug of store.listPositionSlugs()) {
      assert.equal(idx.get(slug).status, store.derivePositionStatus(slug),
        `status mismatch for ${slug}`);
    }
  });

  test('a retracted superseder does not mark its target superseded', () => {
    // Mirrors derivePositionStatus: a tombstoned position's supersedes ref is
    // not load-bearing, otherwise retracting the replacement would strand the
    // original as permanently superseded.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('target'));
    raw.writePositionRevision(rev('replacement', { supersedes: 'target#r1' }));
    raw.writePositionRevision(rev('replacement', { retracted: true, claims: [] }));

    const idx = buildSupersessionIndex(store);
    assert.deepEqual(idx.get('target').supersededBy, []);
    assert.equal(idx.get('target').status, 'live');
  });

  test('a self-supersession does NOT mark the position superseded', () => {
    // Review r1 P1: derivePositionStatus skips `other === slug`, so a position
    // that supersedes its own earlier revision stays live. The index must match.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('solo'));
    raw.writePositionRevision(rev('solo', { supersedes: 'solo#r1' }));

    const idx = buildSupersessionIndex(store);
    assert.equal(idx.get('solo').status, 'live');
    assert.deepEqual(idx.get('solo').supersededBy, []);
    assert.equal(store.derivePositionStatus('solo'), 'live', 'original must agree');
  });

  test('a malformed revision tail still counts as superseding (prefix match)', () => {
    // Review r1 P1: the original matches with startsWith(`${slug}#r`), so `a#rX`
    // counts. Strict parsing here would silently change status for bad records.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('base'));
    raw.writePositionRevision(rev('later', { supersedes: 'base#rX' }));

    const idx = buildSupersessionIndex(store);
    assert.equal(idx.get('base').status, 'superseded');
    assert.equal(store.derivePositionStatus('base'), 'superseded', 'original must agree');
  });

  test('a ref matching MULTIPLE targets marks all of them (multi-target prefix)', () => {
    // Review r2 P2: the O(n) rewrite enumerates the ref's own '#r' split points
    // instead of scanning every target. `a#rb#r1` must still match BOTH `a` and
    // `a#rb`, exactly as the original startsWith scan did.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('a'));
    raw.writePositionRevision(rev('a#rb'));
    raw.writePositionRevision(rev('super', { supersedes: 'a#rb#r1' }));

    const idx = buildSupersessionIndex(store);
    assert.equal(idx.get('a').status, 'superseded');
    assert.equal(idx.get('a#rb').status, 'superseded');
    for (const slug of store.listPositionSlugs()) {
      assert.equal(idx.get(slug).status, store.derivePositionStatus(slug),
        `original must agree for ${slug}`);
    }
  });

  test('split-point enumeration is exactly equivalent to the original prefix scan', () => {
    // The O(n) rewrite (review r2 P2) claims exact equivalence with the original
    // `ref.startsWith(slug + '#r')` scan. Review r3 P2: the earlier version of
    // this test RE-IMPLEMENTED the split-point loop inline, so it proved the
    // copy, not the shipped code — it would stay green if buildSupersessionIndex
    // regressed. Drive the REAL function instead, against an in-memory store, and
    // compare its reverse index to the original prefix scan.
    const targets = ['a', 'b', 'a#rb', 'a#r', '#r', '', 'x#r1', 'a#rb#rc', 'ab', 'a#', 'r1'];
    const refs = ['a#r1', 'a#rb#r1', '#r1', 'a#r', 'a#rb#rc#r2', '', 'a',
                  'x#r1#r1', 'a#r0', '#r#r1', 'a#rb#r', 'ab#r1'];

    // Minimal store surface buildSupersessionIndex actually reads.
    const makeStore = (records) => ({
      listPositionSlugs: () => [...records.keys()],
      latestPositionRevision: (slug) => records.get(slug) ?? null,
    });

    for (const ref of refs) {
      // The original scan: which target slugs does `ref` supersede? (Superseder
      // slug excluded, mirroring the self-edge skip.)
      const expected = targets.filter((s) => s !== '__super__' && ref.startsWith(`${s}#r`)).sort();

      const records = new Map();
      for (const s of targets) records.set(s, { slug: s, rev: 1 });
      records.set('__super__', { slug: '__super__', rev: 1, supersedes: ref });

      const idx = buildSupersessionIndex(makeStore(records));
      const marked = targets
        .filter((s) => idx.get(s).supersededBy.some((e) => e.ref === '__super__#r1'))
        .sort();
      assert.deepEqual(marked, expected, `divergence for ref ${JSON.stringify(ref)}`);
      for (const s of expected) {
        assert.equal(idx.get(s).status, 'superseded', `${s} should be superseded for ref ${ref}`);
      }
    }
  });

  test('empty store yields an empty index', () => {
    const { store } = freshStore();
    assert.equal(buildSupersessionIndex(store).size, 0);
  });
});

describe('tracePosition', () => {
  test('returns every revision in order with the pre-amendment state visible', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('alpha', { conviction: { level: 'low', source: 'stated' } }));
    raw.writePositionRevision(rev('alpha', { conviction: { level: 'high', source: 'stated' } }));

    const t = tracePosition(store, 'alpha');

    assert.equal(t.revisions.length, 2);
    assert.deepEqual(t.revisions.map((r) => r.rev), [1, 2]);
    // The whole point: r1's belief is still legible after r2 replaced it.
    assert.equal(t.revisions[0].conviction, 'low');
    assert.equal(t.revisions[1].conviction, 'high');
  });

  test('walks supersession backwards across slugs', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('gen1'));
    raw.writePositionRevision(rev('gen2', { supersedes: 'gen1#r1' }));
    raw.writePositionRevision(rev('gen3', { supersedes: 'gen2#r1' }));

    const t = tracePosition(store, 'gen3');

    assert.equal(t.supersedes.slug, 'gen2');
    assert.equal(t.supersedes.supersedes.slug, 'gen1');
    assert.equal(t.supersedes.supersedes.supersedes, null);
    assert.equal(t.depth, 3);
  });

  test('reports what superseded this position', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('old'));
    raw.writePositionRevision(rev('new', { supersedes: 'old#r1' }));

    const t = tracePosition(store, 'old');
    assert.equal(t.status, 'superseded');
    assert.equal(t.supersededBy.length, 1);
    assert.equal(t.supersededBy[0].slug, 'new');
    assert.equal(t.supersededBy[0].rev, 1);
  });

  test('a forked position reports BOTH successors', () => {
    // Review r3 P2: the scalar reverse ref dropped all but the last successor.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('root'));
    raw.writePositionRevision(rev('forkA', { supersedes: 'root#r1' }));
    raw.writePositionRevision(rev('forkB', { supersedes: 'root#r1' }));

    const t = tracePosition(store, 'root');
    assert.deepEqual(t.supersededBy.map((s) => s.slug).sort(), ['forkA', 'forkB']);
  });

  test('the queried position keeps status and supersededBy in the same (slug-level) scope', () => {
    // Guard against fixing finding 3 in one direction and breaking the other:
    // `old#r1` is superseded by `newer`, then `old` is amended to r2. The slug is
    // still `superseded` (prefix-match quirk, behaviour-identical), so the root
    // trace must ALSO surface what superseded it, not an empty list.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('old'));
    raw.writePositionRevision(rev('newer', { supersedes: 'old#r1' }));
    raw.writePositionRevision(rev('old', { conviction: { level: 'medium', source: 'stated' } })); // old#r2

    const t = tracePosition(store, 'old');
    assert.equal(t.rev, 2, 'root shows the latest revision');
    assert.equal(t.status, 'superseded', 'slug-level status is preserved');
    assert.deepEqual(t.supersededBy.map((s) => s.slug), ['newer'],
      'status superseded must not come with an empty supersededBy');
  });

  test('a pinned ancestor at the LATEST revision still filters reverse refs to that revision', () => {
    // Review r4 P2: a `showingLatest` shortcut let a pinned node that happened to
    // be the slug's latest revision inherit every reverse ref. `olderArm -> a#r1`
    // and `root -> a#r2`: tracing `root` must show a#r2 superseded by `root` only,
    // NOT also by `olderArm` (which superseded r1).
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('a'));                              // a#r1
    raw.writePositionRevision(rev('olderArm', { supersedes: 'a#r1' }));
    raw.writePositionRevision(rev('a', { conviction: { level: 'medium', source: 'stated' } })); // a#r2 (latest)
    raw.writePositionRevision(rev('root', { supersedes: 'a#r2' }));

    const t = tracePosition(store, 'root');
    const ancestor = t.supersedes;
    assert.equal(ancestor.slug, 'a');
    assert.equal(ancestor.rev, 2, 'pinned to r2, which is also the latest');
    assert.deepEqual(ancestor.supersededBy.map((s) => s.slug), ['root'],
      'a#r2 is superseded by root only — not by olderArm, which superseded a#r1');
  });

  test('a pinned ancestor takes its status from the revision, not the latest tombstone', () => {
    // Review r3 P3: `head` was pinned to the referenced revision but status came
    // from the slug-keyed latest index. Trace `b -> a#r1` after an `a#r2`
    // tombstone showed live r1 content stamped `retracted`. The pinned node must
    // report a#r1's own status.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('a', { conviction: { level: 'low', source: 'stated' } }));
    raw.writePositionRevision(rev('b', { supersedes: 'a#r1' }));
    raw.writePositionRevision(rev('a', { retracted: true, claims: [] })); // a#r2 tombstone

    const t = tracePosition(store, 'b');
    const ancestor = t.supersedes;
    assert.equal(ancestor.slug, 'a');
    assert.equal(ancestor.rev, 1, 'pinned to r1');
    assert.notEqual(ancestor.status, 'retracted', 'r1 was live when b was decided');
    assert.equal(ancestor.status, 'superseded', 'a#r1 was superseded by a#r2');
    assert.equal(ancestor.revisions.length, 1, 'the r2 tombstone postdates the reference');
    assert.equal(ancestor.revisions[0].conviction, 'low');
  });

  test('a retracted position still traces', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('doomed'));
    raw.writePositionRevision(rev('doomed', { retracted: true, claims: [] }));

    const t = tracePosition(store, 'doomed');
    assert.equal(t.status, 'retracted');
    assert.equal(t.revisions.length, 2);
  });

  test('ancestry is pinned to the referenced revision, not the target latest', () => {
    // Review r1 P1: `b supersedes a#r1` must show `a` AS OF r1. Following a's
    // latest would report state that did not exist when b was decided — the
    // exact question this feature answers.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('a', { conviction: { level: 'low', source: 'stated' } }));
    raw.writePositionRevision(rev('b', { supersedes: 'a#r1' }));
    // `a` moves on AFTER b superseded it.
    raw.writePositionRevision(rev('a', { conviction: { level: 'high', source: 'stated' } }));

    const t = tracePosition(store, 'b');
    assert.equal(t.supersedes.slug, 'a');
    assert.equal(t.supersedes.rev, 1, 'must pin to r1');
    assert.equal(t.supersedes.revisions.length, 1, 'r2 postdates the decision');
    assert.equal(t.supersedes.revisions[0].conviction, 'low');
  });

  test('a dangling revision number warns instead of silently using latest', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('real'));
    raw.writePositionRevision(rev('ref', { supersedes: 'real#r99' }));

    const t = tracePosition(store, 'ref');
    assert.ok(t.warnings.some((w) => w.includes('r99')), 'expected a warning naming r99');
    assert.equal(t.supersedes.slug, 'real');
  });

  test('grounding-only amendments are visible in the delta', () => {
    // Review r1 P2: judgment_position_amend is RESTRICTED to grounding and
    // conviction, so a summary without grounding hides the commonest change.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('g'));
    raw.writePositionRevision(rev('g', {
      claims: [{ id: 'c1', text: 'claim for g', grounding: 'EXT', supports: [] }],
    }));

    const t = tracePosition(store, 'g');
    assert.equal(t.revisions[0].claims[0].grounding, 'INT');
    assert.equal(t.revisions[1].claims[0].grounding, 'EXT');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('grounding') && d.includes('EXT')),
      `delta should name the grounding change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('a genuine (slug, rev) cycle terminates and is reported', () => {
    // `supersedes` is a free-form string ref and may dangle at write time, so
    // a true cycle is constructible: a#r1 -> b#r1 -> a#r1. Ancestry is a DAG
    // over (slug, rev), so THIS is the cycle — revisiting a slug at a different
    // revision is legitimate history, not a loop.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('a', { supersedes: 'b#r1' })); // dangles on write
    raw.writePositionRevision(rev('b', { supersedes: 'a#r1' }));

    const t = tracePosition(store, 'a');
    assert.ok(t.cycle, 'expected cycle to be reported');
    assert.ok(t.cycle.includes('a#r1'), `cycle should name the repeated revision, got ${t.cycle}`);
  });

  test('revisiting a slug at a DIFFERENT revision is not a cycle', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('a'));                          // a#r1
    raw.writePositionRevision(rev('b', { supersedes: 'a#r1' }));  // b#r1 -> a#r1
    raw.writePositionRevision(rev('a', { supersedes: 'b#r1' }));  // a#r2 -> b#r1

    const t = tracePosition(store, 'a'); // a@r2 -> b@r1 -> a@r1, terminates
    assert.equal(t.cycle, null, 'distinct revisions are legitimate ancestry');
    assert.equal(t.supersedes.slug, 'b');
    assert.equal(t.supersedes.supersedes.slug, 'a');
    assert.equal(t.supersedes.supersedes.rev, 1);
  });

  test('a dangling supersedes ref is reported, not thrown', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('orphan', { supersedes: 'never-existed#r1' }));

    const t = tracePosition(store, 'orphan');
    assert.equal(t.supersedes, null);
    assert.ok(t.warnings.some((w) => w.includes('never-existed')));
  });

  test('unknown slug raises a typed not-found', () => {
    const { store } = freshStore();
    assert.throws(() => tracePosition(store, 'nope'), (err) => {
      assert.equal(err.code, 'JUDGMENT_NOT_FOUND');
      return true;
    });
  });
});

describe('delta covers every writer-legal amendment', () => {
  test('a conviction SOURCE change is not silently "no change"', () => {
    // Review r2 P1: comparing only conviction.level rendered this as delta: [],
    // which the CLI suppresses entirely.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('s', { conviction: { level: 'high', source: 'stated' } }));
    raw.writePositionRevision(rev('s', { conviction: { level: 'high', source: 'inferred' } }));

    const t = tracePosition(store, 's');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('source') && d.includes('inferred')),
      `expected a source change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('an elicitation change on an ASSERT claim is not silently "no change"', () => {
    const { raw, store } = freshStore();
    const withElicitation = (answer) => ({
      claims: [{
        id: 'c1', text: 'owner asserted X', grounding: 'ASSERT', supports: [],
        elicitation: { asked: 'why?', answered_at: '2026-08-08T00:00:00Z', answer_ref: answer },
      }],
    });
    raw.writePositionRevision(rev('e', withElicitation('ref-1')));
    raw.writePositionRevision(rev('e', withElicitation('ref-2')));

    const t = tracePosition(store, 'e');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('elicitation')),
      `expected an elicitation change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('a claim `supports` change is visible in the delta and NOT dropped from the view', () => {
    // Review r3 P1: `supports` was dropped from the returned claim view entirely,
    // and never diffed. It is a writer-legal field (contracts claim.supports).
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('sup', { claims: [{ id: 'c1', text: 't', grounding: 'INT', supports: [] }] }));
    raw.writePositionRevision(rev('sup', { claims: [{ id: 'c1', text: 't', grounding: 'INT', supports: ['x1'] }] }));

    const t = tracePosition(store, 'sup');
    assert.deepEqual(t.revisions[1].claims[0].supports, ['x1'], 'supports must survive the view');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('supports')),
      `expected a supports change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('an owner_locked change is visible in the delta', () => {
    // owner_locked is refused through the write tools but is schema-representable
    // for import fidelity, so history can legally contain it. Write via the raw
    // store to exercise that path.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('ol', { claims: [{ id: 'c1', text: 't', grounding: 'INT', supports: [] }] }));
    raw.writePositionRevision(rev('ol', { claims: [{ id: 'c1', text: 't', grounding: 'INT', supports: [], owner_locked: true }] }));

    const t = tracePosition(store, 'ol');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('owner_locked')),
      `expected an owner_locked change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('a rejected_alternatives change is visible in the delta', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('ra'));
    raw.writePositionRevision(rev('ra', { rejected_alternatives: [{ what: 'a queue', why: 'too slow' }] }));

    const t = tracePosition(store, 'ra');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('rejected_alternatives')),
      `expected a rejected_alternatives change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('an omitted rejected_alternatives vs an explicit [] is NOT a spurious change', () => {
    // rejected_alternatives defaults to [] in the contract, so these two are the
    // same state and must not produce a delta entry.
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('nra')); // omits rejected_alternatives
    raw.writePositionRevision(rev('nra', { rejected_alternatives: [], conviction: { level: 'medium', source: 'stated' } }));

    const t = tracePosition(store, 'nra');
    assert.ok(
      !t.revisions[1].delta.some((d) => d.includes('rejected_alternatives')),
      `[] == omitted must not be a change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
    // ...but a real conviction change on the same revision still registers.
    assert.ok(t.revisions[1].delta.some((d) => d.includes('conviction')));
  });

  test('a provider_ids change is visible in the delta', () => {
    const { raw, store } = freshStore();
    raw.writePositionRevision(rev('pi'));
    raw.writePositionRevision(rev('pi', { provider_ids: { smartmemory: 'sm-42' } }));

    const t = tracePosition(store, 'pi');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('provider_ids')),
      `expected a provider_ids change, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('removing one of two duplicate-id claims is NOT silently "no change"', () => {
    // Review r4 P2: claim ids are not schema-unique, so an id-keyed diff collapses
    // duplicates. `[c1, c1] -> [c1]` must register a removal, not delta: [].
    const { raw, store } = freshStore();
    const c1 = { id: 'c1', text: 't', grounding: 'INT', supports: [] };
    raw.writePositionRevision(rev('dup', { claims: [{ ...c1 }, { ...c1 }] }));
    raw.writePositionRevision(rev('dup', { claims: [{ ...c1 }] }));

    const t = tracePosition(store, 'dup');
    assert.ok(
      t.revisions[1].delta.some((d) => d.includes('c1') && d.includes('removed')),
      `expected a claim removal, got ${JSON.stringify(t.revisions[1].delta)}`,
    );
  });

  test('the delta covers exactly the schema-legal fields — locked to the contract', () => {
    // Review r3 P1's root cause: the delta hand-picked a subset of fields, so new
    // ones were silently ignored. Lock the covered-field lists to the contract so
    // a schema addition FAILS here until it is diffed in summarizeRevision.
    const schema = JSON.parse(readFileSync(
      join(REPO_ROOT, 'contracts', 'judgment-record.schema.json'), 'utf-8',
    ));
    const revProps = Object.keys(schema.definitions.position_revision.properties);
    const claimProps = Object.keys(schema.definitions.claim.properties);

    // Identity/derived fields legitimately excluded from a "what changed" delta.
    const REV_EXCLUDED = ['slug', 'rev', 'provenance'];
    const CLAIM_EXCLUDED = ['id'];

    assert.deepEqual(
      [...REVISION_DELTA_FIELDS].sort(),
      revProps.filter((p) => !REV_EXCLUDED.includes(p)).sort(),
      'REVISION_DELTA_FIELDS drifted from contract position_revision — diff the new field',
    );
    assert.deepEqual(
      [...CLAIM_DELTA_FIELDS].sort(),
      claimProps.filter((p) => !CLAIM_EXCLUDED.includes(p)).sort(),
      'CLAIM_DELTA_FIELDS drifted from contract claim — diff the new field',
    );
  });
});

describe('CLI render — compose judgment trace <slug>', () => {
  test('renders the chain, the delta, and reverse refs through the real binary', () => {
    // Review r3 P2: no test executed the bin/compose.js render branch, so the
    // scalar->array supersededBy change could have crashed it unnoticed. Drive
    // the actual binary against a scratch workspace.
    const { cwd, raw } = freshStore();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(join(cwd, '.compose', 'compose.json'), '{"version":1}');

    raw.writePositionRevision(rev('old', { conviction: { level: 'low', source: 'stated' } }));
    raw.writePositionRevision(rev('newer', { supersedes: 'old#r1' }));

    const out = execFileSync('node', [join(REPO_ROOT, 'bin', 'compose.js'), 'judgment', 'trace', 'old'], {
      cwd, encoding: 'utf-8',
    });

    assert.match(out, /old\s+\[superseded\]/, 'renders slug + status');
    assert.match(out, /superseded by:\s+newer#r1/, 'renders the array reverse ref');
    assert.match(out, /r1\b/, 'renders the revision line');
  });
});

describe('golden flow — create -> amend -> supersede -> public trace', () => {
  test('the whole history is legible, through the real writer API', async () => {
    // Review r2 P2: the first version of this test wrote every revision through
    // RecordsStore directly, so despite its name it exercised neither
    // judgment_position_create nor judgment_position_amend. It now drives the
    // actual writers, so a break in the create/amend path fails here.
    const { cwd } = freshStore();
    const {
      judgmentPositionCreate, judgmentPositionAmend, getJudgmentTrace,
    } = await import('../lib/judgment-writer.js');

    await judgmentPositionCreate(cwd, {
      slug: 'arch',
      claims: [{ id: 'c1', text: 'use a queue', grounding: 'INT' }],
      conviction: { level: 'low', source: 'stated' },
    });

    // Amend is RESTRICTED to grounding + conviction — the commonest change, and
    // the one an under-specified summary hides.
    await judgmentPositionAmend(cwd, {
      slug: 'arch', claim_id: 'c1', grounding: 'EXT',
      conviction: { level: 'high', source: 'stated' },
    });

    await judgmentPositionCreate(cwd, {
      slug: 'arch-v2',
      claims: [{ id: 'c1', text: 'use a log', grounding: 'EXT' }],
      conviction: { level: 'high', source: 'stated' },
      supersedes: 'arch#r2',
    });

    const t = await getJudgmentTrace(cwd, 'arch-v2');

    assert.equal(t.slug, 'arch-v2');
    assert.equal(t.status, 'live');
    assert.equal(t.depth, 2);

    const ancestor = t.supersedes;
    assert.equal(ancestor.slug, 'arch');
    assert.equal(ancestor.status, 'superseded');
    assert.equal(ancestor.rev, 2, 'pinned to the superseded revision');
    assert.equal(ancestor.revisions.length, 2, 'both pre-supersession revisions visible');

    // What we believed BEFORE the amendment is still readable.
    assert.equal(ancestor.revisions[0].conviction, 'low');
    assert.equal(ancestor.revisions[0].claims[0].grounding, 'INT');
    // ...and what changed is named.
    assert.ok(ancestor.revisions[1].delta.some((d) => d.includes('conviction low -> high')),
      `expected conviction delta, got ${JSON.stringify(ancestor.revisions[1].delta)}`);
    assert.ok(ancestor.revisions[1].delta.some((d) => d.includes('grounding INT -> EXT')),
      `expected grounding delta, got ${JSON.stringify(ancestor.revisions[1].delta)}`);

    assert.equal(t.cycle, null);
    assert.deepEqual(t.warnings, []);
  });
});
