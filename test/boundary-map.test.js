import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseBoundaryMap, validateBoundaryMap } from '../lib/boundary-map.js';

// ---------- Fixtures ----------

const VALID_3_SLICE = `# Some Blueprint

## Boundary Map

### S01: auth primitives
Produces:
  src/lib/auth/types.ts → User, Session, AuthToken (interface)
  src/lib/auth/tokens.ts → generateToken, verifyToken, refreshToken (function)

Consumes: nothing (leaf node)

### S02: HTTP layer
Produces:
  src/server/api/auth/login.ts → loginHandler (function)
  src/server/middleware/auth.ts → authMiddleware (function)

Consumes:
  from S01: src/lib/auth/tokens.ts → generateToken, verifyToken

### S03: client integration
Produces:
  src/client/auth/useAuth.ts → useAuth (hook)

Consumes:
  from S01: src/lib/auth/types.ts → User, Session
  from S02: src/server/api/auth/login.ts → loginHandler
`;

function newRepo() {
  return mkdtempSync(join(tmpdir(), 'bm-'));
}

function writeFile(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// ---------- Parser tests (T01) ----------

test('parseBoundaryMap parses valid 3-slice auth example', () => {
  const r = parseBoundaryMap(VALID_3_SLICE);
  assert.equal(r.parseViolations.length, 0);
  assert.equal(r.slices.length, 3);
  const [s1, s2, s3] = r.slices;
  assert.equal(s1.id, 'S01');
  assert.equal(s1.leaf, true);
  assert.equal(s1.consumes.length, 0);
  assert.equal(s1.produces.length, 2);
  assert.equal(s1.produces[0].kind, 'interface');
  assert.deepEqual(s1.produces[0].symbols, ['User', 'Session', 'AuthToken']);
  assert.equal(s1.produces[1].kind, 'function');
  assert.equal(s2.consumes.length, 1);
  assert.equal(s2.consumes[0].from, 'S01');
  assert.deepEqual(s2.consumes[0].symbols, ['generateToken', 'verifyToken']);
  assert.equal(s3.produces[0].kind, 'hook');
});

test('parseBoundaryMap parses leaf slice via "Consumes: nothing (leaf node)"', () => {
  const r = parseBoundaryMap(VALID_3_SLICE);
  assert.equal(r.slices[0].leaf, true);
  assert.equal(r.slices[0].consumes.length, 0);
});

test('parseBoundaryMap parses sink slice via "Produces: nothing (integration only)"', () => {
  const text = `## Boundary Map

### S01: leaf
Produces:
  a.ts → Foo (interface)

Consumes: nothing

### S02: sink
Produces: nothing (integration only)

Consumes:
  from S01: a.ts → Foo
`;
  const r = parseBoundaryMap(text);
  assert.equal(r.parseViolations.length, 0);
  assert.equal(r.slices[1].sink, true);
  assert.equal(r.slices[1].produces.length, 0);
});

test('parseBoundaryMap accepts U+2192 arrow', () => {
  const text = `## Boundary Map

### S01: a
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = parseBoundaryMap(text);
  assert.equal(r.parseViolations.length, 0);
  assert.equal(r.slices[0].produces[0].symbols[0], 'Foo');
});

test('parseBoundaryMap accepts ASCII -> arrow identically', () => {
  const text = `## Boundary Map

### S01: a
Produces:
  a.ts -> Foo (interface)

Consumes: nothing
`;
  const r = parseBoundaryMap(text);
  assert.equal(r.parseViolations.length, 0);
  assert.equal(r.slices[0].produces[0].symbols[0], 'Foo');
  assert.equal(r.slices[0].produces[0].kind, 'interface');
});

test('parseBoundaryMap flags duplicate slice id', () => {
  const text = `## Boundary Map

### S01: first
Produces:
  a.ts → Foo (interface)

Consumes: nothing

### S01: dup
Produces:
  b.ts → Bar (interface)

Consumes: nothing
`;
  const r = parseBoundaryMap(text);
  const dup = r.parseViolations.find((v) => v.kind === 'duplicate_slice_id');
  assert.ok(dup, 'expected duplicate_slice_id violation');
  assert.equal(dup.scope, 'parse');
});

test('parseBoundaryMap flags missing kind parenthetical on Produces line', () => {
  const text = `## Boundary Map

### S01: a
Produces:
  a.ts → Foo

Consumes: nothing
`;
  const r = parseBoundaryMap(text);
  const mk = r.parseViolations.find((v) => v.kind === 'missing_kind');
  assert.ok(mk, 'expected missing_kind violation');
  assert.equal(mk.scope, 'parse');
});

test('parseBoundaryMap returns empty for blueprint with no Boundary Map', () => {
  const text = `# Some Blueprint\n\n## File Plan\n\nstuff\n`;
  const r = parseBoundaryMap(text);
  assert.deepEqual(r, { slices: [], parseViolations: [] });
});

// ---------- T03: File-Plan-or-disk ----------

const FP_BP_3 = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`new/file.ts\` | new | added thing |
| \`mod/file.ts\` | MODIFY (existing, 119 lines) | edited |

## Boundary Map

### S01: a
Produces:
  new/file.ts → Foo (interface)
  mod/file.ts → Bar (interface)

Consumes: nothing
`;

test('T03 missing_file when file absent from disk and File Plan', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`other.ts\` | new | unrelated |

## Boundary Map

### S01: a
Produces:
  ghost.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const v = r.violations.find((x) => x.kind === 'missing_file');
  assert.ok(v);
  assert.equal(v.scope, 'entry');
  assert.equal(v.slice, 'S01');
  assert.equal(v.file, 'ghost.ts');
});

test('T03 pass when file in File Plan with new action, no disk file', () => {
  const root = newRepo();
  const r = validateBoundaryMap({ blueprintText: FP_BP_3, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_file').length, 0);
});

test('T03 pass when file on disk but no File Plan entry', () => {
  const root = newRepo();
  writeFile(root, 'on-disk.ts', 'export const Foo = 1; // mentions Foo\n');
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`other.ts\` | new | unrelated |

## Boundary Map

### S01: a
Produces:
  on-disk.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_file').length, 0);
});

test('T03 alias "## Files" recognized', () => {
  const root = newRepo();
  const text = `## Files

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_file').length, 0);
  assert.equal(r.warnings.filter((w) => w.kind === 'no_file_plan').length, 0);
});

