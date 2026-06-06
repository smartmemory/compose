import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimateTokens,
  scanSurface,
  dedupeSkills,
  classifyComponent,
  buildReport,
  auditContextBudget,
  nameReferenced,
  parseToolCounts,
} from '../lib/context-budget.js';

// ---------- Helpers ----------
function newDir(prefix = 'cb-') {
  return mkdtempSync(join(tmpdir(), prefix));
}
function write(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
  return full;
}

// A realistic fixture surface: home (~/.claude) + project (cwd).
function buildFixture() {
  const home = newDir('cb-home-');
  const cwd = newDir('cb-cwd-');

  // Agents (project)
  write(cwd, '.claude/agents/explorer.md', '# Explorer\n'.repeat(50));
  write(cwd, '.claude/agents/architect.md', '# Architect\n'.repeat(120)); // >200 lines? no — flag tested separately

  // Skills — one duplicated identically across home + project surfaces
  const dupBody = '# Compose Skill\n' + 'line of skill body\n'.repeat(300);
  write(home, '.claude/skills/compose/SKILL.md', dupBody);
  write(cwd, '.claude/skills/compose/SKILL.md', dupBody); // identical duplicate
  write(home, '.claude/skills/rust-patterns/SKILL.md', '# Rust Patterns\n' + 'x\n'.repeat(500)); // domain, >400 lines
  write(cwd, '.claude/skills/context-budget/SKILL.md', '# Context Budget\n' + 'y\n'.repeat(80));

  // Rules
  write(home, '.claude/rules/code-standards.md', '# Code Standards\n' + 'r\n'.repeat(40));
  write(home, '.claude/rules/legacy-overlap.md', '# Code Standards\n' + 'r\n'.repeat(40)); // overlaps code-standards

  // CLAUDE.md chain — mentions the "compose" skill by name => always
  write(home, '.claude/CLAUDE.md', 'Global rules. Use the compose skill for lifecycles.');
  write(cwd, 'CLAUDE.md', 'Project: uses /context-budget and compose.');

  // MCP config
  writeFileSync(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        compose: { command: 'node', args: ['./server/compose-mcp.js'] },
        bashwrap: { command: 'gh', args: ['api'] }, // wraps a simple CLI
      },
    }),
    'utf-8'
  );

  return { home, cwd, mcpConfigPath: join(cwd, '.mcp.json') };
}

// ---------- estimateTokens ----------
test('estimateTokens is deterministic and roughly chars/4', () => {
  const s = 'hello world this is a test string for token estimation';
  assert.equal(estimateTokens(s), estimateTokens(s)); // deterministic
  assert.equal(estimateTokens(s), Math.ceil(s.length / 4));
});

test('estimateTokens is monotonic with length', () => {
  const a = 'short';
  const b = 'short' + ' and quite a bit longer than before';
  assert.ok(estimateTokens(b) > estimateTokens(a));
});

test('estimateTokens lands within ±25% of a word-count×1.3 reference', () => {
  // A paragraph of natural prose; cross-check the chars/4 heuristic against words*1.3.
  const prose =
    'The quick brown fox jumps over the lazy dog while the slow green turtle ' +
    'watches from the riverbank and considers whether to join the morning run.';
  const words = prose.trim().split(/\s+/).length;
  const reference = words * 1.3;
  const est = estimateTokens(prose);
  const ratio = est / reference;
  assert.ok(ratio > 0.75 && ratio < 1.25, `ratio ${ratio} out of ±25% (est ${est}, ref ${reference})`);
});

test('estimateTokens handles empty string', () => {
  assert.equal(estimateTokens(''), 0);
});

