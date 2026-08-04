/**
 * test/fluid-provider.test.js — the fluid-store provider seam (COMP-PLAN-IDEA-UNIFY S1).
 *
 * Real backends throughout: every test drives a real VisionStore over a real
 * temp data directory. The vision store is the substrate under test, so mocking
 * it would test nothing.
 *
 * The load-bearing assertion in this file is "capability absence throws" — see
 * the semantic-capability suite. Everything else protects a record from losing
 * information as it crosses the seam.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAP,
  FluidCapabilityUnavailable,
  FluidConfigError,
  FluidKindUnsupported,
  FluidRecordNotFound,
  SEMANTIC_CAP,
  STORAGE_CAP,
  isSemanticCapability,
} from '../lib/fluid/provider.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { fluidProviderFor } from '../lib/fluid/factory.js';

let root;
let dataDir;

function nowIsoForTest() { return new Date().toISOString(); }

function newRoot() {
  const r = mkdtempSync(join(tmpdir(), 'fluid-seam-'));
  mkdirSync(join(r, '.compose', 'data'), { recursive: true });
  return r;
}

async function newProvider(cwd = root) {
  return new LocalFluidProvider().init(cwd, { dataDir: join(cwd, '.compose', 'data') });
}

/** A provider on the SAME data dir but with a cold store — proves a fact is
 *  persisted rather than held in the first instance's memory. */
async function reopen(cwd = root) {
  return new LocalFluidProvider().init(cwd, { dataDir: join(cwd, '.compose', 'data') });
}

