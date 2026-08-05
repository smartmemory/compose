/**
 * test/ideabox-projection-watch.test.js — IDEA-24.
 *
 * A `compose ideabox` CLI write never touches the REST route that broadcasts, so
 * an open cockpit sat on a stale list until someone reloaded it. The bridge is a
 * watch on the projection that raises `ideaboxUpdated` on the vision WS.
 *
 * The golden flow here is the whole bug: a REAL CLI write into a REAL temp
 * project, through the real provider and the real renderer, observed by a REAL
 * `fs.watch` — because every stub-able seam in that chain (the render, the
 * atomic rename, the debounce, the filename filter) is one of the things that
 * can silently swallow the event.
 *
 * `PROJECT_ROOT` is frozen in `server/file-watcher.js` at import time, so
 * `COMPOSE_TARGET` is set and the module imported dynamically, below.
 *
 * ONE SPY, DELIBERATELY: the docs-watch leg asserts through `watcher.broadcast`
 * rather than a connected socket. That leg exists to prove the new watch did not
 * eat the pre-existing `fileChanged` for the same file (see `debounceScope`);
 * whether a message then reaches a socket is `ws`'s job, covered elsewhere. The
 * leg that matters — `onIdeaboxChanged` — is the real hook `server/index.js`
 * assigns, called by real watcher code.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The temp project must exist and COMPOSE_TARGET must be set BEFORE the first
// import of anything that reaches server/project-root.js — it resolves the
// target root once, at module load.
const project = mkdtempSync(join(tmpdir(), 'ideabox-watch-'));
mkdirSync(join(project, '.compose', 'data'), { recursive: true });
// docs/ exists (so the pre-existing docs watch registers and the swallow test
// below is meaningful) but docs/product does NOT: a project that has never
// rendered a projection is exactly the case where the projection watch used to
// be skipped, leaving the FIRST CLI write — the one most likely to be watched
// for — silent.
mkdirSync(join(project, 'docs'), { recursive: true });
process.env.COMPOSE_TARGET = project;

const {
  FileWatcherServer,
  isIdeaboxProjectionFile,
  buildIdeaboxUpdatedMessage,
  createTrailingDebouncer,
} = await import(`${ROOT}/server/file-watcher.js`);
const { runIdeaboxCommand } = await import(`${ROOT}/lib/ideabox-cli.js`);

const express = (await import('express')).default;
const http = await import('node:http');

const projectionPath = join(project, 'docs', 'product', 'ideabox.md');

/** Poll until `fn()` is truthy or the budget runs out. Returns fn()'s value. */
async function waitFor(fn, budgetMs = 4000, stepMs = 25) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Does fs.watch deliver in this environment at all? Some CI sandboxes silently
 * drop events. Probed once so a non-delivering environment produces an explicit
 * SKIP rather than a green run that asserted nothing.
 */
async function fsWatchDelivers() {
  const dir = mkdtempSync(join(tmpdir(), 'watchprobe-'));
  let fired = false;
  let w;
  try {
    w = fs.watch(dir, { recursive: false }, () => { fired = true; });
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return false;
  }
  fs.writeFileSync(join(dir, 'probe.txt'), 'x');
  await waitFor(() => fired, 2000);
  w.close();
  rmSync(dir, { recursive: true, force: true });
  return fired;
}

let watcher;
let ideaboxEvents;
let fileWsMessages;
let watchWorks = false;

before(async () => {
  watchWorks = await fsWatchDelivers();

  ideaboxEvents = [];
  fileWsMessages = [];

  watcher = new FileWatcherServer();
  const app = express();
  const server = http.createServer(app);
  watcher.attach(server, app);

  // The hook server/index.js assigns.
  watcher.onIdeaboxChanged = (msg) => ideaboxEvents.push(msg);
  // See header: outbound-seam spy for the docs-watch leg only.
  const realBroadcast = watcher.broadcast.bind(watcher);
  watcher.broadcast = (msg) => { fileWsMessages.push(msg); return realBroadcast(msg); };
});