// ---------- scanSurface ----------
test('scanSurface inventories every surface kind', () => {
  const fx = buildFixture();
  const components = scanSurface({ ...fx, toolCounts: { compose: 30 } });

  const kinds = new Set(components.map((c) => c.kind));
  for (const k of ['agent', 'skill', 'rule', 'mcp-server', 'claude-md']) {
    assert.ok(kinds.has(k), `missing kind ${k}`);
  }

  // Two agents discovered
  assert.equal(components.filter((c) => c.kind === 'agent').length, 2);

  // Every component has tokens >= 0 and a line count
  for (const c of components) {
    assert.equal(typeof c.tokens, 'number');
    assert.ok(c.lines >= 0);
    assert.ok(c.path && c.label);
  }
});

test('scanSurface estimates MCP server tokens from toolCounts (~500/tool) and flags unknowns', () => {
  const fx = buildFixture();
  const components = scanSurface({ ...fx, toolCounts: { compose: 30 } });
  const compose = components.find((c) => c.kind === 'mcp-server' && c.label.includes('compose'));
  assert.equal(compose.tokens, 500 * 30);

  const unknown = components.find((c) => c.kind === 'mcp-server' && c.label.includes('bashwrap'));
  assert.equal(unknown.tokens, 0);
  assert.ok(unknown.flags.includes('tool-count-unknown'));
});

test('scanSurface flags MCP servers that wrap a simple CLI', () => {
  const fx = buildFixture();
  const components = scanSurface({ ...fx, toolCounts: {} });
  const wrap = components.find((c) => c.kind === 'mcp-server' && c.label.includes('bashwrap'));
  assert.ok(wrap.flags.includes('wraps-simple-cli'));
});

// ---------- dedupeSkills ----------
test('dedupeSkills collapses identical skill copies across surfaces', () => {
  const fx = buildFixture();
  const components = scanSurface({ ...fx, toolCounts: {} });
  const deduped = dedupeSkills(components);

  const composeSkills = deduped.filter(
    (c) => c.kind === 'skill' && c.label.includes('compose') && !c.duplicateOf
  );
  assert.equal(composeSkills.length, 1, 'identical compose skill counted once');

  // The duplicate is still present but marked, with zeroed tokens so totals do not double-count.
  const marked = deduped.filter((c) => c.duplicateOf);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].tokens, 0);
});

// ---------- nameReferenced (word-boundary matching) ----------
test('nameReferenced matches whole words, not substrings', () => {
  assert.ok(nameReferenced('compose', 'use the compose skill for lifecycles'));
  assert.ok(!nameReferenced('compose', 'stratum will decompose the goal'));
  assert.ok(!nameReferenced('compose', 'the plan is composed of phases'));
});

test('nameReferenced tolerates hyphen/space variants', () => {
  assert.ok(nameReferenced('code-standards', 'follow our code standards please'));
  assert.ok(nameReferenced('code-standards', 'see rules/code-standards.md'));
  assert.ok(nameReferenced('context-budget', 'run the contextbudget audit'));
  assert.ok(!nameReferenced('code-standards', 'nothing relevant'));
});

// ---------- parseToolCounts (input hardening) ----------
test('parseToolCounts rejects non-finite and negative values', () => {
  const r = parseToolCounts('compose=30,empty=,bad=abc,neg=-5,ok=12');
  assert.equal(r.compose, 30);
  assert.equal(r.ok, 12);
  assert.ok(!('empty' in r), 'empty value dropped, not coerced to 0');
  assert.ok(!('bad' in r), 'NaN value dropped');
  assert.ok(!('neg' in r), 'negative value dropped');
});

test('scanSurface treats a NaN tool count as unknown, not a NaN token total', () => {
  const fx = buildFixture();
  const components = scanSurface({ ...fx, toolCounts: { compose: NaN } });
  const compose = components.find((c) => c.kind === 'mcp-server' && c.label.includes('compose'));
  assert.equal(compose.tokens, 0);
  assert.ok(compose.flags.includes('tool-count-unknown'));
  const report = buildReport(components);
  assert.ok(Number.isFinite(report.totalTokens), 'totalTokens stays finite');
});