test('T03 alias "## File-by-File Plan" recognized', () => {
  const root = newRepo();
  const text = `## File-by-File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_file').length, 0);
  assert.equal(r.warnings.filter((w) => w.kind === 'no_file_plan').length, 0);
});

test('T03 action "MODIFY (existing, 119 lines)" normalizes to modify and passes', () => {
  const root = newRepo();
  const r = validateBoundaryMap({ blueprintText: FP_BP_3, repoRoot: root });
  // mod/file.ts in plan as MODIFY with decoration; should not be missing_file
  assert.equal(r.violations.filter((v) => v.kind === 'missing_file' && v.file === 'mod/file.ts').length, 0);
  assert.equal(r.warnings.filter((w) => w.kind === 'unknown_action').length, 0);
});

test('T03 no_file_plan warning emitted exactly once when no heading present', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', 'Foo');
  const text = `## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const w = r.warnings.filter((x) => x.kind === 'no_file_plan');
  assert.equal(w.length, 1);
  assert.equal(w[0].scope, 'blueprint');
  // file-disk fallback: a.ts present, so no missing_file
  assert.equal(r.violations.filter((v) => v.kind === 'missing_file').length, 0);
});

test('parse violations carry no extra `line` field (contract shape)', () => {
  const text = `## Boundary Map

### S01: a
Produces:
  a.ts → Foo

Consumes: nothing
`;
  const r = parseBoundaryMap(text);
  const mk = r.parseViolations.find((v) => v.kind === 'missing_kind');
  assert.ok(mk, 'expected missing_kind violation');
  assert.equal(mk.line, undefined, 'violation must not include `line` field');
  const allowed = new Set(['kind', 'scope', 'slice', 'file', 'symbol', 'message']);
  for (const k of Object.keys(mk)) {
    assert.ok(allowed.has(k), `unexpected violation field: ${k}`);
  }
  // Line number should be folded into the message for debugging
  assert.match(mk.message, /line \d+/);
});

