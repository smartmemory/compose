/**
 * smartmemory-sync.test.js — COMP-SMARTMEMORY-INGEST T5 (golden flow)
 *
 * Tests for lib/smartmemory-sync.js#runSync: the idempotent backfill walker
 * over feature-events.jsonl, gate-log.jsonl, journal entries, and per-feature
 * artifacts.
 *
 * Run: node --test test/smartmemory-sync.test.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { runSync } from '../lib/smartmemory-sync.js';
import { writeFeature } from '../lib/feature-json.js';
import { renderJournalEntry } from '../lib/journal-writer.js';
import { resolveProjectTag, sourcePathFor } from '../lib/smartmemory-config.js';

function listen(server) {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(server)); });
}

/** Blueprint §6 stub — tracks seen {content, context}; repeats of the same content report unchanged. */
function makeSmartmemoryStub({ failStatus = null, quota = false, malformed2xx = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); return res.end('{"ok":true}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { content, context } = JSON.parse(body || '{}');
      seen.push({ content, context, auth: req.headers.authorization });
      if (malformed2xx) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>oops</html>'); }
      if (quota) { res.writeHead(429); return res.end('{"error":"quota"}'); }
      if (failStatus) { res.writeHead(failStatus); return res.end('{"error":"x"}'); }
      const unchanged = seen.filter((s) => s.content === content).length > 1;
      res.writeHead(200);
      res.end(JSON.stringify({ status: unchanged ? 'unchanged' : 'stored' }));
    });
  });
  return { server, seen };
}

const servers = [];
after(() => {
  for (const s of servers) s.close();
  delete process.env.SM_SYNC_KEY;
});

async function withStub(opts = {}) {
  const { server, seen } = makeSmartmemoryStub(opts);
  await listen(server);
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, seen, baseUrl };
}

/** Seed a fresh project fixture with all four surfaces populated. */
function seedFixture(cwd, { baseUrl, apiKeyEnv = 'SM_SYNC_KEY' } = {}) {
  mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
  if (baseUrl) {
    process.env[apiKeyEnv] = 'test-key';
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv },
    }));
  }

  // 1. feature-events.jsonl — 3 rows, one with feature_code only (no `code`).
  const eventsPath = join(cwd, '.compose', 'data', 'feature-events.jsonl');
  const rows = [
    { ts: '2026-07-03T10:00:00.000Z', tool: 'set_feature_status', code: 'FOO-1', from: 'A', to: 'B', actor: 'mcp:agent' },
    { ts: '2026-07-03T10:01:00.000Z', tool: 'add_roadmap_entry', code: 'FOO-2', actor: 'mcp:agent' },
    { ts: '2026-07-03T10:02:00.000Z', tool: 'write_journal_entry', feature_code: 'FOO-1', actor: 'mcp:agent' },
  ];
  for (const r of rows) appendFileSync(eventsPath, JSON.stringify(r) + '\n');

  // 2. gate-log.jsonl — 2 entries.
  const gateLogPath = join(cwd, '.compose', 'data', 'gate-log.jsonl');
  const gateEntries = [
    { id: 'gid-1', timestamp: '2026-07-03T10:03:00.000Z', decision: 'approve', feature_code: 'FOO-1' },
    { id: 'gid-2', timestamp: '2026-07-03T10:04:00.000Z', decision: 'deny', feature_code: 'FOO-2' },
  ];
  for (const e of gateEntries) appendFileSync(gateLogPath, JSON.stringify(e) + '\n');

  // 3. journal entry (feature_code FOO-1).
  mkdirSync(join(cwd, 'docs', 'journal'), { recursive: true });
  const journalContent = renderJournalEntry({
    date: '2026-07-03',
    slug: 'ingest-fixture',
    session_number: 1,
    sections: {
      what_happened: 'happened', what_we_built: 'built',
      what_we_learned: 'learned', open_threads: 'threads',
    },
    summary_for_index: 'A fixture entry',
    feature_code: 'FOO-1',
  });
  writeFileSync(join(cwd, 'docs', 'journal', '2026-07-03-session-1-ingest-fixture.md'), journalContent);
  writeFileSync(join(cwd, 'docs', 'journal', 'README.md'), '# Developer Journal\n');

  // 4. feature folder w/ design.md + audit.json for FOO-1; a second feature FOO-2 with no artifacts.
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  writeFeature(cwd, { code: 'FOO-1', description: 'd', status: 'IN_PROGRESS', created: '2026-07-03', updated: '2026-07-03' });
  writeFeature(cwd, { code: 'FOO-2', description: 'd', status: 'PLANNED', created: '2026-07-03', updated: '2026-07-03' });
  writeFileSync(join(cwd, 'docs', 'features', 'FOO-1', 'design.md'), '# FOO-1 design\n\nSome content.\n');
  writeFileSync(join(cwd, 'docs', 'features', 'FOO-1', 'audit.json'), JSON.stringify({ trace: [] }));

  return { rows, gateEntries };
}