test('scanSurface treats a negative tool count as unknown (library API path)', () => {
  const fx = buildFixture();
  const components = scanSurface({ ...fx, toolCounts: { compose: -5 } });
  const compose = components.find((c) => c.kind === 'mcp-server' && c.label.includes('compose'));
  assert.equal(compose.tokens, 0);
  assert.ok(compose.flags.includes('tool-count-unknown'));
  assert.ok(compose.tokens >= 0, 'no negative token totals');
});

// ---------- classifyComponent ----------
test('classifyComponent: skill named in CLAUDE.md chain => always', () => {
  const ctx = { claudeMdText: 'use the compose skill', projectType: 'node' };
  const r = classifyComponent({ kind: 'skill', label: 'skill:compose', tokens: 100 }, ctx);
  assert.equal(r.bucket, 'always');
  assert.ok(r.reason);
});

test('classifyComponent: unreferenced domain skill => sometimes', () => {
  const ctx = { claudeMdText: 'nothing relevant here', projectType: 'node' };
  const r = classifyComponent({ kind: 'skill', label: 'skill:rust-patterns', tokens: 100 }, ctx);
  assert.equal(r.bucket, 'sometimes');
});

test('classifyComponent: overlapping rule => rarely', () => {
  const ctx = { claudeMdText: 'nothing', projectType: 'node' };
  const r = classifyComponent(
    { kind: 'rule', label: 'rule:legacy-overlap', tokens: 100, flags: ['overlap'] },
    ctx
  );
  assert.equal(r.bucket, 'rarely');
});

// ---------- buildReport ----------
test('buildReport partitions buckets, ranks top reclaims, totals de-duped tokens', () => {
  const fx = buildFixture();
  const raw = scanSurface({ ...fx, toolCounts: { compose: 30 } });
  const deduped = dedupeSkills(raw);
  const report = buildReport(deduped);

  // Buckets partition every component
  const bucketed =
    report.buckets.always.length + report.buckets.sometimes.length + report.buckets.rarely.length;
  assert.equal(bucketed, deduped.length);

  // Total equals sum of all (deduped) component tokens
  const sum = deduped.reduce((a, c) => a + c.tokens, 0);
  assert.equal(report.totalTokens, sum);

  // topReclaims are descending by tokens and drawn from sometimes+rarely only
  assert.ok(report.topReclaims.length <= 5);
  for (let i = 1; i < report.topReclaims.length; i++) {
    assert.ok(report.topReclaims[i - 1].tokens >= report.topReclaims[i].tokens);
  }
  for (const r of report.topReclaims) {
    assert.notEqual(r.bucket, 'always');
  }

  // Rendered text exists and mentions the total
  assert.ok(typeof report.text === 'string' && report.text.includes('CONTEXT BUDGET'));
});

// ---------- auditContextBudget (golden flow) ----------
test('auditContextBudget golden flow: scan -> dedupe -> classify -> report', () => {
  const fx = buildFixture();
  const report = auditContextBudget({ ...fx, toolCounts: { compose: 30 } });

  assert.ok(report.totalTokens > 0);
  assert.ok(report.text.includes('CONTEXT BUDGET'));
  // The compose skill should be classified always (named in CLAUDE.md), counted once.
  const composeEntries = [
    ...report.buckets.always,
    ...report.buckets.sometimes,
    ...report.buckets.rarely,
  ].filter((c) => c.kind === 'skill' && c.label.includes('compose') && !c.duplicateOf);
  assert.equal(composeEntries.length, 1);
  assert.equal(composeEntries[0].bucket, 'always');
});

test('auditContextBudget tolerates a missing surface (no agents dir)', () => {
  const home = newDir('cb-home-');
  const cwd = newDir('cb-cwd-');
  write(cwd, 'CLAUDE.md', 'minimal project');
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');
  const report = auditContextBudget({ home, cwd, mcpConfigPath: join(cwd, '.mcp.json') });
  assert.ok(report.totalTokens >= 0);
  assert.ok(Array.isArray(report.buckets.always));
});
