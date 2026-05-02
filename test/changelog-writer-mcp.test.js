/**
 * changelog-writer-mcp.test.js — end-to-end tests for COMP-MCP-CHANGELOG-WRITER.
 * Spawns the MCP server, speaks JSON-RPC over stdio.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(ROOT, 'server', 'compose-mcp.js');

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
      }, 5000);
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
  return mkdtempSync(join(tmpdir(), 'mcp-changelog-writer-'));
}

function parseToolText(result) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

describe('compose-mcp changelog writer (end-to-end)', () => {
  test('tools/list includes both new tools', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.request('tools/list', {});
      const names = result.tools.map(t => t.name);
      assert.ok(names.includes('add_changelog_entry'));
      assert.ok(names.includes('get_changelog_entries'));
    } finally {
      client.close();
    }
  });

  test('add_changelog_entry creates CHANGELOG and returns canonical shape', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('add_changelog_entry', {
        date_or_version: '2026-05-02',
        code: 'MCP-CL-1',
        summary: 'mcp test entry',
        sections: { added: ['a thing'] },
      });
      const parsed = parseToolText(result);
      assert.equal(typeof parsed.inserted_at, 'number');
      assert.equal(parsed.idempotent, false);
      assert.equal(parsed.surface, '2026-05-02');
      assert.ok(existsSync(join(cwd, 'CHANGELOG.md')));
      const text = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf-8');
      assert.match(text, /### MCP-CL-1 — mcp test entry/);
      assert.match(text, /\*\*Added:\*\*/);
    } finally {
      client.close();
    }
  });

  test('round-trip: add then get returns the entry just written', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      await client.callTool('add_changelog_entry', {
        date_or_version: '2026-05-02',
        code: 'MCP-CL-2',
        summary: 'roundtrip',
      });
      const getResult = await client.callTool('get_changelog_entries', { code: 'MCP-CL-2' });
      const parsed = parseToolText(getResult);
      assert.equal(parsed.count, 1);
      assert.equal(parsed.entries[0].code, 'MCP-CL-2');
      assert.equal(parsed.entries[0].summary, 'roundtrip');
      assert.equal(parsed.entries[0].date_or_version, '2026-05-02');
    } finally {
      client.close();
    }
  });
});
