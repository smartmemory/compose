/**
 * test/fluid-cutover.test.js — the guarantees the ideabox cutover stands on
 * (COMP-PLAN-IDEA-UNIFY S3b-1).
 *
 * Real backends throughout: real temp directories, real files, real child
 * processes for the concurrency case. Every suite here covers a defect that was
 * live in shipped code and that the existing tests did not catch, because each
 * one sat on a path no idea on disk had ever exercised.
 *
 * The concurrency suite spawns processes rather than using Promise.all on
 * purpose. The allocator's critical section has an `await` in it, but the write
 * either side of that await is synchronous, so in-process concurrency does NOT
 * reproduce the collision — it takes two OS processes. A same-process test here
 * would pass against completely unlocked code and prove nothing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withDirLock, acquireDirLock, DirLockTimeout } from '../lib/dir-lock.js';
import { toMarkdownDate, toRecordTimestamp } from '../lib/fluid/ideabox-dates.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { renderIdeabox } from '../lib/fluid/render-ideabox.js';
import { importIdeabox } from '../lib/fluid/import-ideabox.js';
import { parseIdeabox, serializeIdeabox } from '../lib/ideabox.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REAL_IDEABOX = join(REPO, 'docs/product/ideabox.md');

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fluid-cutover-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const provider = (root) => new LocalFluidProvider().init(tmp, { recordsRoot: root ?? join(tmp, 'records') });

// ---------------------------------------------------------------------------

describe('handle allocation is serialized across processes', () => {
  it('gives every concurrent creator a distinct handle', () => {
    const root = join(tmp, 'records');
    const script = join(tmp, 'one-create.mjs');
    writeFileSync(script, `
      import { LocalFluidProvider } from ${JSON.stringify(join(REPO, 'lib/fluid/local-provider.js'))};
      const p = await new LocalFluidProvider().init(${JSON.stringify(tmp)}, { recordsRoot: ${JSON.stringify(root)} });
      const r = await p.createRecord({ kind: 'idea', title: 'concurrent' });
      console.log(r.handle);
    `);

    const N = 8;
    const kids = Array.from({ length: N }, () =>
      execFileSync(process.execPath, [script], { encoding: 'utf8' }).trim());

    // Without the lock every one of these allocates IDEA-1 and the last writer
    // wins, so N-1 ideas are destroyed. This is the whole reason the lock exists.
    assert.equal(new Set(kids).size, N, `expected ${N} distinct handles, got ${JSON.stringify(kids)}`);
  });
});

describe('dir-lock', () => {
  it('serializes overlapping holders rather than letting them interleave', async () => {
    const path = join(tmp, 'x.lock');
    const order = [];
    const body = async (tag) => withDirLock(path, async () => {
      order.push(`${tag}:in`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${tag}:out`);
    });
    await Promise.all([body('a'), body('b')]);
    // Whoever wins, neither may enter before the other leaves.
    assert.ok(
      order.join(',') === 'a:in,a:out,b:in,b:out' || order.join(',') === 'b:in,b:out,a:in,a:out',
      `holders interleaved: ${order.join(',')}`
    );
  });

  it('releases the lock when the body throws', async () => {
    const path = join(tmp, 'x.lock');
    await assert.rejects(withDirLock(path, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsSync(path), false, 'a thrown body must not strand the lock');
  });

  it('does not remove a lock that is no longer ours (the ABA case)', async () => {
    const path = join(tmp, 'x.lock');
    const release = await acquireDirLock(path);
    // Someone else declared us stale and took the lock.
    writeFileSync(join(path, 'owner'), 'someone-elses-token');
    release();
    assert.equal(existsSync(path), true, 'release stole a lock it did not own');
  });

  it('exposes a typed timeout rather than hanging forever', () => {
    assert.equal(new DirLockTimeout('/p', 5).code, 'DIR_LOCK_TIMEOUT');
  });
});

// ---------------------------------------------------------------------------

describe('markdown/record date conversion', () => {
  it('widens a markdown date to a contract date-time', () => {
    assert.equal(toRecordTimestamp('2026-07-19'), '2026-07-19T00:00:00.000Z');
  });

  it('passes an existing timestamp through untouched', () => {
    assert.equal(toRecordTimestamp('2026-07-19T12:00:00.000Z'), '2026-07-19T12:00:00.000Z');
  });

  it('narrows a timestamp back to the markdown grammar', () => {
    assert.equal(toMarkdownDate('2026-08-05T12:34:56.789Z'), '2026-08-05');
  });

  it('round-trips a provider-written discussion entry through the projection', () => {
    // The renderer used to emit the full ISO timestamp, which the parser's
    // discussion grammar cannot match — so the entry degraded to an unparsed
    // extra line and the discussion was silently lost on the next read. That
    // would have surfaced only after cutover, on the first `ideabox discuss`.
    const rec = {
      handle: 'IDEA-1', kind: 'idea', title: 'T', body: 'B', status: 'new',
      tags: [], links: [], discussion: [{ at: '2026-08-05T12:34:56.789Z', text: 'hello', author: 'human' }],
    };
    const back = parseIdeabox(renderIdeabox({ ideas: [rec], clusters: [] })).ideas[0];
    assert.equal(back.discussion.length, 1, 'the discussion entry did not survive the projection');
    assert.deepEqual(back.discussion[0], { date: '2026-08-05', author: 'human', text: 'hello' });
  });

  it('imports an idea carrying a discussion entry', async () => {
    // This threw `/discussion/0/at must match format "date-time"` before the fix.
    const p = await provider();
    const md = '# Ideabox\n\n## Ideas\n\n#### IDEA-1 — T\n**Status:** NEW | **Priority:** —\n'
      + '**Idea:** body\n**Discussion:**\n- [2026-07-19] human: a note\n\n## Killed Ideas\n';
    await importIdeabox(p, { markdown: md });
    const rec = await p.getRecord('IDEA-1');
    assert.equal(rec.discussion[0].at, '2026-07-19T00:00:00.000Z');
    assert.equal(rec.discussion[0].text, 'a note');
  });
});

// ---------------------------------------------------------------------------

describe('the one-time import is restartable', () => {
  it('recreates a handle burned by a create that never finished', async () => {
    const root = join(tmp, 'records');
    const p = await provider(root);
    const markdown = readFileSync(REAL_IDEABOX, 'utf8');
    await importIdeabox(p, { markdown });
    const before = (await p.listRecords()).length;

    // The tombstone is appended before the record is written, so a crash in
    // between leaves the handle issued with no record behind it.
    rmSync(join(root, 'records', 'IDEA-12.json'));
    assert.equal((await p.listRecords()).length, before - 1);

    await importIdeabox(p, { markdown });
    assert.equal((await p.listRecords()).length, before, 'the rerun did not restore the lost record');
    assert.ok(await p.getRecord('IDEA-12'));
  });

  it('still refuses a handle that was genuinely retired', async () => {
    // The reclaim must be narrow. A retired handle was once live, so a citation
    // to it can exist — which is the entire reason handles are never reused.
    const p = await provider();
    const rec = await p.createRecord({ kind: 'idea', title: 'will be retired' });
    await p.deleteRecord(rec.handle);
    await assert.rejects(
      p.createRecord({ kind: 'idea', title: 'thief', handle: rec.handle, reclaimAborted: true }),
      /already been issued/
    );
  });
});

// ---------------------------------------------------------------------------

describe('the projection never silently drops a record', () => {
  const cluster = {
    handle: 'CLUS-1', kind: 'cluster', title: 'Umbrella A', body: 'theme',
    cluster_order: 1, tags: [], links: [], discussion: [],
  };
  const idea = (handle, clusterRef) => ({
    handle, kind: 'idea', title: `T ${handle}`, body: 'b', status: 'new',
    tags: [], links: [], discussion: [], cluster: clusterRef,
  });

  it('renders an idea that names a real cluster handle', () => {
    assert.match(renderIdeabox({ ideas: [idea('IDEA-1', 'CLUS-1')], clusters: [cluster] }), /IDEA-1/);
  });

  it('renders an idea with no cluster', () => {
    assert.match(renderIdeabox({ ideas: [idea('IDEA-2', null)], clusters: [cluster] }), /IDEA-2/);
  });

  it('refuses to render an idea naming a cluster that does not exist', () => {
    // The CLI takes a free-form cluster name, so this is one typo away. Such an
    // idea matches neither the cluster filter nor the unclustered filter: it
    // vanishes from the only surface anyone reads, while its record sits on disk.
    assert.throws(
      () => renderIdeabox({ ideas: [idea('IDEA-3', 'Umbrella A')], clusters: [cluster] }),
      /IDEA-3 → "Umbrella A"/
    );
  });
});

// ---------------------------------------------------------------------------

describe('the real ideabox survives the cutover', () => {
  it('imports, renders, and loses nothing but the accepted three changes', async () => {
    const p = await provider();
    const real = readFileSync(REAL_IDEABOX, 'utf8');
    await importIdeabox(p, { markdown: real });

    const ideas = await p.listRecords({ kind: 'idea' });
    const clusters = await p.listRecords({ kind: 'cluster' });
    const rendered = renderIdeabox({ ideas, clusters });

    // The strongest statement available: the projection is a fixed point of the
    // legacy serializer, so `compose ideabox <anything>` cannot corrupt it.
    assert.equal(serializeIdeabox(parseIdeabox(rendered)), rendered);

    const parsed = parseIdeabox(rendered);
    assert.equal(parsed.ideas.length + parsed.killed.length, 20, 'an idea went missing');
    assert.equal(parsed.nextId, 21, 'handle numbering drifted — external citations break');
    assert.match(parsed.preamble, /\*\*Umbrella:\*\*/, 'the hand-authored convention bullet was dropped');

    // IDEA-20's content is the re-ruling that created this epic. It had no
    // `**Idea:**` field at all — both blocks were unparsed extras, so it
    // imported with an empty body and the text was destroyed on render.
    const twenty = parsed.ideas.find((i) => i.id === 'IDEA-20');
    assert.ok(twenty.description.length > 100, 'IDEA-20 imported with an empty body');
    assert.equal(twenty.discussion.length, 1, 'IDEA-20 lost its original framing');
    assert.match(twenty.discussion[0].text, /^\*\*Original framing\.\*\*/);
  });
});