beforeEach(() => {
  root = newRoot();
  dataDir = join(root, '.compose', 'data');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Capability discovery — the reason the seam exists
// ---------------------------------------------------------------------------

describe('fluid seam — capability discovery', () => {
  it('the floor declares storage capabilities and NO semantic ones', async () => {
    const p = await newProvider();
    const caps = p.capabilities();

    assert.ok(caps.has(STORAGE_CAP.RECORDS));
    assert.ok(caps.has(STORAGE_CAP.EVENTS));
    assert.ok(caps.has(STORAGE_CAP.LINKS));

    for (const semantic of Object.values(SEMANTIC_CAP)) {
      assert.equal(
        caps.has(semantic), false,
        `floor must not declare semantic capability ${semantic}`
      );
    }
  });

  it('has() reports absence so a surface can offer a funnel instead of an empty state', async () => {
    const p = await newProvider();
    assert.equal(p.has(CAP.RECORDS), true);
    assert.equal(p.has(CAP.CHALLENGE), false);
  });
});

describe('fluid seam — a missing semantic capability THROWS, never returns empty', () => {
  // This is the single most important behavior in the slice. An empty result is
  // indistinguishable from a genuine "nothing matched", so returning one would
  // silently convert a capability the provider does not have into a wrong
  // answer the caller cannot detect. PROVIDER-SEAM: nothing fakes it.

  const SEMANTIC_CALLS = [
    ['recall', (p) => p.recall('anything')],
    ['challenge', (p) => p.challenge('IDEA-1')],
    ['conviction', (p) => p.conviction('IDEA-1')],
    ['calibration', (p) => p.calibration({})],
    ['contradictions', (p) => p.contradictions('IDEA-1')],
  ];

  for (const [method, invoke] of SEMANTIC_CALLS) {
    it(`${method}() rejects with FluidCapabilityUnavailable on the floor`, async () => {
      const p = await newProvider();
      await assert.rejects(
        () => invoke(p),
        (err) => {
          assert.ok(
            err instanceof FluidCapabilityUnavailable,
            `${method} threw ${err.name}, expected FluidCapabilityUnavailable`
          );
          // The error must name BOTH, so the surface can say which capability
          // is missing and which provider would need to change.
          assert.ok(isSemanticCapability(err.capability));
          assert.equal(err.provider, 'local');
          return true;
        }
      );
    });
  }

  it('refuses even when the store holds matching data — absence is about the provider, not the data', async () => {
    const p = await newProvider();
    await p.createRecord({ kind: 'idea', title: 'a recallable thought' });
    await assert.rejects(
      () => p.recall('recallable'),
      FluidCapabilityUnavailable
    );
  });
});

// ---------------------------------------------------------------------------
// Record round-trip fidelity
// ---------------------------------------------------------------------------

describe('fluid seam — record round-trip', () => {
  it('preserves every field across a write and a cold reopen', async () => {
    const p = await newProvider();
    const created = await p.createRecord({
      kind: 'idea',
      title: 'Bound the retry loop',
      body: 'Retries currently compound; cap them and surface the cap.',
      status: 'discussing',
      priority: 'P1',
      cluster: 'Umbrella A — Resilience: fail loud, recover fast',
      cluster_order: 0,
      tags: ['core', 'infra'],
      source: 'postmortem 2026-07-19',
      provenance: { origin: 'cli:ideabox', author: 'ruze' },
    });

    const cold = await reopen();
    const read = await cold.getRecord(created.handle);

    assert.equal(read.title, 'Bound the retry loop');
    assert.equal(read.body, 'Retries currently compound; cap them and surface the cap.');
    assert.equal(read.status, 'discussing');
    assert.equal(read.priority, 'P1');
    assert.equal(read.source, 'postmortem 2026-07-19');
    assert.deepEqual(read.tags, ['core', 'infra']);
    assert.equal(read.provenance.origin, 'cli:ideabox');
    assert.equal(read.provenance.author, 'ruze');
    assert.equal(read.id, created.id);
  });

  it('preserves the hand-authored cluster heading and its ordering', async () => {
    // Cluster is record data, not presentation. If the store could not return
    // the umbrella heading verbatim, regenerating ideabox.md would clobber
    // hand-authored editorial structure — the failure `roadmap generate` has.
    const p = await newProvider();
    const heading = 'Umbrella C — Mechanical verification & decision provenance';

    await p.createRecord({ kind: 'idea', title: 'second', cluster: heading, cluster_order: 2 });
    await p.createRecord({ kind: 'idea', title: 'first', cluster: 'Umbrella A — Resilience', cluster_order: 0 });

    const cold = await reopen();
    const records = await cold.listRecords({ kind: 'idea' });

    assert.equal(records[0].title, 'first');
    assert.equal(records[1].title, 'second');
    assert.equal(records[1].cluster, heading, 'cluster heading must survive verbatim');
    assert.equal(records[1].cluster_order, 2);
  });

  it('keeps created_at equal to updated_at on a freshly created record', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'fresh' });
    assert.equal(r.created_at, r.updated_at);
  });

  it('updates content, leaving the handle and kind alone', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'original' });

    const updated = await p.updateRecord(r.handle, { title: 'revised', status: 'promoted' });

    assert.equal(updated.title, 'revised');
    assert.equal(updated.status, 'promoted');
    assert.equal(updated.handle, r.handle);
    assert.equal(updated.kind, 'idea');
  });

  it('reports a missing record distinctly from an empty store', async () => {
    const p = await newProvider();
    assert.equal(await p.getRecord('IDEA-404'), null);
    await assert.rejects(() => p.updateRecord('IDEA-404', { title: 'x' }), FluidRecordNotFound);
  });

  it('refuses a kind the provider does not host, rather than coercing it', async () => {
    const p = await newProvider();
    await assert.rejects(
      () => p.createRecord({ kind: 'position', title: 'a position' }),
      (err) => {
        assert.ok(err instanceof FluidKindUnsupported);
        assert.equal(err.kind, 'position');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Handle allocation
// ---------------------------------------------------------------------------

describe('fluid seam — handles', () => {
  it('allocates monotonically', async () => {
    const p = await newProvider();
    const a = await p.createRecord({ kind: 'idea', title: 'a' });
    const b = await p.createRecord({ kind: 'idea', title: 'b' });
    assert.equal(a.handle, 'IDEA-1');
    assert.equal(b.handle, 'IDEA-2');
  });

  it('never reissues the handle of a deleted record', async () => {
    // Handles are quoted in docs, commits and conversation (IDEA-20 is cited in
    // the substrate ruling). Reusing one silently repoints an external citation
    // at a different idea, which no later fix can detect.
    const p = await newProvider();
    await p.createRecord({ kind: 'idea', title: 'a' });
    const doomed = await p.createRecord({ kind: 'idea', title: 'b' });
    assert.equal(doomed.handle, 'IDEA-2');

    await p.deleteRecord(doomed.handle);

    const cold = await reopen();
    const next = await cold.createRecord({ kind: 'idea', title: 'c' });
    assert.equal(next.handle, 'IDEA-3', 'IDEA-2 was retired and must never come back');
  });

  it('accepts a caller-supplied handle so the one-time import can keep IDEA-N citations', async () => {
    const p = await newProvider();
    const imported = await p.createRecord({
      kind: 'idea',
      title: 'migrated from markdown',
      handle: 'IDEA-20',
      provenance: { origin: 'import:ideabox' },
    });
    assert.equal(imported.handle, 'IDEA-20');

    // And allocation continues past it rather than colliding.
    const next = await p.createRecord({ kind: 'idea', title: 'after import' });
    assert.equal(next.handle, 'IDEA-21');
  });

  it('rejects a duplicate handle', async () => {
    const p = await newProvider();
    await p.createRecord({ kind: 'idea', title: 'a', handle: 'IDEA-5' });
    await assert.rejects(() => p.createRecord({ kind: 'idea', title: 'b', handle: 'IDEA-5' }));
  });

  it('refuses a caller-supplied handle that was retired, not just one that is live', async () => {
    // The automatic allocator skips retired handles, but the import path can ask
    // for one BY NAME. Checking only live records would let it resurrect a
    // citation onto a different record — the exact outcome tombstones prevent.
    const p = await newProvider();
    const doomed = await p.createRecord({ kind: 'idea', title: 'a' });
    await p.deleteRecord(doomed.handle);

    await assert.rejects(
      () => p.createRecord({ kind: 'idea', title: 'impostor', handle: doomed.handle }),
      /already been issued/
    );
  });

  it('checks issued handles by membership, so the import may fill gaps in any order', async () => {
    // A watermark comparison would reject IDEA-3 once IDEA-20 existed, which
    // would break importing an existing ideabox in arbitrary order.
    const p = await newProvider();
    await p.createRecord({ kind: 'idea', title: 'twenty', handle: 'IDEA-20', provenance: { origin: 'import:ideabox' } });
    const gap = await p.createRecord({ kind: 'idea', title: 'three', handle: 'IDEA-3', provenance: { origin: 'import:ideabox' } });
    assert.equal(gap.handle, 'IDEA-3');
  });

  it('keeps a handle retired when ITS OWN tombstone line is corrupt', async () => {
    // The tombstone for the retired handle is itself truncated — appending an
    // unrelated malformed line would leave the valid tombstone in place and the
    // old JSON.parse-based implementation would still pass.
    const p = await newProvider();
    const doomed = await p.createRecord({ kind: 'idea', title: 'a' });
    await p.deleteRecord(doomed.handle);

    const logPath = join(dataDir, 'fluid-events.jsonl');
    const damaged = readFileSync(logPath, 'utf8')
      .split('\n')
      .map((line) => (line.includes(`"${doomed.handle}"`) ? line.slice(0, -3) : line))
      .join('\n');
    writeFileSync(logPath, damaged, 'utf8');

    // Every surviving mention of the handle is now on unparseable lines.
    assert.equal((await p.readEvents(doomed.handle)).length, 0, 'tombstone must be unparseable for this test to mean anything');

    const next = await p.createRecord({ kind: 'idea', title: 'b' });
    assert.notEqual(next.handle, doomed.handle);
    await assert.rejects(
      () => p.createRecord({ kind: 'idea', title: 'c', handle: doomed.handle }),
      /already been issued/
    );
  });

  it('rejects a handle whose suffix exceeds the digit bound', async () => {
    // Past the exact-integer range max+1 === max, so an unbounded imported
    // handle would make the allocator reissue it forever.
    const p = await newProvider();
    await assert.rejects(
      () => p.createRecord({ kind: 'idea', title: 'a', handle: 'IDEA-9007199254740992' }),
      /malformed handle/
    );
  });

  it('keeps the handle burned when the record write fails after the tombstone', async () => {
    // The tombstone is written first precisely so a later failure wastes a
    // handle instead of freeing one.
    const p = await newProvider();
    const boom = new Error('disk gone');
    const original = p.store.createItem.bind(p.store);
    p.store.createItem = () => { throw boom; };

    await assert.rejects(() => p.createRecord({ kind: 'idea', title: 'doomed' }), /disk gone/);
    p.store.createItem = original;

    const next = await p.createRecord({ kind: 'idea', title: 'after' });
    assert.equal(next.handle, 'IDEA-2', 'IDEA-1 was burned by the tombstone and must not be reused');
  });

  it('rejects a malformed handle and one belonging to another kind', async () => {
    const p = await newProvider();
    await assert.rejects(() => p.createRecord({ kind: 'idea', title: 'a', handle: 'DEC-0' }), /malformed handle/);
    await assert.rejects(() => p.createRecord({ kind: 'idea', title: 'b', handle: 'DEC-4' }), /does not belong to kind/);
  });
});

describe('fluid seam — append-only evidence', () => {
  it('refuses to patch discussion through updateRecord', async () => {
    // Silently dropping the field would look to the caller exactly like a
    // successful erase, and looking successful is the dangerous half.
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'a' });
    await p.appendDiscussion(r.handle, { text: 'the reason we hesitated' });

    await assert.rejects(() => p.updateRecord(r.handle, { discussion: [] }), /cannot be changed/);
    await assert.rejects(() => p.updateRecord(r.handle, { discussion: null }), /cannot be changed/);

    const after = await p.getRecord(r.handle);
    assert.equal(after.discussion.length, 1);
    assert.equal(after.discussion[0].text, 'the reason we hesitated');
  });

  it('refuses to patch identity and provenance', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'a' });
    for (const field of ['handle', 'kind', 'provenance', 'id', 'created_at']) {
      await assert.rejects(() => p.updateRecord(r.handle, { [field]: 'x' }), /cannot be changed/);
    }
  });

  it('appends discussion and records it as a lifecycle fact', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'a' });
    const one = await p.appendDiscussion(r.handle, { text: 'first' });
    const two = await p.appendDiscussion(r.handle, { text: 'second' });

    assert.equal(one.discussion.length, 1);
    assert.deepEqual(two.discussion.map((d) => d.text), ['first', 'second']);
    assert.equal((await p.readEvents(r.handle)).at(-1).type, 'discussed');
  });

  it('validates before persisting, so a rejected update leaves no trace', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'original' });
    const eventsBefore = (await p.readEvents(r.handle)).length;

    await assert.rejects(() => p.updateRecord(r.handle, { title: 'changed', status: 'nonsense' }));

    const after = await p.getRecord(r.handle);
    assert.equal(after.title, 'original', 'a rejected update must not have partially applied');
    assert.equal((await p.readEvents(r.handle)).length, eventsBefore);
  });

  it('does not hand out references into its own state', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'a', killed: { at: nowIsoForTest(), reason: 'original' } });

    const read = await p.getRecord(r.handle);
    read.killed.reason = 'mutated with no write';
    read.links.push({ type: 'maps_to', target: 'SNUCK-IN' });

    const fresh = await p.getRecord(r.handle);
    assert.equal(fresh.killed.reason, 'original');
    assert.equal(fresh.links.length, 0);
  });
});