after(() => {
  try { watcher?.close(); } catch { /* */ }
  rmSync(project, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit — the predicate and the message shape
// ---------------------------------------------------------------------------

describe('IDEA-24 — projection predicate + message shape (unit)', () => {
  test('isIdeaboxProjectionFile matches the projection and nothing beside it', () => {
    assert.equal(isIdeaboxProjectionFile('ideabox.md', 'ideabox.md'), true);

    // render-ideabox.js publishes via `.ideabox.md.tmp.<uuid>` in the SAME dir.
    // Matching it would announce an update before the rename made it real.
    assert.equal(
      isIdeaboxProjectionFile('.ideabox.md.tmp.9f1c2b40-0000-4000-8000-000000000000', 'ideabox.md'),
      false,
      'the atomic-publish temp file must not fire',
    );

    assert.equal(isIdeaboxProjectionFile('roadmap.md', 'ideabox.md'), false);
    assert.equal(isIdeaboxProjectionFile('sub/ideabox.md', 'ideabox.md'), false,
      'the watch is non-recursive; a nested name is not this file');
    assert.equal(isIdeaboxProjectionFile(null, 'ideabox.md'), false);
    assert.equal(isIdeaboxProjectionFile(undefined, 'ideabox.md'), false);
    assert.equal(isIdeaboxProjectionFile('ideabox.md', undefined), false);
    assert.equal(isIdeaboxProjectionFile('', ''), false, 'an empty basename matches nothing');

    // A relocated projection is matched by ITS basename, not a hardcoded one.
    assert.equal(isIdeaboxProjectionFile('ideas.md', 'ideas.md'), true);
    assert.equal(isIdeaboxProjectionFile('ideabox.md', 'ideas.md'), false);
  });

  test('createTrailingDebouncer keeps the LAST event, not the first', async () => {
    const WAIT = 60;
    const fired = [];
    const d = createTrailingDebouncer(() => fired.push(Date.now()), WAIT);

    // THE ASSERTION IS THE ORDERING, NOT THE COUNT. A leading-edge debounce
    // also fires exactly once per burst — but it fires WAIT after the FIRST
    // trigger, which can land before the burst has finished writing. The client
    // then re-fetches a store that is missing the last writes and goes stale
    // again, which is the bug this whole feature closes.
    //
    // So: trigger, wait less than a full window, trigger again. A leading-edge
    // implementation has already fired by now; a trailing one has not.
    d.trigger();
    await new Promise((r) => setTimeout(r, WAIT / 2));
    const lastTrigger = Date.now();
    d.trigger();
    await new Promise((r) => setTimeout(r, WAIT * 0.75));
    assert.equal(fired.length, 0,
      'must NOT have fired yet: the window restarts from the LAST trigger, not the first');

    await new Promise((r) => setTimeout(r, WAIT * 2));
    assert.equal(fired.length, 1, 'one fire for the whole burst');
    assert.ok(fired[0] >= lastTrigger + WAIT * 0.9,
      'the fire lands after the last trigger, so the re-fetch sees every write in the burst');

    // A later, separate write is its own fire — the debouncer does not go quiet.
    d.trigger();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fired.length, 2);

    // cancel() must leave nothing pending, or close() leaks a timer that
    // broadcasts into a shut-down server.
    d.trigger();
    d.cancel();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fired.length, 2, 'cancel drops the pending fire');
  });

  test('buildIdeaboxUpdatedMessage emits the type both clients compare against', () => {
    const msg = buildIdeaboxUpdatedMessage('docs/product/ideabox.md');
    // Byte-identical to server/ideabox-routes.js. useIdeaboxStore.js and
    // src/mobile/hooks/useIdeas.js both test `msg.type === 'ideaboxUpdated'`
    // and ignore everything else — any other value is silently dropped.
    assert.equal(msg.type, 'ideaboxUpdated');
    assert.equal(msg.source, 'projection-watch', 'distinguishes file-driven from route-driven');
    assert.equal(msg.path, 'docs/product/ideabox.md');
    assert.ok(!Number.isNaN(Date.parse(msg.timestamp)), 'timestamp is an ISO instant');
  });
});

// ---------------------------------------------------------------------------
// Golden flow — a real CLI write reaches the vision-WS hook
// ---------------------------------------------------------------------------

describe('IDEA-24 — CLI write → ideaboxUpdated (integration)', () => {
  test('the first `ideabox add` in a project with no docs/product/ still fires', async (t) => {
    if (!watchWorks) return t.skip('fs.watch does not deliver events in this environment');

    assert.equal(
      fs.existsSync(projectionPath), false,
      'precondition: nothing has rendered a projection yet',
    );

    const before = ideaboxEvents.length;
    const code = await runIdeaboxCommand(project, ['add', 'First idea from the CLI']);
    assert.equal(code, 0, 'the CLI write succeeded');
    assert.ok(fs.existsSync(projectionPath), 'the CLI rendered the projection');

    const events = await waitFor(
      () => (ideaboxEvents.length > before ? ideaboxEvents.slice(before) : null),
    );
    assert.ok(events, 'a CLI write with no pre-existing docs/product/ still raised ideaboxUpdated');
    assert.equal(events[0].type, 'ideaboxUpdated');
    assert.equal(path.basename(events[0].path), 'ideabox.md');
  });

  test('the record is readable by the time the event fires', async (t) => {
    if (!watchWorks) return t.skip('fs.watch does not deliver events in this environment');

    const before = ideaboxEvents.length;
    await runIdeaboxCommand(project, ['add', 'Second idea, durable before the render']);

    const events = await waitFor(
      () => (ideaboxEvents.length > before ? ideaboxEvents.slice(before) : null),
    );
    assert.ok(events, 'the second write raised ideaboxUpdated');

    // The clients answer this event by re-fetching from the RECORD store, never
    // by parsing the projection (COMP-PLAN-IDEA-UNIFY D21). ideabox-ops.js
    // renders only after the record is durable, so the record a re-fetch would
    // read must already be on disk the instant this event is observable.
    const records = fs.readdirSync(join(project, 'docs', 'product', 'fluid', 'records'));
    assert.ok(
      records.length >= 2,
      `the record backing the event is already durable (found ${records.length})`,
    );
  });

  test('the temp file of an atomic publish does not fire a second event', async (t) => {
    if (!watchWorks) return t.skip('fs.watch does not deliver events in this environment');

    const before = ideaboxEvents.length;
    await runIdeaboxCommand(project, ['add', 'Third idea']);
    await waitFor(() => ideaboxEvents.length > before);
    // Let any straggling event from the same publish land.
    await new Promise((r) => setTimeout(r, 400));

    const fired = ideaboxEvents.slice(before);
    // EXACTLY one, not "at least one". A single publish is a writeFileSync to
    // `.ideabox.md.tmp.<uuid>` followed by a rename onto the projection, and
    // fs.watch delivers more than one raw event for that. Two broadcasts would
    // mean either the temp file is passing the filter or the coalescer is not
    // folding the pair — both invisible to a `>= 1` assertion, and both a
    // doubled re-fetch on every single idea anyone adds.
    assert.equal(fired.length, 1,
      `one publish is one broadcast (got ${fired.length}: ${JSON.stringify(fired.map((m) => m.path))})`);
    assert.equal(path.basename(fired[0].path), 'ideabox.md');
  });

  test('the projection watch does not swallow the docs watch fileChanged', async (t) => {
    if (!watchWorks) return t.skip('fs.watch does not deliver events in this environment');

    const ideaBefore = ideaboxEvents.length;
    const fileBefore = fileWsMessages.length;
    await runIdeaboxCommand(project, ['add', 'Fourth idea — both channels']);

    // Both watches see the SAME file write. They share one debounce map keyed by
    // the prefixed relative path, which both compute as docs/product/ideabox.md;
    // without the projection watch's own debounceScope the second delivery inside
    // the 100ms window is dropped and ONE of these two legs silently disappears.
    const gotIdeabox = await waitFor(() => ideaboxEvents.length > ideaBefore);
    const gotFileChanged = await waitFor(() => fileWsMessages
      .slice(fileBefore)
      .some((m) => m.type === 'fileChanged' && path.basename(m.path) === 'ideabox.md'));

    assert.ok(gotIdeabox, 'the vision-WS ideaboxUpdated fired');
    assert.ok(gotFileChanged, 'the /ws/files fileChanged for the same write ALSO fired');
  });

  test('`ideabox render` — the repair path — also refreshes an open cockpit', async (t) => {
    if (!watchWorks) return t.skip('fs.watch does not deliver events in this environment');

    // A write whose render failed answers projectionStale and leaves the file
    // behind; `compose ideabox render` is how it catches up. That repair must
    // notify too, or a cockpit stays stale until the next write.
    await new Promise((r) => setTimeout(r, 200)); // let the previous test's burst settle
    const before = ideaboxEvents.length;
    const code = await runIdeaboxCommand(project, ['render']);
    assert.equal(code, 0);

    const fired = await waitFor(() => ideaboxEvents.length > before);
    assert.ok(fired, 'a bare render raised ideaboxUpdated');
  });
});
