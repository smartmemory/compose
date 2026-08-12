/**
 * FOH-6 S4 — writebackReply: Maya's reply joins the discussion trail through
 * the real ops module over the real local provider (golden style — the seams
 * a stub would replace ARE what's under test: the migration gate, the durable
 * record write, the projection render, and the reconcile-then-append
 * idempotency keyed on `message_id`).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { writebackReply, markerFor } = await import(`${ROOT}/lib/colleague/writeback.js`);
const { ideaboxContext, addIdea } = await import(`${ROOT}/lib/fluid/ideabox-ops.js`);
const { LocalFluidProvider } = await import(`${ROOT}/lib/fluid/local-provider.js`);

let project;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'foh6-wb-'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

async function makeCtx() {
  const provider = await new LocalFluidProvider().init(project);
  return ideaboxContext(project, { provider, origin: 'ui:ideabox' });
}

async function seedIdea(ctx) {
  const { record } = await addIdea(ctx, { title: 'Queue-based gate retries', body: 'Redis streams.' });
  return record.handle;
}

const discussionOf = async (ctx, handle) => {
  const idea = (await ctx.provider.listRecords({ kind: 'idea' }))
    .find((r) => r.handle === handle);
  return idea.discussion ?? [];
};

describe('writebackReply', () => {
  test('appends author:maya with the embedded marker; projection carries the reply', async () => {
    const ctx = await makeCtx();
    const handle = await seedIdea(ctx);

    const out = await writebackReply(ctx, { focusId: handle, messageId: 'msg_9', text: 'IDEA-7 contradicts this.' });
    assert.deepEqual(out, { outcome: 'ok', focusId: handle });

    const entries = await discussionOf(ctx, handle);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].author, 'maya');
    assert.ok(entries[0].text.startsWith('IDEA-7 contradicts this.'));
    assert.ok(entries[0].text.endsWith(markerFor('msg_9')));

    // The marker is an HTML comment: durable in the record, present in the
    // projection file, invisible in rendered markdown.
    const projection = readFileSync(ctx.ideaboxPath, 'utf8');
    assert.ok(projection.includes('IDEA-7 contradicts this.'));
  });

  test('idempotent on message_id: a retry after success dedups to ok, no double append', async () => {
    const ctx = await makeCtx();
    const handle = await seedIdea(ctx);

    await writebackReply(ctx, { focusId: handle, messageId: 'msg_9', text: 'noted.' });
    const again = await writebackReply(ctx, { focusId: handle, messageId: 'msg_9', text: 'noted.' });
    assert.deepEqual(again, { outcome: 'ok', focusId: handle, deduped: true });
    assert.equal((await discussionOf(ctx, handle)).length, 1);

    // A DIFFERENT message_id is a different turn — it appends.
    await writebackReply(ctx, { focusId: handle, messageId: 'msg_10', text: 'more.' });
    assert.equal((await discussionOf(ctx, handle)).length, 2);
  });

  test('landed-unrendered: durable append succeeded, projection render failed — outcome distinct from failed', async () => {
    const ctx = await makeCtx();
    const handle = await seedIdea(ctx);
    // Make the projection unwritable WITHOUT tripping the migration gate: no
    // markdown file (gate no-ops) and a read-only destination directory (the
    // render's temp-file write fails AFTER the record is durable).
    rmSync(ctx.ideaboxPath, { force: true });
    const outDir = dirname(ctx.ideaboxPath);
    chmodSync(outDir, 0o555);
    try {
      const out = await writebackReply(ctx, { focusId: handle, messageId: 'msg_11', text: 'durable but unrendered.' });
      assert.equal(out.outcome, 'landed-unrendered');

      // The record IS durable — and a retry reconciles to ok without appending twice.
      const entries = await discussionOf(ctx, handle);
      assert.equal(entries.length, 1);
      const retry = await writebackReply(ctx, { focusId: handle, messageId: 'msg_11', text: 'durable but unrendered.' });
      assert.deepEqual(retry, { outcome: 'ok', focusId: handle, deduped: true });
      assert.equal((await discussionOf(ctx, handle)).length, 1);
    } finally {
      chmodSync(outDir, 0o755);
    }
  });

  test('CONCURRENT retries with one message_id append exactly once (serialized reconcile)', async () => {
    const ctx = await makeCtx();
    const handle = await seedIdea(ctx);
    const args = { focusId: handle, messageId: 'msg_race', text: 'raced.' };
    const [a, b] = await Promise.all([writebackReply(ctx, args), writebackReply(ctx, args)]);
    assert.equal(a.outcome, 'ok');
    assert.equal(b.outcome, 'ok');
    assert.equal([a, b].filter((r) => r.deduped).length, 1, 'exactly one call deduped');
    assert.equal((await discussionOf(ctx, handle)).length, 1);
  });

  test('unknown focus → failed with a reason, never a throw', async () => {
    const ctx = await makeCtx();
    await seedIdea(ctx);
    const out = await writebackReply(ctx, { focusId: 'IDEA-999', messageId: 'msg_1', text: 'x' });
    assert.equal(out.outcome, 'failed');
    assert.match(out.reason, /IDEA-999/);
  });

  test('case-insensitive focus resolution (the CLI-established contract)', async () => {
    const ctx = await makeCtx();
    const handle = await seedIdea(ctx);
    const out = await writebackReply(ctx, { focusId: handle.toLowerCase(), messageId: 'msg_2', text: 'ok' });
    assert.equal(out.outcome, 'ok');
    assert.equal((await discussionOf(ctx, handle)).length, 1);
  });
});
