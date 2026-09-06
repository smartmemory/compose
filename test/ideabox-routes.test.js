/**
 * test/ideabox-routes.test.js — COMP-PLAN-IDEA-UNIFY S3b-2.
 *
 * The REST ideabox has never had a test. Not "thin coverage" — none: S3b-1 shut
 * all six mutating handlers behind a 409 and nothing in the suite noticed, in
 * either direction. So this file starts from the golden flow rather than from
 * the edges.
 *
 * A real Express app on an ephemeral port over a real temp project, with the
 * real local provider. Nothing about the write path is stubbed, because the
 * things most likely to break are the seams the stubs would replace: the
 * migration gate, the record write, and the projection.
 *
 * Every assertion checks BOTH halves — what the client was told, and what
 * reached disk. A handler that returns a convincing body and writes nothing is
 * the exact failure this endpoint has already had once.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const express = (await import('express')).default;
const { attachIdeaboxRoutes } = await import(`${ROOT}/server/ideabox-routes.js`);
const { LocalFluidProvider } = await import(`${ROOT}/lib/fluid/local-provider.js`);
const { runIdeaboxCommand } = await import(`${ROOT}/lib/ideabox-cli.js`);
const { parseIdeabox } = await import(`${ROOT}/lib/ideabox.js`);

let project, server, baseUrl, broadcasts;

const ideaboxPath = () => join(project, 'docs', 'product', 'ideabox.md');
const readProjection = () => readFileSync(ideaboxPath(), 'utf8');
const provider = () => new LocalFluidProvider().init(project);

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Connection: 'close' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);
const patch = (p, b) => api('PATCH', p, b);

// FOH-6 S4: the projection-repair endpoint (the landed-unrendered fix). It
// must rebuild the file from the records without touching any record.
it('POST /api/ideabox/render rebuilds a deleted projection from the records', async () => {
  const { body: created } = await post('/api/ideabox/ideas', { title: 'Render me back' });
  rmSync(ideaboxPath(), { force: true });
  const { status, body } = await post('/api/ideabox/render');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(existsSync(ideaboxPath()));
  assert.ok(readProjection().includes('Render me back'));
  // No record mutation: the idea is still there, untouched.
  const { body: after } = await get('/api/ideabox');
  const idea = after.ideas.find((i) => i.id === created.id);
  assert.ok(idea);
});

// COMP-IDEABOX-MIGRATE-DIALECT: the HTTP render is the CLI render's twin, and
// the CLI one runs the migration gate first (lib/ideabox-cli.js). This one did
// not, so on a project whose ideabox has never been migrated the cockpit's
// repair button wrote an empty projection over the whole file. The CLI path was
// safe and the HTTP path was not, which is the failure class where an
// enumeration of write surfaces would have caught it and a test of one door
// never could.
it('POST /api/ideabox/render does not erase an unmigrated ideabox', async () => {
  const legacy = readFileSync(
    join(ROOT, 'docs/bugs/COMP-IDEABOX-MIGRATE-DIALECT/repro/flat-dialect-fixture.md'),
    'utf8',
  );
  writeFileSync(ideaboxPath(), legacy);

  const { status } = await post('/api/ideabox/render');

  const after = parseIdeabox(readFileSync(ideaboxPath(), 'utf8'));
  assert.ok(
    after.ideas.length >= 18,
    `the 18 pre-existing ideas must survive a render (status ${status}, found ${after.ideas.length})`,
  );
});

before(async () => {
  const app = express();
  app.use(express.json());
  attachIdeaboxRoutes(app, {
    getProjectRoot: () => project,
    getDataDir: () => join(project, '.compose', 'data'),
    broadcastMessage: (msg) => broadcasts.push(msg),
  });
  server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'ideabox-routes-'));
  mkdirSync(join(project, '.compose', 'data'), { recursive: true });
  mkdirSync(join(project, 'docs', 'product'), { recursive: true });
  broadcasts = [];
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the ideabox REST API — golden flow', () => {
  it('carries one idea through capture, triage, discussion, promotion and kill', async () => {
    // ── capture ──
    const created = await post('/api/ideabox/ideas', {
      title: 'a captured idea',
      description: 'why it matters',
      source: 'a conversation',
      tags: ['ux', 'core'],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'IDEA-1');
    assert.equal(created.body.num, 1);
    assert.equal(created.body.description, 'why it matters');
    assert.equal(created.body.priority, '—', 'a fresh idea is untriaged, rendered as a dash');
    assert.equal(created.body.status, 'NEW');
    assert.deepEqual(created.body.tags, ['ux', 'core']);

    const p = await provider();
    assert.equal((await p.getRecord('IDEA-1')).title, 'a captured idea', 'no record reached disk');
    assert.match(readProjection(), /IDEA-1 — a captured idea/, 'the projection was not written');

    // ── it shows up in the hydrate ──
    const listed = await get('/api/ideabox');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.ideas.length, 1);
    assert.equal(listed.body.killed.length, 0);
    assert.equal(listed.body.nextId, 2);

    // ── triage ──
    const triaged = await patch('/api/ideabox/ideas/IDEA-1', { priority: 'P1' });
    assert.equal(triaged.status, 200);
    assert.equal(triaged.body.priority, 'P1');
    assert.equal((await (await provider()).getRecord('IDEA-1')).priority, 'P1');

    // ── the 2x2 matrix axes, which had no storage at all before this slice ──
    const placed = await patch('/api/ideabox/ideas/IDEA-1', { effort: 'S', impact: 'high' });
    assert.equal(placed.body.effort, 'S');
    assert.equal(placed.body.impact, 'high');
    const onDisk = await (await provider()).getRecord('IDEA-1');
    assert.equal(onDisk.effort, 'S');
    assert.equal(onDisk.impact, 'high');
    assert.match(readProjection(), /\*\*Effort:\*\* S/);

    // ── discussion ──
    const discussed = await post('/api/ideabox/ideas/IDEA-1/discuss', {
      author: 'human', text: 'still convinced',
    });
    assert.equal(discussed.status, 201);
    assert.equal(discussed.body.discussion.length, 1);
    assert.equal(discussed.body.discussion[0].text, 'still convinced');
    assert.equal(discussed.body.discussion[0].author, 'human');

    // ── promotion ──
    const promoted = await post('/api/ideabox/ideas/IDEA-1/promote', { featureCode: 'COMP-THING-1' });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.status, 'PROMOTED');
    assert.equal(promoted.body.featureCode, 'COMP-THING-1', 'the promotion envelope the mobile client reads');
    assert.ok(promoted.body.featurePath, 'the promotion envelope carries where it landed');
    assert.ok(
      existsSync(join(project, 'docs', 'features', 'COMP-THING-1', 'feature.json')),
      'promotion did not create the feature'
    );
    const promotedRec = await (await provider()).getRecord('IDEA-1');
    assert.deepEqual(
      promotedRec.links.find((l) => l.type === 'promoted_to'),
      { type: 'promoted_to', target: 'COMP-THING-1' },
      'the promotion must be a typed edge, not a formatted status string'
    );

    // ── kill, then resurrect ──
    const killed = await post('/api/ideabox/ideas/IDEA-1/kill', { reason: 'superseded' });
    assert.equal(killed.status, 200);
    assert.equal(killed.body.status, 'KILLED');
    assert.equal(killed.body.killedReason, 'superseded');
    assert.equal((await get('/api/ideabox')).body.killed.length, 1);

    const back = await post('/api/ideabox/ideas/IDEA-1/resurrect');
    assert.equal(back.status, 200);
    assert.equal(back.body.status, 'NEW');
    assert.equal(back.body.killedReason, '', 'a resurrected idea must not keep its kill reason');
    const after = await get('/api/ideabox');
    assert.equal(after.body.ideas.length, 1);
    assert.equal(after.body.killed.length, 0);
  });

  it('broadcasts ideaboxUpdated on every mutation, so a second client re-hydrates', async () => {
    // Both clients subscribe to this message and nothing had emitted it since
    // S3b-1 gutted the handlers — so every cockpit was silently stale.
    await post('/api/ideabox/ideas', { title: 'one' });
    await patch('/api/ideabox/ideas/IDEA-1', { priority: 'P0' });
    await post('/api/ideabox/ideas/IDEA-1/kill', { reason: 'no' });

    assert.equal(broadcasts.length, 3);
    assert.ok(broadcasts.every((m) => m.type === 'ideaboxUpdated'));
    assert.ok(broadcasts.every((m) => typeof m.timestamp === 'string'));
  });

  it('resolves a cluster by name and reports its title, never its handle', async () => {
    // Clients display and filter on `cluster`. Leaking `CLUS-1` would put the
    // idea in a group the user has never seen.
    const created = await post('/api/ideabox/ideas', { title: 'grouped', cluster: 'Umbrella A' });
    assert.equal(created.body.cluster, 'Umbrella A');
    assert.equal(created.body.clusterHandle, 'CLUS-1');

    const hydrated = await get('/api/ideabox');
    assert.equal(hydrated.body.ideas[0].cluster, 'Umbrella A');
    assert.deepEqual(hydrated.body.clusters.map((c) => c.name), ['Umbrella A']);

    // The same name again reuses the cluster rather than creating a twin.
    await post('/api/ideabox/ideas', { title: 'also grouped', cluster: 'Umbrella A' });
    assert.equal((await get('/api/ideabox')).body.clusters.length, 1);
  });
});

describe('the ideabox REST API — error harness', () => {
  const cases = [
    {
      what: 'a create with no title',
      run: () => post('/api/ideabox/ideas', { description: 'orphaned' }),
      status: 400,
    },
    {
      what: 'a create with a blank title',
      run: () => post('/api/ideabox/ideas', { title: '   ' }),
      status: 400,
    },
    {
      what: 'a patch against an unknown id',
      run: () => patch('/api/ideabox/ideas/IDEA-999', { priority: 'P1' }),
      status: 404,
    },
    {
      what: 'a kill against an unknown id',
      run: () => post('/api/ideabox/ideas/IDEA-999/kill', { reason: 'x' }),
      status: 404,
    },
    {
      // Promotion and kill have consequences a generic field patch cannot carry
      // (a feature folder, a dated reason). A status set through PATCH would
      // produce a record claiming an outcome that never happened.
      what: 'a status change smuggled through PATCH',
      run: () => patch('/api/ideabox/ideas/IDEA-1', { status: 'PROMOTED' }),
      status: 400,
    },
    {
      what: 'an effort outside S/M/L',
      run: () => patch('/api/ideabox/ideas/IDEA-1', { effort: 'XL' }),
      status: 400,
    },
    {
      what: 'an impact outside low/medium/high',
      run: () => patch('/api/ideabox/ideas/IDEA-1', { impact: 'enormous' }),
      status: 400,
    },
    {
      what: 'a priority outside P0/P1/P2',
      run: () => patch('/api/ideabox/ideas/IDEA-1', { priority: 'P9' }),
      status: 400,
    },
    {
      what: 'a discussion with no author',
      run: () => post('/api/ideabox/ideas/IDEA-1/discuss', { text: 'anonymous' }),
      status: 400,
    },
    {
      what: 'a discussion with no text',
      run: () => post('/api/ideabox/ideas/IDEA-1/discuss', { author: 'human' }),
      status: 400,
    },
    {
      what: 'resurrecting an idea that is not dead',
      run: () => post('/api/ideabox/ideas/IDEA-1/resurrect'),
      status: 409,
    },
    {
      what: 'deleting anything at all',
      run: () => api('DELETE', '/api/ideabox/ideas/IDEA-1'),
      status: 405,
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.what} with ${c.status}`, async () => {
      await post('/api/ideabox/ideas', { title: 'the one existing idea' });
      const before = readProjection();

      const res = await c.run();
      assert.equal(res.status, c.status);
      assert.ok(res.body.error, 'a refusal must say why');

      assert.equal(readProjection(), before, 'a refused request rewrote the projection');
      const ideas = await (await provider()).listRecords({ kind: 'idea' });
      assert.equal(ideas.length, 1, 'a refused request wrote a record');
    });
  }

  it('refuses to promote a killed idea rather than silently resurrecting it', async () => {
    // The old REST route refused this by accident, having searched only the live
    // array. The CLI's lookup finds killed records, so without an explicit guard
    // `promote` would flip a killed idea to `promoted` — undoing a dated kill
    // through a command that never mentions kills.
    await post('/api/ideabox/ideas', { title: 'doomed' });
    await post('/api/ideabox/ideas/IDEA-1/kill', { reason: 'obsolete' });

    const res = await post('/api/ideabox/ideas/IDEA-1/promote', {});
    assert.equal(res.status, 409);
    assert.match(res.body.error, /killed/i);

    const rec = await (await provider()).getRecord('IDEA-1');
    assert.equal(rec.status, 'killed', 'the kill was undone anyway');
    assert.equal(rec.killed.reason, 'obsolete');
  });

  it('treats a patch of nothing as a no-op rather than an error', async () => {
    await post('/api/ideabox/ideas', { title: 'untouched' });
    const res = await patch('/api/ideabox/ideas/IDEA-1', { notAField: 'ignored' });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'untouched');
  });

  it('matches a handle case-insensitively, the way every other surface does', async () => {
    await post('/api/ideabox/ideas', { title: 'case test' });
    assert.equal((await patch('/api/ideabox/ideas/idea-1', { priority: 'P2' })).status, 200);
  });
});

describe('the API and the CLI are one store, not two', () => {
  it('reads through the CLI what the API wrote, and the reverse', async () => {
    // The claim the whole slice rests on. If these were two stores, every
    // assertion above would still pass.
    await post('/api/ideabox/ideas', { title: 'written through the API' });

    const cliLog = [];
    const log = console.log;
    console.log = (...a) => cliLog.push(a.join(' '));
    try {
      assert.equal(await runIdeaboxCommand(project, ['list']), 0);
      assert.equal(await runIdeaboxCommand(project, ['add', 'written through the CLI']), 0);
    } finally {
      console.log = log;
    }
    assert.ok(cliLog.join('\n').includes('written through the API'), 'the CLI cannot see the API write');

    const hydrated = await get('/api/ideabox');
    assert.deepEqual(
      hydrated.body.ideas.map((i) => i.title).sort(),
      ['written through the API', 'written through the CLI'],
      'the API cannot see the CLI write'
    );

    // Handles are allocated from one sequence, not two. Two stores would both
    // mint IDEA-1 and one write would disappear.
    assert.deepEqual(hydrated.body.ideas.map((i) => i.id).sort(), ['IDEA-1', 'IDEA-2']);
  });

  it('imports a pre-existing markdown ideabox before the first API write, not after', async () => {
    // The migration gate. Without it an upgraded project with a populated
    // markdown ideabox and an empty store has its ideas replaced by whatever the
    // caller just typed — and the API is the surface most likely to be the first
    // writer after an upgrade.
    writeFileSync(ideaboxPath(), [
      '# Ideabox',
      '',
      '## Ideas',
      '',
      '### Umbrella A',
      '',
      '#### IDEA-1 — an idea that predates the cutover',
      '**Status:** NEW | **Priority:** P0',
      '**Effort:** M',
      '**Impact:** high',
      '',
      '## Killed Ideas',
      '',
    ].join('\n'));

    const created = await post('/api/ideabox/ideas', { title: 'the first API write' });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, 'IDEA-2', 'the new idea reused a handle the markdown already owned');

    const hydrated = await get('/api/ideabox');
    const titles = hydrated.body.ideas.map((i) => i.title);
    assert.ok(titles.includes('an idea that predates the cutover'), 'the migration dropped the old ideas');

    const migrated = hydrated.body.ideas.find((i) => i.id === 'IDEA-1');
    assert.equal(migrated.priority, 'P0');
    assert.equal(migrated.effort, 'M', 'the upgrade lost the matrix assignment');
    assert.equal(migrated.impact, 'high');
  });

  it('reports a committed write whose projection failed as a SUCCESS, not a failure', async () => {
    // The one case where an error response would lie. Both clients apply their
    // mutation optimistically and roll it back on any non-ok status, so a 500
    // here would erase a committed idea from the UI and invite the user to type
    // it again — manufacturing the duplicate the record store exists to prevent.
    //
    // The render is forced to fail the only way it can once clusters are
    // resolved before the write: a record already pointing at a cluster that
    // does not exist, which the renderer refuses rather than silently dropping
    // from the file.
    const p = await provider();
    await p.createRecord({ kind: 'idea', title: 'orphaned', cluster: 'CLUS-404' });

    const res = await patch('/api/ideabox/ideas/IDEA-1', { priority: 'P1' });

    assert.equal(res.status, 200, 'a committed write must not be reported as a failure');
    assert.equal(res.body.projectionStale, true, 'the staleness must be machine-readable, not prose');
    assert.match(res.body.warning, /compose ideabox render/, 'the warning must name the repair path');
    assert.equal(res.body.id, 'IDEA-1', 'the response still carries the idea the client asked about');
    assert.equal(res.body.priority, 'P1');

    // The half that must be true for the response above to be honest.
    assert.equal((await (await provider()).getRecord('IDEA-1')).priority, 'P1', 'the write did not land');
  });

  it('serves a hydrate that agrees with the projection the write rendered', async () => {
    // The API reads records and the human reads markdown. They are two
    // projections of one store and they must not disagree.
    await post('/api/ideabox/ideas', {
      title: 'consistent', description: 'body text', source: 'somewhere', tags: ['a'],
    });
    await patch('/api/ideabox/ideas/IDEA-1', { priority: 'P1', effort: 'L', impact: 'low' });

    const fromApi = (await get('/api/ideabox')).body.ideas[0];
    const fromFile = parseIdeabox(readProjection()).ideas[0];

    for (const field of ['id', 'title', 'status', 'priority', 'tags', 'source', 'description', 'effort', 'impact']) {
      assert.deepEqual(fromApi[field], fromFile[field], `the API and the file disagree about ${field}`);
    }
  });
});
