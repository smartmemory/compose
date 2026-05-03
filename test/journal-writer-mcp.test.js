/**
 * journal-writer-mcp.test.js — end-to-end tests for COMP-MCP-JOURNAL-WRITER.
 * Spawns the MCP server, speaks JSON-RPC over stdio.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(ROOT, 'server', 'compose-mcp.js');
const FIXTURE_FAIL_INDEX = join(ROOT, 'test', 'fixtures', 'mcp-fail-index-write.mjs');

class McpClient {
  constructor(cwd) {
    this.proc = spawn('node', [MCP_SERVER], {
      env: { ...process.env, COMPOSE_TARGET: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf-8');
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve: rs, reject: rj } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rj(new Error(msg.error.message || JSON.stringify(msg.error)));
            else rs(msg.result);
          }
        } catch { /* ignore */ }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request "${method}" timed out`));
        }
      }, 8000);
    });
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  close() {
    this.proc.kill();
  }
}

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-journal-writer-'));
  // Create a minimal valid journal index.
  const jDir = join(cwd, 'docs', 'journal');
  mkdirSync(jDir, { recursive: true });
  writeFileSync(join(jDir, 'README.md'), [
    '# Developer Journal',
    '',
    'Test journal.',
    '',
    '## Entries',
    '',
    '| Date | Entry | Summary |',
    '|------|-------|---------|',
    '',
  ].join('\n'));
  return cwd;
}

function parseToolText(result) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

const VALID_SECTIONS = {
  what_happened: 'We built the MCP journal writer.',
  what_we_built: 'Two new MCP tools: write_journal_entry and get_journal_entries.',
  what_we_learned: 'Hand-rolled frontmatter parsers are fiddly but testable.',
  open_threads: '- [ ] Codex review pass.',
};

describe('compose-mcp journal writer (end-to-end)', () => {
  test('#32 tools/list includes both new journal tools', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.request('tools/list', {});
      const names = result.tools.map(t => t.name);
      assert.ok(names.includes('write_journal_entry'), 'write_journal_entry should be listed');
      assert.ok(names.includes('get_journal_entries'), 'get_journal_entries should be listed');
    } finally {
      client.close();
    }
  });

  test('#32b write_journal_entry returns canonical shape', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('write_journal_entry', {
        date: '2026-05-03',
        slug: 'mcp-e2e-test',
        sections: VALID_SECTIONS,
        summary_for_index: 'MCP e2e test entry',
        feature_code: 'COMP-MCP-JOURNAL-WRITER',
      });
      const parsed = parseToolText(result);
      assert.equal(typeof parsed.path, 'string');
      assert.equal(typeof parsed.session_number, 'number');
      assert.equal(parsed.session_number, 0);
      assert.equal(typeof parsed.index_line, 'number');
      assert.ok(parsed.index_line > 0);
      assert.equal(parsed.idempotent, false);
    } finally {
      client.close();
    }
  });

  test('#33 idempotent replay: second call returns idempotent:true, no new row', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const args = {
        date: '2026-05-03',
        slug: 'idempotent-replay',
        sections: VALID_SECTIONS,
        summary_for_index: 'Idempotent replay test',
      };
      await client.callTool('write_journal_entry', args);
      const result2 = await client.callTool('write_journal_entry', args);
      const parsed2 = parseToolText(result2);
      assert.equal(parsed2.idempotent, true);
    } finally {
      client.close();
    }
  });

  test('#34 get_journal_entries with feature_code filter returns written entry', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      // Write one entry with a feature code.
      await client.callTool('write_journal_entry', {
        date: '2026-05-03',
        slug: 'feature-filter-test',
        sections: VALID_SECTIONS,
        summary_for_index: 'Feature filter test',
        feature_code: 'COMP-MCP-JOURNAL-WRITER',
      });
      // Write another without.
      await client.callTool('write_journal_entry', {
        date: '2026-05-03',
        slug: 'no-feature-code',
        sections: VALID_SECTIONS,
        summary_for_index: 'No feature code entry',
      });

      const getResult = await client.callTool('get_journal_entries', {
        feature_code: 'COMP-MCP-JOURNAL-WRITER',
      });
      const parsed = parseToolText(getResult);
      assert.equal(parsed.count, 1);
      const entry = parsed.entries[0];
      assert.equal(entry.feature_code, 'COMP-MCP-JOURNAL-WRITER');
      assert.equal(entry.slug, 'feature-filter-test');
      // All documented fields present.
      assert.ok('date' in entry);
      assert.ok('session_number' in entry);
      assert.ok('path' in entry);
      assert.ok('summary' in entry);
      assert.ok('sections' in entry);
      assert.ok('unknownSections' in entry);
      assert.ok(Array.isArray(entry.unknownSections));
      assert.ok('closing_line' in entry);
    } finally {
      client.close();
    }
  });

  test('#35 validation error: invalid date → typed error INVALID_INPUT propagates', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('write_journal_entry', {
        date: '05/03/2026',  // invalid format
        slug: 'bad-date',
        sections: VALID_SECTIONS,
        summary_for_index: 'Bad date test',
      });
      // Result should be an error with [INVALID_INPUT] in the text.
      assert.ok(result.isError, 'result should be an error');
      const text = result.content?.[0]?.text || '';
      assert.match(text, /\[INVALID_INPUT\]/, `expected [INVALID_INPUT] in error text, got: ${text}`);
    } finally {
      client.close();
    }
  });

  test('#36 partial-write MCP boundary: err.cause survives the real MCP server boundary', async () => {
    const cwd = freshCwd();

    // Spawn the fixture server which pre-installs the failing renameSync hook
    // before the real compose-mcp.js starts. This exercises the actual code
    // path through the spawned child — not a re-implementation of the formatter.
    const proc = spawn('node', [FIXTURE_FAIL_INDEX], {
      env: { ...process.env, COMPOSE_TARGET: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const pending = new Map();
    let nextId = 1;

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            const { resolve: rs, reject: rj } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) rj(new Error(msg.error.message || JSON.stringify(msg.error)));
            else rs(msg.result);
          }
        } catch { /* ignore */ }
      }
    });

    const request = (method, params) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`MCP request "${method}" timed out`));
          }
        }, 10000);
      });
    };

    try {
      const result = await request('tools/call', {
        name: 'write_journal_entry',
        arguments: {
          date: '2026-05-03',
          slug: 'mcp-cause-boundary',
          sections: VALID_SECTIONS,
          summary_for_index: 'MCP cause boundary test',
        },
      });

      assert.ok(result.isError, 'response must be an error when index write fails');
      const text = result.content?.[0]?.text || '';
      assert.match(text, /\[JOURNAL_PARTIAL_WRITE\]/, `expected [JOURNAL_PARTIAL_WRITE] in text, got: ${text}`);
      assert.match(text, /Caused by \[ETESTFAIL\]:/, `expected Caused by [ETESTFAIL]: in text, got: ${text}`);
      assert.match(text, /forced index-write failure/, `expected cause message in text, got: ${text}`);
    } finally {
      proc.kill();
    }
  });
});
