/** Controller-run only. Never invoke a provider without COMPOSE_DEVIN_LIVE=1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { devinBuildFixture } from './helpers/devin-build-fixture.js';

test('live Devin consumer worktree build, known zero cost and executed tier', {
  skip: process.env.COMPOSE_DEVIN_LIVE !== '1', timeout: 240000,
}, t => devinBuildFixture({ live: true, signal: t.signal }));

test('aborted non-live Devin fixture closes and removes its private root', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  let root, dispatchStarted;
  const started = new Promise(resolve => { dispatchStarted = resolve; });
  const fixture = devinBuildFixture({ signal: controller.signal, onRoot: value => { root = value; },
    onDispatch: dispatchStarted, agentRun: () => new Promise(() => {}) });
  await Promise.race([started, fixture.then(() => { throw new Error('fixture completed before dispatch'); })]);
  controller.abort(new Error('fixture timeout'));
  let deadline;
  try {
    await Promise.race([
      assert.rejects(fixture, /fixture timeout/),
      new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('fixture did not reject promptly')), 4000); }),
    ]);
  } finally { clearTimeout(deadline); }
  assert.equal(existsSync(root), false, 'private root must be removed before the fixture rejects');
});

test('fixture deadline awaits cleanup before rejection and test completion', { timeout: 30000 }, async t => {
  let root, dispatchStarted;
  const started = new Promise(resolve => { dispatchStarted = resolve; });
  const fixture = devinBuildFixture({ deadlineMs: 10000, onRoot: value => { root = value; },
    onDispatch: dispatchStarted, agentRun: () => new Promise(() => {}) });
  await Promise.race([started, fixture.then(() => { throw new Error('fixture completed before dispatch'); })]);
  await assert.rejects(fixture, /Devin golden fixture deadline exceeded/);
  assert.equal(existsSync(root), false, 'deadline rejection must follow private-root removal');
  t.after(() => assert.equal(existsSync(root), false, 'test completion must follow private-root removal'));
});

test('abort during connect closes the eventual connection before fixture settles', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  let root, connectStarted, finishConnect;
  const started = new Promise(resolve => { connectStarted = resolve; });
  const connecting = new Promise(resolve => { finishConnect = resolve; });
  const client = {
    connected: false,
    closedAfterConnect: false,
    async connect() { connectStarted(); await connecting; this.connected = true; },
    async close() {
      if (!this.connected) return;
      this.closedAfterConnect = true;
      this.connected = false;
    },
  };
  const fixture = devinBuildFixture({ signal: controller.signal, client,
    onRoot: value => { root = value; } });
  await Promise.race([started, fixture.then(() => { throw new Error('fixture completed before connect'); })]);
  controller.abort(new Error('abort during connect'));
  finishConnect();
  await assert.rejects(fixture, /abort during connect/);
  assert.equal(client.closedAfterConnect, true, 'the actual connection must be closed');
  assert.equal(existsSync(root), false, 'private root must be removed before the fixture rejects');
});