test('unknown_action emits one warning per File Plan row, not per file', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', 'Foo');
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | reference | mentioned only |
| \`a.ts\` | quote | quoted only |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const w = r.warnings.filter((x) => x.kind === 'unknown_action');
  assert.equal(w.length, 2, 'expected one warning per offending row');
});

test('T03 unknown_action warning per row deduped by file', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', 'Foo');
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | reference | mentioned only |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const w = r.warnings.filter((x) => x.kind === 'unknown_action');
  assert.equal(w.length, 1);
  assert.equal(w[0].scope, 'file-plan');
  assert.equal(w[0].file, 'a.ts');
  assert.equal(w[0].slice, undefined);
});

// ---------- T04: Symbol presence ----------

test('T04 missing_symbol when file on disk lacks symbol and not in File Plan', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', '// nothing relevant here\n');
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`b.ts\` | new | unrelated |

## Boundary Map

### S01: s
Produces:
  a.ts → MissingSym (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const v = r.violations.find((x) => x.kind === 'missing_symbol');
  assert.ok(v);
  assert.equal(v.scope, 'entry');
  assert.equal(v.slice, 'S01');
  assert.equal(v.file, 'a.ts');
  assert.equal(v.symbol, 'MissingSym');
});

test('T04 skip when file is File-Plan listed as new (file empty/missing on disk)', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | will be created |

## Boundary Map

### S01: s
Produces:
  a.ts → FutureSym (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_symbol').length, 0);
});

test('T04 skip when file is File-Plan listed as modify', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', '// no symbol here\n');
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | modify | tweaked |

## Boundary Map

### S01: s
Produces:
  a.ts → SoonSym (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_symbol').length, 0);
});

test('T04 pass when file on disk contains symbol substring (even in comment)', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', '// HelloThere is mentioned here\n');
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`b.ts\` | new | unrelated |

## Boundary Map

### S01: s
Produces:
  a.ts → HelloThere (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_symbol').length, 0);
});

// ---------- T05: Topology ----------

test('T05 dangling_consume when from S99 references unknown slice', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes:
  from S99: a.ts → Foo
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const v = r.violations.find((x) => x.kind === 'dangling_consume');
  assert.ok(v);
  assert.equal(v.scope, 'entry');
  assert.equal(v.slice, 'S01');
});

test('T05 forward_reference when S01 consumes from S02 (later)', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |
| \`b.ts\` | new | y |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes:
  from S02: b.ts → Bar

### S02: t
Produces:
  b.ts → Bar (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.ok(r.violations.find((x) => x.kind === 'forward_reference' && x.slice === 'S01'));
});

test('T05 backward edge S02 consumes from S01 passes', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |
| \`b.ts\` | new | y |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing

### S02: t
Produces:
  b.ts → Bar (interface)

Consumes:
  from S01: a.ts → Foo
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((x) => x.kind === 'forward_reference' || x.kind === 'dangling_consume').length, 0);
});

test('T05 self-reference (S01 consumes from S01) flagged as forward_reference', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes:
  from S01: a.ts → Foo
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.ok(r.violations.find((x) => x.kind === 'forward_reference' && x.slice === 'S01'));
});

// ---------- T06: Producer/consumer match ----------

test('T06 pass when consumer symbol is in producer list', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo, Bar (interface)

Consumes: nothing

### S02: t
Produces: nothing

Consumes:
  from S01: a.ts → Foo
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((x) => x.kind === 'producer_consumer_mismatch').length, 0);
});

test('T06 producer_consumer_mismatch when consumed symbol absent from producer set', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing

### S02: t
Produces: nothing

Consumes:
  from S01: a.ts → Bar
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const v = r.violations.find((x) => x.kind === 'producer_consumer_mismatch');
  assert.ok(v);
  assert.equal(v.symbol, 'Bar');
  assert.equal(v.slice, 'S02');
  assert.equal(v.file, 'a.ts');
});

test('T06 producer_consumer_mismatch when consumed file path missing from producer (one per symbol)', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |
| \`other.ts\` | new | y |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing

### S02: t
Produces: nothing

Consumes:
  from S01: other.ts → X, Y
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const vs = r.violations.filter((x) => x.kind === 'producer_consumer_mismatch');
  assert.equal(vs.length, 2);
  const syms = vs.map((v) => v.symbol).sort();
  assert.deepEqual(syms, ['X', 'Y']);
});

test('T06 multi-symbol consume — only missing flagged', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo, Bar (interface)

Consumes: nothing

### S02: t
Produces: nothing

Consumes:
  from S01: a.ts → Foo, Baz
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const vs = r.violations.filter((x) => x.kind === 'producer_consumer_mismatch');
  assert.equal(vs.length, 1);
  assert.equal(vs[0].symbol, 'Baz');
});

// ---------- T07: Orchestrator ----------

test('T07 single-unit blueprint (no Boundary Map) → ok:true, empty arrays', () => {
  const root = newRepo();
  const r = validateBoundaryMap({ blueprintText: '# blank blueprint\n', repoRoot: root });
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.warnings, []);
});

test('T07 warnings-only fixture → ok:true with warnings populated', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', 'Foo');
  const text = `## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length > 0);
  assert.equal(r.violations.length, 0);
});