describe('fluid seam — stale snapshots between instances', () => {
  // NAMED FOR WHAT IT PROVES. These writes are sequential and awaited, so this
  // exercises the stale-snapshot hazard (an instance holding state loaded before
  // the other's write), NOT a genuine interleaving race. Interleaved writers
  // need a lock and are an S3 concern — see the accepted limits in the slice
  // ledger. A test named "concurrent" here would have implied a guarantee the
  // floor does not make.
  it('does not let one instance erase a record another wrote before it', async () => {
    const a = await newProvider();
    const b = await newProvider();

    const fromB = await b.createRecord({ kind: 'idea', title: 'written by B' });
    const fromA = await a.createRecord({ kind: 'idea', title: 'written by A' });

    const handles = (await a.listRecords({ kind: 'idea' })).map((r) => r.handle);
    assert.ok(handles.includes(fromB.handle), 'B\'s record survived A\'s write');
    assert.ok(handles.includes(fromA.handle));
    assert.notEqual(fromA.handle, fromB.handle, 'handles must not collide across instances');
  });
});

describe('fluid seam — contract enforcement', () => {
  it('rejects a record the published schema forbids', async () => {
    // Hand-rolled field checks drift from the contract silently. These two both
    // passed while the seam claimed to "validate the whole shape".
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'valid' });

    await assert.rejects(() => p.updateRecord(r.handle, { title: '' }), /invalid record/);
    await assert.rejects(() => p.updateRecord(r.handle, { priority: 'P9' }), /invalid record/);

    const unchanged = await p.getRecord(r.handle);
    assert.equal(unchanged.title, 'valid');
    assert.equal(unchanged.priority, null);
  });

  it('rejects a malformed lifecycle event before it lands in the append-only log', async () => {
    const p = await newProvider();
    await assert.rejects(() => p.appendEvent({ handle: 'IDEA-1', type: 'invented' }), /invalid lifecycle event/);
    await assert.rejects(() => p.appendEvent({ type: 'created' }), /invalid lifecycle event/);
  });

  it('rolls back the native fields when the namespace write fails', async () => {
    // The update spans two saves. Restoring only the namespace would leave a
    // record whose title and rendered status had moved while its canonical
    // state had not.
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'original', priority: 'P2' });

    const originalSetExt = p.store.setFluidExt.bind(p.store);
    p.store.setFluidExt = () => { throw new Error('namespace write failed'); };
    await assert.rejects(
      () => p.updateRecord(r.handle, { title: 'changed', status: 'promoted' }),
      /namespace write failed/
    );
    p.store.setFluidExt = originalSetExt;

    const after = await p.getRecord(r.handle);
    assert.equal(after.title, 'original', 'native fields must not stay committed');
    assert.equal(after.status, 'new');
  });
});

