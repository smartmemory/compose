/**
 * feature-writer-mcp.test.js — end-to-end tests for the new MCP writer tools
 * (COMP-MCP-ROADMAP-WRITER T4). Spawns the MCP server as a child process,
 * speaks JSON-RPC over stdio, asserts the tools are reachable and functional.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
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
    // The MCP server sets up handlers via the SDK and may require an
    // initialize call. We bypass by sending tools/list directly which the
    // SDK supports.
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
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-roadmap-writer-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function parseToolText(result) {
  // Tools return { content: [{type:'text', text: JSON.stringify(...)}] }
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

describe('compose-mcp roadmap writers (end-to-end)', () => {
  test('tools/list includes the three new tools', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.request('tools/list', {});
      const names = result.tools.map(t => t.name);
      assert.ok(names.includes('add_roadmap_entry'));
      assert.ok(names.includes('set_feature_status'));
      assert.ok(names.includes('roadmap_diff'));
    } finally {
      client.close();
    }
  });

  test('add_roadmap_entry creates feature.json and regenerates ROADMAP', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('add_roadmap_entry', {
        code: 'MCP-T-1',
        description: 'mcp test feature',
        phase: 'Phase 0: Test',
        complexity: 'S',
      });
      const parsed = parseToolText(result);
      assert.equal(parsed.code, 'MCP-T-1');
      assert.equal(parsed.phase, 'Phase 0: Test');
      assert.ok(existsSync(join(cwd, 'docs', 'features', 'MCP-T-1', 'feature.json')));
      assert.ok(existsSync(join(cwd, 'ROADMAP.md')));
      const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
      assert.match(roadmap, /MCP-T-1/);
    } finally {
      client.close();
    }
  });

  test('set_feature_status flips a status', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      await client.callTool('add_roadmap_entry', {
        code: 'MCP-T-2', description: 'd', phase: 'P',
      });
      const result = await client.callTool('set_feature_status', {
        code: 'MCP-T-2', status: 'IN_PROGRESS', reason: 'starting',
      });
      const parsed = parseToolText(result);
      assert.equal(parsed.from, 'PLANNED');
      assert.equal(parsed.to, 'IN_PROGRESS');
    } finally {
      client.close();
    }
  });

  test('roadmap_diff returns added + status_changed', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      await client.callTool('add_roadmap_entry', { code: 'MCP-T-3', description: 'd', phase: 'P' });
      await client.callTool('set_feature_status', { code: 'MCP-T-3', status: 'IN_PROGRESS' });
      const result = await client.callTool('roadmap_diff', { since: '24h' });
      const parsed = parseToolText(result);
      assert.deepEqual(parsed.added, ['MCP-T-3']);
      assert.equal(parsed.status_changed.length, 1);
      assert.deepEqual(parsed.status_changed[0], { code: 'MCP-T-3', from: 'PLANNED', to: 'IN_PROGRESS' });
    } finally {
      client.close();
    }
  });

  test('invalid input surfaces as MCP error response', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.callTool('set_feature_status', { code: 'GHOST-1', status: 'COMPLETE' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /not found/);
    } finally {
      client.close();
    }
  });
});