// Total item count across all 4 surfaces (no --feature filter): 3 events + 2 gate-log + 1 journal + 2 artifacts = 8
const TOTAL_ITEMS = 8;

describe('runSync — golden flow', () => {
  test('ingests every item once; contexts match §5 templates', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-golden-'));
    seedFixture(cwd, { baseUrl });
    try {
      const result = await runSync({ cwd });
      assert.equal(result.ingested, TOTAL_ITEMS);
      assert.equal(result.unchanged, 0);
      assert.equal(result.failed, 0);
      assert.equal(result.stoppedOnQuota, false);
      assert.equal(seen.length, TOTAL_ITEMS);

      const tag = resolveProjectTag(cwd);
      for (const s of seen) {
        assert.ok(['cli:compose', 'import:compose'].includes(s.context.origin));
        assert.equal(s.context.project, tag);
        assert.ok(s.context.source_path.startsWith(`compose/${tag}/`));
      }

      // Cross-check event content matches the shared renderer (live/sync identity).
      const { renderFeatureEventContent } = await import('../lib/smartmemory-ingest.js');
      const eventItems = seen.filter((s) => s.context.origin === 'cli:compose' && s.context.source_path.endsWith('feature-events.jsonl'));
      assert.equal(eventItems.length, 3);
      assert.equal(eventItems[0].content, renderFeatureEventContent({ ts: '2026-07-03T10:00:00.000Z', tool: 'set_feature_status', code: 'FOO-1', from: 'A', to: 'B', actor: 'mcp:agent' }, tag));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('re-sync idempotency: second run reports all unchanged', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-resync-'));
    seedFixture(cwd, { baseUrl });
    try {
      const first = await runSync({ cwd });
      assert.equal(first.ingested, TOTAL_ITEMS);

      const second = await runSync({ cwd });
      assert.equal(second.unchanged, TOTAL_ITEMS);
      assert.equal(second.ingested, 0);
      assert.equal(second.failed, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('--feature CODE: only items associated with CODE, null-code events excluded', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-feature-'));
    seedFixture(cwd, { baseUrl });
    try {
      const result = await runSync({ cwd, feature: 'FOO-1' });
      // FOO-1: 1 event (code), 1 event (feature_code) = 2 events; 1 gate-log entry;
      // 1 journal entry; 2 artifacts (design.md + audit.json) = 6 total.
      assert.equal(result.ingested, 6);
      assert.equal(seen.length, 6);
      for (const s of seen) {
        const artifactCode = s.context.artifact?.feature_code;
        const isFoo1Event = s.context.event?.code === 'FOO-1' || s.context.event?.feature_code === 'FOO-1';
        const isFoo1Artifact = artifactCode === 'FOO-1';
        const isFoo1Journal = !s.context.event && !s.context.artifact; // journal entries carry neither
        assert.ok(isFoo1Event || isFoo1Artifact || isFoo1Journal, JSON.stringify(s.context));
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('--dry-run: counts returned, no POST reaches the stub', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-dryrun-'));
    seedFixture(cwd, { baseUrl });
    try {
      const result = await runSync({ cwd, dryRun: true });
      assert.equal(result.ingested, TOTAL_ITEMS);
      assert.equal(seen.length, 0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('malformed JSONL line is skipped, not fatal', async () => {
    const { baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-malformed-'));
    seedFixture(cwd, { baseUrl });
    // Corrupt one line of feature-events.jsonl.
    appendFileSync(join(cwd, '.compose', 'data', 'feature-events.jsonl'), 'not valid json\n');
    try {
      const result = await runSync({ cwd });
      // Still processes the well-formed items; does not throw.
      assert.equal(result.ingested, TOTAL_ITEMS);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a 2xx with a malformed body counts every item as failed, not ingested', async () => {
    const { seen, baseUrl } = await withStub({ malformed2xx: true });
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-malformed-2xx-'));
    seedFixture(cwd, { baseUrl });
    try {
      const result = await runSync({ cwd });
      assert.equal(result.failed, TOTAL_ITEMS);
      assert.equal(result.ingested, 0);
      assert.equal(result.unchanged, 0);
      assert.equal(seen.length, TOTAL_ITEMS);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('429 quota: stops after one backoff+retry, reports stoppedOnQuota', async () => {
    const { seen, baseUrl } = await withStub({ quota: true });
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-quota-'));
    seedFixture(cwd, { baseUrl });
    try {
      const result = await runSync({ cwd });
      assert.equal(result.stoppedOnQuota, true);
      // Backed off once and retried on the first item, then stopped — at most 2 requests reached the stub.
      assert.ok(seen.length <= 2, `expected at most 2 requests, got ${seen.length}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('not enabled + not dry-run: throws a clear error', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-notenabled-'));
    seedFixture(cwd, {}); // no baseUrl → smartmemory not configured/enabled
    try {
      await assert.rejects(() => runSync({ cwd }), /smartmemory not enabled/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('runSync — --feature filter uses OR semantics (code === CODE || feature_code === CODE)', () => {
  test('a row with code:"OTHER-1" but feature_code:"TARGET-1" is included when filtering on TARGET-1', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-feature-or-'));
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    process.env.SM_SYNC_KEY = 'test-key';
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_SYNC_KEY' },
    }));
    const eventsPath = join(cwd, '.compose', 'data', 'feature-events.jsonl');
    const rows = [
      // Carries BOTH fields, and `code` does NOT match the filter — only
      // `feature_code` does. A nullish-coalescing filter (`code ?? feature_code`)
      // wrongly excludes this row because `code` is present (just non-matching).
      { ts: '2026-07-03T10:00:00.000Z', tool: 'write_journal_entry', code: 'OTHER-1', feature_code: 'TARGET-1', actor: 'mcp:agent' },
      // Matches on `code` alone (no `feature_code` field at all) — must still match.
      { ts: '2026-07-03T10:01:00.000Z', tool: 'set_feature_status', code: 'TARGET-1', actor: 'mcp:agent' },
      // Matches neither — must be excluded.
      { ts: '2026-07-03T10:02:00.000Z', tool: 'set_feature_status', code: 'UNRELATED-1', actor: 'mcp:agent' },
    ];
    for (const r of rows) appendFileSync(eventsPath, JSON.stringify(r) + '\n');

    try {
      const result = await runSync({ cwd, feature: 'TARGET-1' });
      assert.equal(result.ingested, 2, 'both the code-match and the feature_code-only-match rows must be included');
      assert.equal(seen.length, 2);
      const codes = seen.map((s) => s.context.event.code);
      assert.ok(codes.includes('OTHER-1'), 'the feature_code-only match (code:"OTHER-1") must be included');
      assert.ok(codes.includes('TARGET-1'), 'the code-only match must still be included');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('runSync — journal discovery (direct directory walk, not getJournalEntries)', () => {
  function seedComposeConfig(cwd, baseUrl) {
    mkdirSync(join(cwd, '.compose', 'data'), { recursive: true });
    process.env.SM_SYNC_KEY = 'test-key';
    writeFileSync(join(cwd, '.compose', 'compose.json'), JSON.stringify({
      smartmemory: { enabled: true, baseUrl, apiKeyEnv: 'SM_SYNC_KEY' },
    }));
  }

  test('unreadable journal entry increments `skipped`; well-formed siblings still ingest', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-journal-unreadable-'));
    seedComposeConfig(cwd, baseUrl);
    mkdirSync(join(cwd, 'docs', 'journal'), { recursive: true });

    const goodContent = renderJournalEntry({
      date: '2026-07-03', slug: 'good-entry', session_number: 1,
      sections: { what_happened: 'a', what_we_built: 'b', what_we_learned: 'c', open_threads: 'd' },
      summary_for_index: 'A good entry',
    });
    writeFileSync(join(cwd, 'docs', 'journal', '2026-07-03-session-1-good-entry.md'), goodContent);

    // An "unreadable" entry: a directory masquerading as a .md entry file —
    // readFileSync throws EISDIR on it, exercising the skip path deterministically.
    mkdirSync(join(cwd, 'docs', 'journal', '2026-07-03-session-2-broken-entry.md'));

    // The journal index itself must be excluded from discovery, not counted as an entry.
    writeFileSync(join(cwd, 'docs', 'journal', 'README.md'), '# Developer Journal\n');

    try {
      const result = await runSync({ cwd });
      assert.equal(result.skipped, 1, 'the broken entry should increment skipped, not vanish silently');
      assert.equal(result.ingested, 1);
      assert.equal(result.failed, 0);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].content, goodContent);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('walks every journal entry on disk — no hidden cap (getJournalEntries hard-caps at 500)', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-journal-many-'));
    seedComposeConfig(cwd, baseUrl);
    mkdirSync(join(cwd, 'docs', 'journal'), { recursive: true });

    const N = 7; // small N is enough to prove no helper-imposed cap applies
    for (let i = 0; i < N; i++) {
      const content = renderJournalEntry({
        date: '2026-07-03', slug: `entry-${i}`, session_number: i,
        sections: { what_happened: 'a', what_we_built: 'b', what_we_learned: 'c', open_threads: 'd' },
        summary_for_index: `Entry ${i}`,
      });
      writeFileSync(join(cwd, 'docs', 'journal', `2026-07-03-session-${i}-entry-${i}.md`), content);
    }
    writeFileSync(join(cwd, 'docs', 'journal', 'README.md'), '# Developer Journal\n');

    try {
      const result = await runSync({ cwd });
      assert.equal(result.ingested, N, 'every file on disk should be walked — count must equal files on disk');
      assert.equal(seen.length, N);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a stray non-entry .md file is not a candidate at all — not ingested, not counted as skipped', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-journal-stray-'));
    seedComposeConfig(cwd, baseUrl);
    mkdirSync(join(cwd, 'docs', 'journal'), { recursive: true });

    const goodContent = renderJournalEntry({
      date: '2026-07-03', slug: 'good-entry', session_number: 1,
      sections: { what_happened: 'a', what_we_built: 'b', what_we_learned: 'c', open_threads: 'd' },
      summary_for_index: 'A good entry',
    });
    writeFileSync(join(cwd, 'docs', 'journal', '2026-07-03-session-1-good-entry.md'), goodContent);

    // Does not match the canonical entry filename (YYYY-MM-DD-session-N-<slug>.md) —
    // a journal entry is defined by filename shape AND parse success, not just "*.md".
    writeFileSync(join(cwd, 'docs', 'journal', 'notes.md'), 'random scratch notes, not a journal entry');
    writeFileSync(join(cwd, 'docs', 'journal', 'README.md'), '# Developer Journal\n');

    try {
      const result = await runSync({ cwd });
      assert.equal(result.ingested, 1, 'only the canonically-named entry should be ingested');
      assert.equal(result.skipped, 0, 'a stray non-entry file is not a candidate, so it must not be counted at all');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].content, goodContent);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('journal entries are ingested newest-first, matching the canonical getJournalEntries sort', async () => {
    // Custom stub: the FIRST request it sees succeeds; every request after that
    // 429s. This isolates "which entry got through" to prove ordering, since
    // the walker stops on quota after one backoff+retry.
    const seen = [];
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        requestCount++;
        const { content, context } = JSON.parse(body || '{}');
        seen.push({ content, context });
        if (requestCount === 1) {
          res.writeHead(200);
          return res.end(JSON.stringify({ status: 'stored' }));
        }
        res.writeHead(429);
        res.end(JSON.stringify({ error: 'quota' }));
      });
    });
    await listen(server);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-journal-order-'));
    seedComposeConfig(cwd, baseUrl);
    mkdirSync(join(cwd, 'docs', 'journal'), { recursive: true });

    // Oldest → newest by (date, session_number). The canonical reader sorts
    // newest-first: date desc, then session_number desc (lib/journal-writer.js
    // ~line 920-923). The walker must mirror that exactly.
    const fixtures = [
      { date: '2026-07-01', session_number: 1, slug: 'oldest' },
      { date: '2026-07-02', session_number: 1, slug: 'middle' },
      { date: '2026-07-02', session_number: 2, slug: 'newest-same-date-higher-session' },
    ];
    const newest = fixtures[2];
    let newestContent = null;
    for (const f of fixtures) {
      const content = renderJournalEntry({
        date: f.date, slug: f.slug, session_number: f.session_number,
        sections: { what_happened: 'a', what_we_built: 'b', what_we_learned: 'c', open_threads: 'd' },
        summary_for_index: f.slug,
      });
      if (f === newest) newestContent = content;
      writeFileSync(join(cwd, 'docs', 'journal', `${f.date}-session-${f.session_number}-${f.slug}.md`), content);
    }
    writeFileSync(join(cwd, 'docs', 'journal', 'README.md'), '# Developer Journal\n');

    try {
      const result = await runSync({ cwd });
      assert.equal(result.stoppedOnQuota, true);
      // request 1: the first item succeeds. Item 2 then 429s, backs off, retries
      // (request 2), still 429s (request 3) → stoppedOnQuota, loop breaks.
      assert.equal(seen.length, 3);
      assert.equal(seen[0].content, newestContent, 'the newest entry (by date desc, session desc) must be the one that got through');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('runSync — per-surface fault isolation', () => {
  // TOTAL_ITEMS is 8 for the standard seedFixture (3 events + 2 gate-log + 1 journal + 2 artifacts).

  test('an unreadable journal dir does not abort the sync — events, gate-log, and artifacts still ingest', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-isolate-journal-'));
    seedFixture(cwd, { baseUrl });

    // Replace the journal directory with a plain file: existsSync sees it (so
    // the walker doesn't just skip it as "absent"), but readdirSync on a
    // non-directory throws ENOTDIR — a top-level surface read failure.
    const journalDir = join(cwd, 'docs', 'journal');
    rmSync(journalDir, { recursive: true, force: true });
    writeFileSync(journalDir, 'not a directory');

    try {
      const result = await runSync({ cwd });
      assert.equal(result.ingested, TOTAL_ITEMS - 1, 'only the journal item (1) should be missing');
      assert.equal(result.skipped, 1, 'one surface failure — journal — should be reported');
      assert.equal(result.failed, 0);
      assert.equal(seen.length, TOTAL_ITEMS - 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unreadable feature-events + gate-log logs do not abort the sync — journal and artifacts still ingest', async () => {
    const { seen, baseUrl } = await withStub();
    const cwd = mkdtempSync(join(tmpdir(), 'smartmemory-sync-isolate-events-gatelog-'));
    seedFixture(cwd, { baseUrl });

    // Same directory-in-place-of-file trick, applied to both jsonl paths:
    // existsSync is true (forces the reader past its "absent" early-return),
    // but readFileSync on a directory throws EISDIR.
    const eventsPath = join(cwd, '.compose', 'data', 'feature-events.jsonl');
    const gateLogPath = join(cwd, '.compose', 'data', 'gate-log.jsonl');
    rmSync(eventsPath, { force: true });
    rmSync(gateLogPath, { force: true });
    mkdirSync(eventsPath);
    mkdirSync(gateLogPath);

    try {
      const result = await runSync({ cwd });
      // Events (3) + gate-log (2) surfaces are down; journal (1) + artifacts (2) still ingest.
      assert.equal(result.ingested, TOTAL_ITEMS - 5);
      assert.equal(result.skipped, 2, 'two surface failures — feature-events and gate-log');
      assert.equal(result.failed, 0);
      assert.equal(seen.length, TOTAL_ITEMS - 5);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
