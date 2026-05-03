/**
 * completion-writer-mcp.test.js — end-to-end tests for COMP-MCP-COMPLETION.
 * Spawns the MCP server, speaks JSON-RPC over stdio.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { writeFeature } from '../lib/feature-json.js';

const ROOT       = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(ROOT, 'server', 'compose-mcp.js');

const FULL_SHA_A = 'a'.repeat(40);
const FULL_SHA_B = 'b'.repeat(40);

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
      }, 10000);
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
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-completion-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function seedFeature(cwd, feature) {
  writeFeature(cwd, {
    created: '2026-05-02',
    updated: '2026-05-02',
    phase: 'Phase 1',
    position: 1,
    description: 'test feature',
    ...feature,
  });
}

function parseToolText(result) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`tool returned no text content: ${JSON.stringify(result)}`);
  if (result.isError) return { _isError: true, text };
  return JSON.parse(text);
}

function sabotageRoadmap(cwd) {
  mkdirSync(join(cwd, 'ROADMAP.md'), { recursive: true });
}

describe('compose-mcp completion writer (end-to-end)', () => {
  test('#17 record_completion happy path — return shape correct', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'COMP-1', status: 'PLANNED' });
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('record_completion', {
        feature_code: 'COMP-1',
        commit_sha: FULL_SHA_A,
        tests_pass: true,
        files_changed: ['lib/foo.js'],
        notes: 'clean ship',
        set_status: false,
      });
      assert.ok(!result.isError, `unexpected error: ${result.content?.[0]?.text}`);
      const parsed = parseToolText(result);
      assert.equal(parsed.feature_code, 'COMP-1');
      assert.equal(parsed.completion_id, `COMP-1:${FULL_SHA_A}`);
      assert.equal(parsed.commit_sha, FULL_SHA_A);
      assert.equal(parsed.commit_sha_short, FULL_SHA_A.slice(0, 8));
      assert.equal(parsed.status_flip_partial, false);
      assert.equal(parsed.idempotent, false);
      assert.ok(typeof parsed.recorded_at === 'string');
    } finally {
      client.close();
    }
  });

  test('#18 idempotent replay → idempotent: true', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'COMP-1', status: 'PLANNED' });
    const client = new McpClient(cwd);
    try {
      const args = {
        feature_code: 'COMP-1',
        commit_sha: FULL_SHA_A,
        tests_pass: true,
        files_changed: [],
        set_status: false,
      };
      await client.callTool('record_completion', args);
      const result2 = await client.callTool('record_completion', args);
      assert.ok(!result2.isError, `unexpected error: ${result2.content?.[0]?.text}`);
      const parsed2 = parseToolText(result2);
      assert.equal(parsed2.idempotent, true);
    } finally {
      client.close();
    }
  });

  test('#19 FEATURE_NOT_FOUND: response error contains [FEATURE_NOT_FOUND]', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('record_completion', {
        feature_code: 'MISSING-1',
        commit_sha: FULL_SHA_A,
        tests_pass: true,
        files_changed: [],
        set_status: false,
      });
      assert.ok(result.isError, 'result should be an error');
      const text = result.content?.[0]?.text || '';
      assert.match(text, /\[FEATURE_NOT_FOUND\]/);
    } finally {
      client.close();
    }
  });

  test('#20 STATUS_FLIP_AFTER_COMPLETION_RECORDED (transition rejected): error contains both codes', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'COMP-1', status: 'KILLED' });
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('record_completion', {
        feature_code: 'COMP-1',
        commit_sha: FULL_SHA_A,
        tests_pass: true,
        files_changed: [],
        set_status: true,
      });
      assert.ok(result.isError, 'result should be an error');
      const text = result.content?.[0]?.text || '';
      assert.match(text, /\[STATUS_FLIP_AFTER_COMPLETION_RECORDED\]/,
        `expected [STATUS_FLIP_AFTER_COMPLETION_RECORDED] in: ${text}`);
      // The underlying transition error from feature-writer doesn't set .code,
      // so the MCP wrapper emits "Caused by: <message>" (no code brackets).
      assert.match(text, /Caused by/,
        `expected "Caused by" in: ${text}`);
    } finally {
      client.close();
    }
  });

  test('#20b STATUS_FLIP_AFTER_COMPLETION_RECORDED (ROADMAP partial-write): cause.code is ROADMAP_PARTIAL_WRITE', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'COMP-1', status: 'PLANNED' });
    sabotageRoadmap(cwd);
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('record_completion', {
        feature_code: 'COMP-1',
        commit_sha: FULL_SHA_A,
        tests_pass: true,
        files_changed: [],
        set_status: true,
      });
      assert.ok(result.isError, 'result should be an error');
      const text = result.content?.[0]?.text || '';
      assert.match(text, /\[STATUS_FLIP_AFTER_COMPLETION_RECORDED\]/,
        `expected [STATUS_FLIP_AFTER_COMPLETION_RECORDED] in: ${text}`);
      assert.match(text, /Caused by \[ROADMAP_PARTIAL_WRITE\]:/,
        `expected "Caused by [ROADMAP_PARTIAL_WRITE]:" in: ${text}`);
    } finally {
      client.close();
    }
  });

  test('#21 get_completions filter round-trip — reads back the just-written record', async () => {
    const cwd = freshCwd();
    seedFeature(cwd, { code: 'COMP-1', status: 'PLANNED' });
    const client = new McpClient(cwd);
    try {
      // Write
      await client.callTool('record_completion', {
        feature_code: 'COMP-1',
        commit_sha: FULL_SHA_A,
        tests_pass: true,
        files_changed: ['lib/foo.js'],
        notes: 'test notes',
        set_status: false,
      });

      // Read back
      const getResult = await client.callTool('get_completions', {
        feature_code: 'COMP-1',
      });
      assert.ok(!getResult.isError, `unexpected error: ${getResult.content?.[0]?.text}`);
      const parsed = parseToolText(getResult);
      assert.equal(parsed.count, 1);
      const rec = parsed.completions[0];
      // All documented fields present
      assert.ok('feature_code' in rec, 'feature_code');
      assert.ok('completion_id' in rec, 'completion_id');
      assert.ok('commit_sha' in rec, 'commit_sha');
      assert.ok('commit_sha_short' in rec, 'commit_sha_short');
      assert.ok('tests_pass' in rec, 'tests_pass');
      assert.ok('files_changed' in rec, 'files_changed');
      assert.ok('recorded_at' in rec, 'recorded_at');
      assert.ok('recorded_by' in rec, 'recorded_by');
      assert.equal(rec.notes, 'test notes');
      assert.equal(rec.feature_code, 'COMP-1');
      assert.equal(rec.commit_sha, FULL_SHA_A);
    } finally {
      client.close();
    }
  });
});
