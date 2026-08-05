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
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withDirLock, acquireDirLock, DirLockTimeout } from '../lib/dir-lock.js';
import { ensureIdeaboxMigrated } from '../lib/fluid/ideabox-migrate.js';
import { toMarkdownDate, toRecordTimestamp } from '../lib/fluid/ideabox-dates.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { renderIdeabox, writeIdeaboxProjection } from '../lib/fluid/render-ideabox.js';
import { importIdeabox } from '../lib/fluid/import-ideabox.js';
import { fluidProviderFor } from '../lib/fluid/factory.js';
import { runIdeaboxCommand } from '../lib/ideabox-cli.js';
import { parseIdeabox, serializeIdeabox } from '../lib/ideabox.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REAL_IDEABOX = join(REPO, 'docs/product/ideabox.md');

let tmp;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fluid-cutover-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const provider = (root) => new LocalFluidProvider().init(tmp, { recordsRoot: root ?? join(tmp, 'records') });

// ---------------------------------------------------------------------------

describe('handle allocation is serialized across processes', () => {
  it('gives every concurrent creator a distinct handle', async () => {
    const root = join(tmp, 'records');
    const script = join(tmp, 'one-create.mjs');
    writeFileSync(script, `
      import { LocalFluidProvider } from ${JSON.stringify(join(REPO, 'lib/fluid/local-provider.js'))};
      const p = await new LocalFluidProvider().init(${JSON.stringify(tmp)}, { recordsRoot: ${JSON.stringify(root)} });
      const r = await p.createRecord({ kind: 'idea', title: 'concurrent' });
      console.log(r.handle);
    `);

    // MUST be launched together and awaited together. `execFileSync` inside a
    // map looks like a fan-out and is not one: each child runs to completion
    // before the next starts, so the processes never overlap and the assertion
    // below holds even with no lock at all. That version of this test passed
    // against completely unlocked code, which is worse than having no test —
    // it certifies a guarantee it never exercised.
    const N = 3;
    const kids = await Promise.all(Array.from({ length: N }, () =>
      new Promise((resolve, reject) =>
        execFile(process.execPath, [script], (err, stdout) =>
          err ? reject(err) : resolve(stdout.trim())))));

    // Three, not eight. The children are real node processes and this file runs
    // alongside the rest of the suite, so a larger fan-out starves unrelated
    // subprocess-backed tests — an 8-way version of this reliably broke
    // `lifecycle-guard-e2e` under `npm test`. Three still discriminates:
    // removing the lock fails this test and the in-process one below.
    //
    // Unlocked, all N allocate IDEA-1 and last-writer-wins destroys N-1 ideas.
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

describe('the first-use migration gate', () => {
  const IDEABOX = (n) => '# Ideabox\n\n## Ideas\n\n'
    + Array.from({ length: n }, (_, i) =>
      `#### IDEA-${i + 1} — legacy idea ${i + 1}\n**Status:** NEW | **Priority:** —\n**Idea:** body ${i + 1}\n`).join('\n')
    + '\n## Killed Ideas\n';

  const writeIdeabox = (text) => {
    const p = join(tmp, 'ideabox.md');
    writeFileSync(p, text);
    return p;
  };

  it('imports an existing markdown ideabox into an empty store', async () => {
    // THE UPGRADE PATH. Without this, an installation that upgrades with a
    // populated ideabox and no records has its ideas replaced by the first idea
    // the user adds.
    const p = await provider();
    const path = writeIdeabox(IDEABOX(5));
    const result = await ensureIdeaboxMigrated(p, path);
    assert.equal(result.migrated, true);
    assert.equal((await p.listRecords({ kind: 'idea' })).length, 5);
    // and the next handle must clear the imported ones
    const next = await p.createRecord({ kind: 'idea', title: 'new' });
    assert.equal(next.handle, 'IDEA-6');
  });

  it('does nothing when the store already matches the markdown', async () => {
    const p = await provider();
    const path = writeIdeabox(IDEABOX(3));
    await ensureIdeaboxMigrated(p, path);
    const again = await ensureIdeaboxMigrated(p, path);
    assert.equal(again.migrated, false);
    assert.equal((await p.listRecords({ kind: 'idea' })).length, 3);
  });

  it('refuses an idea hand-typed into what is now generated output', async () => {
    // Never issued by this store, so it cannot be a crashed create. Importing it
    // would treat the markdown as authoritative when it no longer is.
    const p = await provider();
    const path = writeIdeabox(IDEABOX(3));
    await ensureIdeaboxMigrated(p, path);
    writeIdeabox(IDEABOX(3).replace('## Killed Ideas',
      '#### IDEA-99 — typed in by hand\n**Status:** NEW | **Priority:** —\n**Idea:** x\n\n## Killed Ideas'));
    await assert.rejects(ensureIdeaboxMigrated(p, path), (err) => {
      assert.equal(err.code, 'IDEABOX_MIGRATION_CONFLICT');
      assert.deepEqual(err.missing, ['IDEA-99']);
      return true;
    });
  });

  it('resumes an import that crashed partway through the corpus', async () => {
    // Refusing this state strands the installation: the conflict error names
    // `compose ideabox add`, and `add` runs this same gate, so every command
    // fails with no way out. The handles the crash burned carry events and no
    // `deleted`, which is what makes resuming safe rather than a guess.
    const p = await provider();
    const path = writeIdeabox(IDEABOX(6));
    await ensureIdeaboxMigrated(p, path);
    rmSync(join(tmp, 'records/records/IDEA-2.json'));
    rmSync(join(tmp, 'records/records/IDEA-5.json'));

    const result = await ensureIdeaboxMigrated(p, path);
    assert.equal(result.migrated, true);
    assert.equal((await p.listRecords({ kind: 'idea' })).length, 6);
    assert.ok(await p.getRecord('IDEA-2'));
  });

  it('refuses a handle that was deliberately retired but still listed', async () => {
    // Distinct from a crashed create: this one carries a `deleted` event, so
    // importing would resurrect an idea someone removed on purpose. The file is
    // simply stale output and a render fixes it.
    const p = await provider();
    const path = writeIdeabox(IDEABOX(4));
    await ensureIdeaboxMigrated(p, path);
    await p.deleteRecord('IDEA-3');
    await assert.rejects(ensureIdeaboxMigrated(p, path), (err) => {
      assert.equal(err.code, 'IDEABOX_MIGRATION_CONFLICT');
      assert.deepEqual(err.missing, ['IDEA-3']);
      return true;
    });
  });

  it('is a no-op for a fresh project with no markdown at all', async () => {
    const p = await provider();
    const result = await ensureIdeaboxMigrated(p, join(tmp, 'absent.md'));
    assert.equal(result.migrated, false);
  });
});

describe('a killed idea round-trips through the projection', () => {
  it('omits the priority segment, matching the legacy serializer', async () => {
    // The legacy serializer writes `**Status:** KILLED` with no priority. The
    // projection emitted one, so serialize(parse(projection)) stopped being the
    // identity the moment anyone killed an idea — and no idea on disk was
    // killed, so nothing caught it.
    const p = await provider();
    const rec = await p.createRecord({ kind: 'idea', title: 'doomed', tags: ['x'] });
    await p.updateRecord(rec.handle, {
      status: 'killed',
      killed: { at: new Date('2026-08-05').toISOString(), reason: 'obsolete' },
    });
    const ideas = await p.listRecords({ kind: 'idea' });
    const rendered = renderIdeabox({ ideas, clusters: [] });

    assert.match(rendered, /\*\*Status:\*\* KILLED \| \*\*Tags:\*\* x/);
    assert.doesNotMatch(rendered, /KILLED \| \*\*Priority:\*\*/);
    assert.equal(serializeIdeabox(parseIdeabox(rendered)), rendered);
    assert.match(rendered, /\*\*Killed:\*\* 2026-08-05 — obsolete/);
  });

  it('keeps the fixed point when the killed idea was discussed', async () => {
    // The legacy serializer writes `**Killed:**` BEFORE the discussion block
    // (lib/ideabox.js:465-471). The projection wrote it after, so the fixed
    // point broke for any killed idea carrying a discussion — the ordinary case,
    // since an idea worth killing is usually one that got argued about. The test
    // above missed it only because its idea had never been discussed.
    const p = await provider();
    const rec = await p.createRecord({ kind: 'idea', title: 'argued then dropped' });
    await p.appendDiscussion(rec.handle, { text: 'not convinced', author: 'human' });
    await p.updateRecord(rec.handle, {
      status: 'killed',
      killed: { at: new Date('2026-08-05').toISOString(), reason: 'lost the argument' },
    });
    const rendered = renderIdeabox({ ideas: await p.listRecords({ kind: 'idea' }), clusters: [] });

    assert.ok(
      rendered.indexOf('**Killed:**') < rendered.indexOf('**Discussion:**'),
      'the killed line must precede the discussion block, as the legacy serializer writes it'
    );
    assert.equal(serializeIdeabox(parseIdeabox(rendered)), rendered);
  });
});

describe('a discussion author with a space survives the projection', () => {
  // COMP-FLUID-SEAM-GUARANTEES F7-1. The parser's author grammar was `\w+`,
  // which matches no real person's name. An entry by `Jane Doe` rendered into
  // the file correctly and then parsed to ZERO entries — the comment silently
  // gone, and the fixed point the cutover rests on broken with it. Unreachable
  // while the CLI was the only writer (it always writes `human`); reachable the
  // moment the REST API took an author from a request body (S3b-2).
  it('round-trips a multi-word author, keeping the entry and the fixed point', async () => {
    const p = await provider();
    const rec = await p.createRecord({ kind: 'idea', title: 'author probe' });
    await p.appendDiscussion(rec.handle, { text: 'a real point', author: 'Jane Doe' });

    const rendered = renderIdeabox({ ideas: await p.listRecords({ kind: 'idea' }), clusters: [] });
    const [parsed] = parseIdeabox(rendered).ideas;

    assert.equal(parsed.discussion.length, 1, 'the entry vanished from the projection');
    assert.equal(parsed.discussion[0].author, 'Jane Doe');
    assert.equal(parsed.discussion[0].text, 'a real point');
    assert.equal(serializeIdeabox(parseIdeabox(rendered)), rendered);
  });

  it('keeps a colon inside the comment text, which is where colons actually appear', async () => {
    // The author match is lazy so the FIRST colon delimits. A greedy match would
    // hand the author everything up to the LAST colon and truncate the comment.
    const p = await provider();
    const rec = await p.createRecord({ kind: 'idea', title: 'colon probe' });
    await p.appendDiscussion(rec.handle, { text: 'see this: it matters', author: 'Jane Doe' });

    const rendered = renderIdeabox({ ideas: await p.listRecords({ kind: 'idea' }), clusters: [] });
    const [parsed] = parseIdeabox(rendered).ideas;

    assert.equal(parsed.discussion[0].author, 'Jane Doe');
    assert.equal(parsed.discussion[0].text, 'see this: it matters');
  });

  it('refuses an author the projection could not represent', async () => {
    // A colon in the author is unrepresentable in `- [date] author: text`.
    // Refused at the contract rather than escaped in the renderer: a value the
    // surface cannot express is a value the store should not hold.
    const p = await provider();
    const rec = await p.createRecord({ kind: 'idea', title: 'bad author' });
    await assert.rejects(
      () => p.appendDiscussion(rec.handle, { text: 'x', author: 'Bad: Author' }),
      /author must match pattern/
    );
    assert.equal((await p.getRecord(rec.handle)).discussion.length, 0, 'the refusal still wrote');
  });
});

describe('the projection is published under the provider lock', () => {
  it('waits for a held lock instead of publishing a snapshot alongside another writer', async () => {
    // COMP-PLAN-IDEA-UNIFY S3b-2. Each mutation is locked inside the provider,
    // but rendering is a separate read-then-publish. With two writers (the CLI
    // and the REST API) writer A can read a snapshot, writer B can mutate AND
    // publish a newer projection, and A's rename lands last carrying the older
    // content — leaving the file humans read wrong until the next write, while
    // canon is perfectly correct.
    //
    // Asserted by direction, not by timing: while another holder owns the lock
    // the render cannot complete, and it completes once the lock is released.
    const p = await provider();
    await p.createRecord({ kind: 'idea', title: 'contended' });
    const out = join(tmp, 'locked-ideabox.md');

    const release = await acquireDirLock(p.lockPath);
    let done = false;
    const render = writeIdeaboxProjection(p, out).then((md) => { done = true; return md; });

    await new Promise((r) => setTimeout(r, 150));
    assert.equal(done, false, 'the render published while another writer held the lock');
    assert.equal(existsSync(out), false, 'the render wrote a file while another writer held the lock');

    release();
    await render;
    assert.equal(done, true);
    assert.match(readFileSync(out, 'utf8'), /contended/);
  });
});

describe('the projection is a fixed point for every field a client reads', () => {
  // COMP-PLAN-IDEA-UNIFY S3b-2, D21. The API derives its responses by parsing
  // the markdown it just rendered, which buys one shape for reads and writes at
  // the cost of a real hazard: a field the renderer does not emit is invisible
  // to every client even when canon holds it. That is not a hypothetical — it is
  // exactly how effort and impact went missing. This is the standing guard.

  const consumed = (idea) => ({
    id: idea.id,
    title: idea.title,
    status: idea.status,
    priority: idea.priority,
    tags: idea.tags,
    source: idea.source,
    description: idea.description,
    cluster: idea.cluster,
    mapsTo: idea.mapsTo,
    effort: idea.effort,
    impact: idea.impact,
  });

  it('carries every consumed field through render → parse', async () => {
    const p = await provider();
    const cluster = await p.createRecord({ kind: 'cluster', title: 'Umbrella A', body: 'a theme' });
    const rec = await p.createRecord({
      kind: 'idea',
      title: 'fully populated',
      body: 'the description',
      source: 'a conversation',
      tags: ['ux', 'core'],
      cluster: cluster.handle,
      priority: 'P1',
      effort: 'M',
      impact: 'medium',
      links: [{ type: 'maps_to', target: 'COMP-FOO-1' }],
    });
    await p.appendDiscussion(rec.handle, { text: 'a point', author: 'human' });

    const rendered = renderIdeabox({
      ideas: await p.listRecords({ kind: 'idea' }),
      clusters: await p.listRecords({ kind: 'cluster' }),
    });
    const [parsed] = parseIdeabox(rendered).ideas;

    assert.deepEqual(consumed(parsed), {
      id: rec.handle,
      title: 'fully populated',
      status: 'NEW',
      priority: 'P1',
      tags: ['ux', 'core'],
      source: 'a conversation',
      description: 'the description',
      cluster: 'Umbrella A',
      mapsTo: 'COMP-FOO-1',
      effort: 'M',
      impact: 'medium',
    });

    // Asserted separately because the date is stamped at write time. The shape
    // and the content are the part a client reads; pinning today's date here
    // would make the test fail tomorrow for no reason.
    assert.equal(parsed.discussion.length, 1);
    assert.equal(parsed.discussion[0].author, 'human');
    assert.equal(parsed.discussion[0].text, 'a point');
    assert.match(parsed.discussion[0].date, /^\d{4}-\d{2}-\d{2}$/);

    assert.equal(serializeIdeabox(parseIdeabox(rendered)), rendered);
  });

  it('keeps the fixed point when an idea carries both a maps_to and a promotion', async () => {
    // The legacy parser knows `Maps to` and does not know `Promoted to`, so the
    // latter becomes an extra line — and extras are re-serialized BEFORE the
    // trailing known fields. Emitting them in the readable order therefore flips
    // them on the first round trip. No idea has ever had both, which is why it
    // was invisible.
    const p = await provider();
    const rec = await p.createRecord({
      kind: 'idea',
      title: 'mapped and promoted',
      links: [{ type: 'maps_to', target: 'COMP-FOO-1' }],
    });
    await p.updateRecord(rec.handle, {
      status: 'promoted',
      links: [
        { type: 'maps_to', target: 'COMP-FOO-1' },
        { type: 'promoted_to', target: 'COMP-BAR-2' },
      ],
    });
    const rendered = renderIdeabox({ ideas: await p.listRecords({ kind: 'idea' }), clusters: [] });

    assert.equal(serializeIdeabox(parseIdeabox(rendered)), rendered);
  });
});

describe('the compose ideabox CLI, writing through the record store', () => {
  // Driving runIdeaboxCommand directly is the point of the extraction: the
  // cutover is testable in-process instead of only through a subprocess.
  let project, ideabox, log;

  const run = async (...args) => {
    const original = console.log;
    console.log = (...a) => log.push(a.join(' '));
    try { return await runIdeaboxCommand(project, args, { config: {} }); }
    finally { console.log = original; }
  };
  const read = () => readFileSync(ideabox, 'utf8');
  const parse = () => parseIdeabox(read());

  beforeEach(() => {
    project = join(tmp, 'project');
    ideabox = join(project, 'docs/product/ideabox.md');
    log = [];
  });

  it('adds an idea, and the file it writes is a faithful projection', async () => {
    assert.equal(await run('add', 'first idea', '--desc', 'the body', '--tags', 'alpha,beta'), 0);
    const parsed = parse();
    assert.equal(parsed.ideas.length, 1);
    assert.equal(parsed.ideas[0].id, 'IDEA-1');
    assert.equal(parsed.ideas[0].description, 'the body');
    // `#` is stripped: the projection's own convention line documents bare words.
    assert.deepEqual(parsed.ideas[0].tags, ['alpha', 'beta']);
    assert.equal(serializeIdeabox(parsed), read(), 'the CLI wrote a file it cannot round-trip');
  });

  it('carries an existing markdown ideabox into the store on first use', async () => {
    // The upgrade path, through the command the user actually types.
    const legacy = '# Ideabox\n\n## Ideas\n\n'
      + '#### IDEA-1 — theirs\n**Status:** NEW | **Priority:** —\n**Idea:** existing work\n\n'
      + '#### IDEA-2 — also theirs\n**Status:** NEW | **Priority:** —\n**Idea:** more\n\n## Killed Ideas\n';
    mkdirSync(join(project, 'docs/product'), { recursive: true });
    writeFileSync(ideabox, legacy);

    await run('add', 'mine');
    const parsed = parse();
    assert.equal(parsed.ideas.length, 3, 'the existing ideas were destroyed by the first add');
    assert.deepEqual(parsed.ideas.map((i) => i.id), ['IDEA-1', 'IDEA-2', 'IDEA-3']);
    assert.equal(parsed.ideas[0].description, 'existing work');
  });

  it('walks the full lifecycle and keeps the file round-tripping throughout', async () => {
    await run('add', 'lifecycle idea');
    await run('pri', 'idea-1', 'P0');              // lowercase id, as the old CLI allowed
    await run('discuss', 'IDEA-1', 'a comment');
    assert.equal(serializeIdeabox(parse()), read());

    const parsed = parse();
    assert.equal(parsed.ideas[0].priority, 'P0');
    assert.equal(parsed.ideas[0].discussion.length, 1);
    assert.equal(parsed.ideas[0].discussion[0].text, 'a comment');

    await run('add', 'doomed');
    await run('kill', 'IDEA-2', 'not worth it');
    const afterKill = parse();
    assert.equal(afterKill.killed.length, 1);
    assert.equal(afterKill.killed[0].killedReason, 'not worth it');
    assert.equal(serializeIdeabox(afterKill), read(), 'killing an idea broke the round-trip');
  });

  it('does not rewrite the kill evidence when kill is retried', async () => {
    // Every command writes its record before re-rendering, so "record committed,
    // render failed" invites a retry — and an unconditional write would replace
    // the original date and reason, most likely with "(no reason given)".
    await run('add', 'doomed');
    await run('kill', 'IDEA-1', 'the original reason');
    const provider = await fluidProviderFor(project);
    const first = await provider.getRecord('IDEA-1');

    await run('kill', 'IDEA-1');           // retry, no reason given
    const second = await provider.getRecord('IDEA-1');
    assert.equal(second.killed.reason, 'the original reason');
    assert.equal(second.killed.at, first.killed.at);
    assert.match(read(), /the original reason/);
  });

  it('records promotion as a link, not a formatted status string', async () => {
    await run('add', 'promote me');
    assert.equal(await run('promote', 'IDEA-1', 'FEAT-X'), 0);
    assert.match(read(), /\*\*Promoted to:\*\* FEAT-X/);
    const provider = await fluidProviderFor(project);
    const rec = await provider.getRecord('IDEA-1');
    assert.equal(rec.status, 'promoted');
    assert.deepEqual(rec.links, [{ type: 'promoted_to', target: 'FEAT-X' }]);
    assert.equal(rec.status_label, null, 'promotion must be a link, not a formatted status string');
  });

  it('resolves --cluster to a handle instead of storing a name that vanishes', async () => {
    await run('add', 'clustered', '--cluster', 'Umbrella A');
    const provider = await fluidProviderFor(project);
    const [cluster] = await provider.listRecords({ kind: 'cluster' });
    const idea = await provider.getRecord('IDEA-1');
    assert.equal(idea.cluster, cluster.handle, 'the raw name was stored, so the idea would vanish');
    assert.match(read(), /### Umbrella A/);
    assert.match(read(), /IDEA-1/);

    // The same name a second time reuses the cluster rather than creating a twin.
    await run('add', 'also clustered', '--cluster', 'Umbrella A');
    assert.equal((await provider.listRecords({ kind: 'cluster' })).length, 1);
  });

  it('render rebuilds the file from the records without touching them', async () => {
    await run('add', 'an idea');
    const before = read();
    writeFileSync(ideabox, '# corrupted by hand\n');
    assert.equal(await run('render'), 0);
    assert.equal(read(), before, 'render did not restore the projection');
  });

  it('reports unknown subcommands and missing arguments without writing', async () => {
    assert.equal(await run('nonsense'), 1);
    assert.equal(await run('add'), 1);
    assert.equal(existsSync(ideabox), false, 'a failed command created the ideabox anyway');
  });
});

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

    // Counts are derived from the file, never hard-coded. An earlier version
    // pinned "20 ideas, nextId 21" and broke the moment someone filed an idea —
    // a test that fails on ordinary use trains people to edit the test. The
    // invariant that actually matters is conservation: whatever the file holds,
    // the projection holds exactly that, with the same handles.
    const before = parseIdeabox(real);
    const parsed = parseIdeabox(rendered);
    const handles = (d) => [...d.ideas, ...d.killed].map((i) => i.id).sort();

    assert.deepEqual(handles(parsed), handles(before), 'an idea went missing or was renamed');
    assert.equal(parsed.nextId, before.nextId, 'handle numbering drifted — external citations break');
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
