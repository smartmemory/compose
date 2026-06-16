import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAgentDefs } from '../lib/install-agent-defs.js';

// COMP-AGENT-VENDOR-1: the vendored compose-explorer/compose-architect agents
// the compose SKILL.md depends on must (a) exist and (b) be installable.
const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(resolve(__dirname, '..'), '.claude', 'agents');

test('vendored agent defs exist with frontmatter name matching filename + tools declared', () => {
  for (const name of ['compose-explorer', 'compose-architect']) {
    const p = join(AGENTS_DIR, `${name}.md`);
    assert.ok(existsSync(p), `${name}.md must exist`);
    const src = readFileSync(p, 'utf-8');
    assert.match(src, new RegExp(`^---[\\s\\S]*?\\nname:\\s*${name}\\b`), `${name}.md frontmatter name must match`);
    assert.match(src, /\ntools:\s*\S+/, `${name}.md must declare tools`);
  }
});

test('installAgentDefs copies *.md (only), mkdir -p dest, idempotent, reports names', () => {
  const src = mkdtempSync(join(tmpdir(), 'agdefs-src-'));
  writeFileSync(join(src, 'a.md'), '---\nname: a\n---\nA');
  writeFileSync(join(src, 'b.md'), '---\nname: b\n---\nB');
  writeFileSync(join(src, 'ignore.txt'), 'nope');
  const dest = join(mkdtempSync(join(tmpdir(), 'agdefs-dest-')), 'agents'); // not pre-created

  const first = installAgentDefs(src, dest);
  assert.deepEqual(first.sort(), ['a', 'b']);
  assert.ok(existsSync(join(dest, 'a.md')) && existsSync(join(dest, 'b.md')));
  assert.ok(!existsSync(join(dest, 'ignore.txt')), 'non-.md files are not copied');

  const second = installAgentDefs(src, dest); // idempotent
  assert.deepEqual(second.sort(), ['a', 'b']);
  assert.equal(readdirSync(dest).filter(f => f.endsWith('.md')).length, 2);
});

test('installAgentDefs is a no-op ([]) for an absent source dir', () => {
  assert.deepEqual(installAgentDefs(join(tmpdir(), 'nope-xyz-123'), join(tmpdir(), 'whatever')), []);
});

test('the real .claude/agents dir installs exactly the two compose agents', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 'agdefs-real-')), 'agents');
  assert.deepEqual(installAgentDefs(AGENTS_DIR, dest).sort(), ['compose-architect', 'compose-explorer']);
});