describe('fluid seam — deletion', () => {
  it('carries discussion evidence into the append-only log before destroying the record', async () => {
    // deleteRecord is a hard admin delete, not the lifecycle path. Since it can
    // erase evidence the contract calls append-only, the evidence survives in
    // the log — otherwise "append-only" holds on every path except the one that
    // actually erases it.
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'considered' });
    await p.appendDiscussion(r.handle, { text: 'why we hesitated' });

    await p.deleteRecord(r.handle);

    const deleted = (await p.readEvents(r.handle)).find((e) => e.type === 'deleted');
    assert.ok(deleted, 'deletion is a lifecycle fact');
    assert.equal(deleted.detail.discussion[0].text, 'why we hesitated');
    assert.equal(deleted.detail.title, 'considered');
  });

  it('does not report success when the deletion fails to persist', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'a' });

    const originalSave = p.store._save.bind(p.store);
    p.store._save = () => false;
    await assert.rejects(() => p.deleteRecord(r.handle), /failed to persist deletion/);
    p.store._save = originalSave;

    // Still there, as the failure implied.
    assert.ok(await p.getRecord(r.handle));
  });
});

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

describe('fluid seam — lifecycle events', () => {
  it('records creation and distinguishes an import from a native capture', async () => {
    const p = await newProvider();
    const native = await p.createRecord({ kind: 'idea', title: 'typed in' });
    const migrated = await p.createRecord({
      kind: 'idea', title: 'from markdown', provenance: { origin: 'import:ideabox' },
    });

    const nativeEvents = await p.readEvents(native.handle);
    const migratedEvents = await p.readEvents(migrated.handle);

    assert.equal(nativeEvents[0].type, 'created');
    assert.equal(migratedEvents[0].type, 'imported');
  });

  it('names the lifecycle fact an update represents, not just "updated"', async () => {
    // Promotion and kill are the events later rungs (conviction, calibration)
    // score against, so an update that changes state must be recorded as that
    // state change even when it also edits other fields.
    const p = await newProvider();
    const promoted = await p.createRecord({ kind: 'idea', title: 'a' });
    await p.updateRecord(promoted.handle, { status: 'promoted', title: 'a, renamed' });
    assert.equal((await p.readEvents(promoted.handle)).at(-1).type, 'promoted');

    const killed = await p.createRecord({ kind: 'idea', title: 'b' });
    await p.updateRecord(killed.handle, { status: 'killed', killed: { at: nowIsoForTest(), reason: 'wrong layer' } });
    assert.equal((await p.readEvents(killed.handle)).at(-1).type, 'killed');

    const triaged = await p.createRecord({ kind: 'idea', title: 'c' });
    await p.updateRecord(triaged.handle, { priority: 'P0' });
    assert.equal((await p.readEvents(triaged.handle)).at(-1).type, 'triaged');
  });

  it('rejects an invalid status at the seam with a fluid-level error', async () => {
    const p = await newProvider();
    await assert.rejects(
      () => p.createRecord({ kind: 'idea', title: 'x', status: 'sorta-maybe' }),
      /invalid status "sorta-maybe"/
    );
  });

  it('survives a corrupt line in the log rather than failing the read', async () => {
    const p = await newProvider();
    await p.createRecord({ kind: 'idea', title: 'a' });
    writeFileSync(
      join(dataDir, 'fluid-events.jsonl'),
      readFileSync(join(dataDir, 'fluid-events.jsonl'), 'utf8') + '{not json\n',
      'utf8'
    );
    const events = await p.readEvents();
    assert.equal(events.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('fluid seam — links', () => {
  it('records promotion as an edge rather than mutating the record away', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'worth building' });
    const linked = await p.addLink(r.handle, { type: 'promoted_to', target: 'COMP-FOO-1' });

    assert.deepEqual(linked.links, [{ type: 'promoted_to', target: 'COMP-FOO-1' }]);
    // The idea still exists as an idea — provenance, not a jump.
    assert.equal(linked.kind, 'idea');
  });

  it('is idempotent on repeated identical links', async () => {
    const p = await newProvider();
    const r = await p.createRecord({ kind: 'idea', title: 'x' });
    await p.addLink(r.handle, { type: 'maps_to', target: 'COMP-BAR-2' });
    const twice = await p.addLink(r.handle, { type: 'maps_to', target: 'COMP-BAR-2' });
    assert.equal(twice.links.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('fluid seam — factory', () => {
  it('defaults to the floor when no config file exists', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'fluid-bare-'));
    try {
      const p = await fluidProviderFor(bare, { dataDir: join(bare, 'data') });
      assert.equal(p.name(), 'local');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('defaults to the floor when the config omits the fluid key', async () => {
    writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ tracker: { provider: 'local' } }));
    const p = await fluidProviderFor(root, { dataDir });
    assert.equal(p.name(), 'local');
  });

  it('fails loud on malformed config rather than silently downgrading', async () => {
    // A silent fallback here would strip a user's configured capabilities with
    // no signal — they would see an intelligence-free system and no error.
    writeFileSync(join(root, '.compose', 'compose.json'), '{ this is not json');
    await assert.rejects(() => fluidProviderFor(root, { dataDir }), FluidConfigError);
  });

  it('fails loud on an unknown provider name', async () => {
    writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ fluid: { provider: 'nope' } }));
    await assert.rejects(() => fluidProviderFor(root, { dataDir }), FluidConfigError);
  });

  it('fails loud when smartmemory is configured but not yet implemented', async () => {
    writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ fluid: { provider: 'smartmemory' } }));
    await assert.rejects(
      () => fluidProviderFor(root, { dataDir }),
      (err) => {
        assert.ok(err instanceof FluidConfigError);
        assert.match(err.message, /not yet implemented/);
        return true;
      }
    );
  });

  it('rejects a fluid key that is not an object', async () => {
    writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ fluid: ['local'] }));
    await assert.rejects(() => fluidProviderFor(root, { dataDir }), FluidConfigError);
  });
});
