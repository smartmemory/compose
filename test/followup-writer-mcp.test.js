/**
 * followup-writer-mcp.test.js — MCP wrapper smoke test for propose_followup
 * (COMP-MCP-FOLLOWUP).
 */
import { test, describe } from 'node:test';
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
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-followup-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

function parseToolText(result) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

describe('compose-mcp propose_followup (end-to-end)', () => {
  test('tools/list includes propose_followup', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const result = await client.request('tools/list', {});
      const names = result.tools.map(t => t.name);
      assert.ok(names.includes('propose_followup'));
    } finally {
      client.close();
    }
  });

  test('propose_followup files a numbered follow-up end-to-end', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      // Seed parent
      await client.callTool('add_roadmap_entry', {
        code: 'MCP-PAR-1',
        description: 'parent',
        phase: 'Phase 0',
      });

      // File follow-up
      const result = await client.callTool('propose_followup', {
        parent_code: 'MCP-PAR-1',
        description: 'follow-up via mcp',
        rationale: 'review surfaced a missing edge case',
      });
      const parsed = parseToolText(result);
      assert.equal(parsed.code, 'MCP-PAR-1-1');
      assert.equal(parsed.parent_code, 'MCP-PAR-1');
      assert.equal(parsed.link.kind, 'surfaced_by');
      assert.equal(parsed.link.from_code, 'MCP-PAR-1-1');
      assert.equal(parsed.link.to_code, 'MCP-PAR-1');

      // Verify on-disk artifacts
      assert.ok(existsSync(join(cwd, 'docs', 'features', 'MCP-PAR-1-1', 'feature.json')));
      const designPath = join(cwd, 'docs', 'features', 'MCP-PAR-1-1', 'design.md');
      assert.ok(existsSync(designPath));
      const design = readFileSync(designPath, 'utf-8');
      assert.match(design, /## Why/);
      assert.match(design, /review surfaced a missing edge case/);

      // ROADMAP regenerated
      const roadmap = readFileSync(join(cwd, 'ROADMAP.md'), 'utf-8');
      assert.match(roadmap, /MCP-PAR-1-1/);
    } finally {
      client.close();
    }
  });
});
