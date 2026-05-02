/**
 * feature-linker-mcp.test.js — end-to-end smoke for the linker tools
 * (COMP-MCP-ARTIFACT-LINKER T3).
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
  callTool(name, args) { return this.request('tools/call', { name, arguments: args }); }
  close() { this.proc.kill(); }
}

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-linker-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}
function parseToolText(result) {
  return JSON.parse(result.content[0].text);
}
function touch(cwd, rel) {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'x');
}

describe('compose-mcp linker tools (end-to-end)', () => {
  test('tools/list includes the four new linker tools', async () => {
    const cwd = freshCwd();
    const c = new McpClient(cwd);
    try {
      const r = await c.request('tools/list', {});
      const names = r.tools.map(t => t.name);
      for (const n of ['link_artifact', 'link_features', 'get_feature_artifacts', 'get_feature_links']) {
        assert.ok(names.includes(n), `tools/list should include ${n}`);
      }
    } finally { c.close(); }
  });

  test('full round-trip: add → link → get', async () => {
    const cwd = freshCwd();
    const c = new McpClient(cwd);
    try {
      await c.callTool('add_roadmap_entry', { code: 'MX-1', description: 'd', phase: 'P' });
      await c.callTool('add_roadmap_entry', { code: 'MX-2', description: 'd', phase: 'P' });
      touch(cwd, 'docs/features/MX-1/snap.md');

      const linkA = await c.callTool('link_artifact', {
        feature_code: 'MX-1', artifact_type: 'snapshot', path: 'docs/features/MX-1/snap.md',
      });
      assert.equal(parseToolText(linkA).feature_code, 'MX-1');

      const linkF = await c.callTool('link_features', {
        from_code: 'MX-1', to_code: 'MX-2', kind: 'depends_on',
      });
      assert.equal(parseToolText(linkF).kind, 'depends_on');

      const arts = await c.callTool('get_feature_artifacts', { feature_code: 'MX-1' });
      const artsP = parseToolText(arts);
      assert.equal(artsP.linked.length, 1);
      assert.equal(artsP.linked[0].type, 'snapshot');
      assert.equal(artsP.linked[0].exists, true);

      const links = await c.callTool('get_feature_links', { feature_code: 'MX-1' });
      const linksP = parseToolText(links);
      assert.equal(linksP.outgoing.length, 1);
      assert.equal(linksP.outgoing[0].to_code, 'MX-2');

      const incoming = await c.callTool('get_feature_links', { feature_code: 'MX-2', direction: 'incoming' });
      const incomingP = parseToolText(incoming);
      assert.equal(incomingP.incoming.length, 1);
      assert.equal(incomingP.incoming[0].from_code, 'MX-1');
    } finally { c.close(); }
  });

  test('invalid input surfaces as MCP error', async () => {
    const cwd = freshCwd();
    const c = new McpClient(cwd);
    try {
      const r = await c.callTool('link_features', {
        from_code: 'GHOST-1', to_code: 'OTHER-1', kind: 'related',
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /not found/);
    } finally { c.close(); }
  });
});