test('T07 parse violation surfaces in violations with scope:parse', () => {
  const root = newRepo();
  const text = `## Boundary Map

### S01: a
Produces:
  a.ts → Foo

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.ok, false);
  assert.ok(r.violations.find((v) => v.scope === 'parse'));
});

test('T07 entry violation surfaces with scope:entry', () => {
  const root = newRepo();
  const text = `## Boundary Map

### S01: a
Produces:
  ghost.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.ok, false);
  assert.ok(r.violations.find((v) => v.scope === 'entry' && v.kind === 'missing_file'));
});

test('T07 full valid 3-slice fixture → ok:true', () => {
  const root = newRepo();
  // Use an in-memory fixture matching auth example, with files on disk where needed
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`src/lib/auth/types.ts\` | new | x |
| \`src/lib/auth/tokens.ts\` | new | x |
| \`src/server/api/auth/login.ts\` | new | x |
| \`src/server/middleware/auth.ts\` | new | x |
| \`src/client/auth/useAuth.ts\` | new | x |

${VALID_3_SLICE.split('## Boundary Map')[1] ? '## Boundary Map' + VALID_3_SLICE.split('## Boundary Map')[1] : ''}
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.violations.length, 0);
  assert.equal(r.warnings.length, 0);
});

// ---------- Locator population on entry violations ----------

test('missing_file emits one violation per (slice, file, symbol)', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`other.ts\` | new | unrelated |

## Boundary Map

### S01: a
Produces:
  ghost.ts → Foo, Bar, Baz (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const vs = r.violations.filter((v) => v.kind === 'missing_file');
  assert.equal(vs.length, 3, 'expected one violation per declared symbol');
  for (const v of vs) {
    assert.equal(v.slice, 'S01');
    assert.equal(v.file, 'ghost.ts');
    assert.ok(v.symbol, 'symbol should be populated');
  }
  const syms = vs.map((v) => v.symbol).sort();
  assert.deepEqual(syms, ['Bar', 'Baz', 'Foo']);
});

test('dangling_consume populates file and symbol locators', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes:
  from S99: dep.ts → Alpha, Beta
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const vs = r.violations.filter((v) => v.kind === 'dangling_consume');
  assert.equal(vs.length, 2);
  for (const v of vs) {
    assert.equal(v.slice, 'S01');
    assert.equal(v.file, 'dep.ts');
    assert.ok(v.symbol);
  }
  const syms = vs.map((v) => v.symbol).sort();
  assert.deepEqual(syms, ['Alpha', 'Beta']);
});

test('forward_reference populates file and symbol locators', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | x |
| \`b.ts\` | new | y |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes:
  from S02: b.ts → Bar, Qux

### S02: t
Produces:
  b.ts → Bar, Qux (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  const vs = r.violations.filter((v) => v.kind === 'forward_reference');
  assert.equal(vs.length, 2);
  for (const v of vs) {
    assert.equal(v.slice, 'S01');
    assert.equal(v.file, 'b.ts');
    assert.ok(v.symbol);
  }
});

test('malformed_after_nothing flagged when entry follows Consumes: nothing', () => {
  const text = `## Boundary Map

### S01: a
Produces:
  a.ts → Foo (interface)

Consumes: nothing
  from S00: foo.ts → Bar
`;
  const r = parseBoundaryMap(text);
  const v = r.parseViolations.find((x) => x.kind === 'malformed_after_nothing');
  assert.ok(v, 'expected malformed_after_nothing parse violation');
  assert.equal(v.scope, 'parse');
  assert.equal(v.slice, 'S01');
});

test('File Plan duplicate row — write action wins', () => {
  const root = newRepo();
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | new | will be created |
| \`a.ts\` | reference | also referenced |

## Boundary Map

### S01: s
Produces:
  a.ts → FutureSym (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.violations.filter((v) => v.kind === 'missing_symbol' && v.file === 'a.ts').length, 0);
  assert.equal(r.violations.filter((v) => v.kind === 'missing_file' && v.file === 'a.ts').length, 0);
});

test('T07 warnings never set ok:false', () => {
  const root = newRepo();
  writeFile(root, 'a.ts', 'Foo');
  const text = `## File Plan

| File | Action | Purpose |
|------|--------|---------|
| \`a.ts\` | reference | not a write |

## Boundary Map

### S01: s
Produces:
  a.ts → Foo (interface)

Consumes: nothing
`;
  const r = validateBoundaryMap({ blueprintText: text, repoRoot: root });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.find((w) => w.kind === 'unknown_action'));
});
