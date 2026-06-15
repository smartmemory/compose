/**
 * COMP-MIGRATE-ON-UPGRADE — state-migration runner tests.
 * Pure-transform unit tests + golden runner tests over a mkdtemp workspace.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const {
  MIGRATIONS, runStateMigrations, readMigrationState, summarizeMigrationReport,
  migrateVisionState, migrateVisionItemFeatureCode, normalizeGateOutcome,
} = await import(`${REPO_ROOT}/lib/state-migrations.js`)

// --- helpers ---------------------------------------------------------------

function mkWorkspace({ tracker, featuresDir = 'docs/features' } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'compose-statemig-'))
  mkdirSync(join(ws, '.compose', 'data'), { recursive: true })
  const cfg = { version: 2, capabilities: { lifecycle: true } }
  if (tracker) cfg.tracker = tracker
  if (featuresDir !== 'docs/features') cfg.paths = { features: featuresDir }
  writeFileSync(join(ws, '.compose', 'compose.json'), JSON.stringify(cfg, null, 2))
  return ws
}

function seedFeature(ws, code, obj, featuresDir = 'docs/features') {
  const dir = join(ws, featuresDir, code)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'feature.json'), JSON.stringify({ code, ...obj }, null, 2) + '\n')
  return join(dir, 'feature.json')
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'))
const findMig = (id) => MIGRATIONS.find((m) => m.id === id)
// Latest stateVersion across all registered migrations — the stamp a full run
// reaches. Computed (not hardcoded) so adding a migration doesn't break the
// feature-focused golden tests below.
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version))

// --- unit: pure transform --------------------------------------------------

test('normalize-complexity: maps legacy free-text to the S/M/L/XL enum', () => {
  const m = findMig('normalize-complexity')
  const cases = [['high', 'L'], ['medium', 'M'], ['low', 'S'], ['HIGH', 'L'], [' Large ', 'L'], ['xl', 'XL']]
  for (const [input, expected] of cases) {
    const r = m.migrateFeature({ code: 'X', complexity: input })
    assert.equal(r.changed, true, `${input} should change`)
    assert.equal(r.feature.complexity, expected, `${input} → ${expected}`)
  }
})

test('normalize-complexity: drops null and unmappable values', () => {
  const m = findMig('normalize-complexity')
  for (const bad of [null, 'frobnitz', {}]) {
    const r = m.migrateFeature({ code: 'X', complexity: bad, status: 'COMPLETE' })
    assert.equal(r.changed, true)
    assert.equal('complexity' in r.feature, false)
    assert.equal(r.feature.status, 'COMPLETE')
  }
})

test('normalize-complexity: leaves valid complexity untouched + idempotent', () => {
  const m = findMig('normalize-complexity')
  for (const c of ['S', 'M', 'L', 'XL', 3]) {
    const r = m.migrateFeature({ code: 'X', complexity: c })
    assert.equal(r.changed, false)
    assert.equal(r.feature.complexity, c)
  }
  // absent key
  assert.equal(m.migrateFeature({ code: 'X' }).changed, false)
  // idempotent: high → L, then L is stable
  const once = m.migrateFeature({ code: 'X', complexity: 'high' })
  const twice = m.migrateFeature(once.feature)
  assert.equal(twice.changed, false)
  assert.equal(twice.feature.complexity, 'L')
})

// --- golden: runner --------------------------------------------------------

test('runner: migrates null-complexity, leaves others, stamps, idempotent re-run', () => {
  const ws = mkWorkspace()
  try {
    const bad = seedFeature(ws, 'COMP-UI-3', { complexity: null, status: 'COMPLETE' })
    const ok = seedFeature(ws, 'GOOD-1', { complexity: 'M', status: 'COMPLETE' })
    const plain = seedFeature(ws, 'GOOD-2', { status: 'PLANNED' })

    const r1 = runStateMigrations(ws, {})
    assert.equal(r1.from, 0)
    assert.equal(r1.to, LATEST)
    assert.equal(r1.parseErrors.length, 0)
    const complexityMig = r1.perMigration.find((m) => m.id === 'normalize-complexity')
    assert.deepEqual(complexityMig.touched, ['COMP-UI-3'])

    assert.equal('complexity' in readJson(bad), false, 'null complexity dropped')
    assert.equal(readJson(ok).complexity, 'M', 'valid complexity untouched')
    assert.equal('complexity' in readJson(plain), false, 'absent stays absent')
    assert.equal(readMigrationState(ws).stateVersion, LATEST, 'stamp advanced')

    // Re-run is a no-op (no pending migrations)
    const r2 = runStateMigrations(ws, {})
    assert.equal(r2.noop, true)
    assert.equal(r2.to, LATEST)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: honors paths.features override', () => {
  const ws = mkWorkspace({ featuresDir: 'specs/feat' })
  try {
    const bad = seedFeature(ws, 'X-1', { complexity: null }, 'specs/feat')
    const r = runStateMigrations(ws, {})
    assert.equal(r.to, LATEST)
    const complexityMig = r.perMigration.find((m) => m.id === 'normalize-complexity')
    assert.deepEqual(complexityMig.touched, ['X-1'])
    assert.equal('complexity' in readJson(bad), false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: unparseable feature.json is reported but does NOT block stamp (convergence)', () => {
  const ws = mkWorkspace()
  try {
    const bad = seedFeature(ws, 'COMP-UI-4', { complexity: null })
    // corrupt a second feature.json
    const corruptDir = join(ws, 'docs/features', 'BROKEN-1')
    mkdirSync(corruptDir, { recursive: true })
    const corruptPath = join(corruptDir, 'feature.json')
    writeFileSync(corruptPath, '{ this is not json')

    const r = runStateMigrations(ws, {})
    assert.equal(r.to, LATEST, 'stamp still advances despite corrupt file')
    assert.equal(r.parseErrors.length, 1)
    assert.equal(r.parseErrors[0].path, corruptPath)
    assert.equal('complexity' in readJson(bad), false, 'good file still migrated')
    assert.equal(readMigrationState(ws).stateVersion, LATEST)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: dryRun reports plan, writes nothing, no state file', () => {
  const ws = mkWorkspace()
  try {
    const bad = seedFeature(ws, 'COMP-UI-5', { complexity: null })
    const r = runStateMigrations(ws, { dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(r.to, LATEST)
    const complexityMig = r.perMigration.find((m) => m.id === 'normalize-complexity')
    assert.deepEqual(complexityMig.touched, ['COMP-UI-5'])
    assert.equal(readJson(bad).complexity, null, 'file untouched in dry-run')
    assert.equal(existsSync(join(ws, '.compose', 'data', 'migration-state.json')), false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: a throwing migration aborts without advancing the stamp', () => {
  const ws = mkWorkspace()
  try {
    seedFeature(ws, 'A-1', { complexity: null })
    // Inject a faulty migration AFTER the real ones (higher version).
    MIGRATIONS.push({
      version: 999, id: 'faulty-test-only', describe: 'throws',
      migrateFeature() { throw new Error('boom') },
    })
    assert.throws(() => runStateMigrations(ws, {}), /boom/)
    assert.equal(readMigrationState(ws).stateVersion, 0, 'stamp NOT advanced on migration-code fault')
  } finally {
    const i = MIGRATIONS.findIndex((m) => m.id === 'faulty-test-only')
    if (i !== -1) MIGRATIONS.splice(i, 1)
    rmSync(ws, { recursive: true, force: true })
  }
})

test('normalize-complexity: total on non-object parseable JSON (scalar/array)', () => {
  const m = findMig('normalize-complexity')
  for (const v of ['x', 3, true, null, ['a'], []]) {
    const r = m.migrateFeature(v)
    assert.equal(r.changed, false, `${JSON.stringify(v)} should not change`)
    assert.deepEqual(r.feature, v)
  }
})

test('runner: unreadable compose.json is skipped (not assumed local)', () => {
  const ws = mkWorkspace()
  try {
    writeFileSync(join(ws, '.compose', 'compose.json'), '{ broken json')
    const bad = seedFeature(ws, 'Q-1', { complexity: 'high' })
    const r = runStateMigrations(ws, {})
    assert.equal(r.skipped, 'unreadable-config')
    assert.equal(readJson(bad).complexity, 'high', 'untouched when config unreadable')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: github-tracker workspace is skipped', () => {
  const ws = mkWorkspace({ tracker: { provider: 'github', github: { repo: 'o/r' } } })
  try {
    const bad = seedFeature(ws, 'Z-1', { complexity: null })
    const r = runStateMigrations(ws, {})
    assert.equal(r.skipped, 'non-local-tracker')
    assert.equal(readJson(bad).complexity, null, 'untouched on non-local tracker')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: non-workspace cwd is skipped (no stray state file)', () => {
  const ws = mkdtempSync(join(tmpdir(), 'compose-noworkspace-'))
  try {
    const r = runStateMigrations(ws, {})
    assert.equal(r.skipped, 'no-workspace')
    assert.equal(existsSync(join(ws, '.compose')), false)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('summarizeMigrationReport: human one-liners', () => {
  assert.equal(summarizeMigrationReport({ skipped: 'no-workspace' }), null)
  assert.equal(summarizeMigrationReport({ noop: true, to: 1 }), 'state up to date (v1)')
  const s = summarizeMigrationReport({
    to: 1, dryRun: false, perMigration: [{ id: 'a', version: 1, touched: ['X', 'Y'] }], parseErrors: [],
  })
  assert.match(s, /migrated 2 feature\.json across 1 migration\(s\) → stateVersion 1/)
})

test('summarizeMigrationReport: includes a vision clause when a vision migration ran', () => {
  const s = summarizeMigrationReport({
    to: 2, dryRun: false, parseErrors: [], perMigration: [
      { id: 'normalize-complexity', version: 1, target: 'feature', touched: ['X'] },
      { id: 'normalize-vision-legacy', version: 2, target: 'vision', touched: ['vision-state.json'] },
    ],
  })
  assert.match(s, /migrated 1 feature\.json across 1 migration\(s\); vision-state migrated across 1 migration\(s\) → stateVersion 2/)
  // vision-only run (feature stamp already current)
  const vOnly = summarizeMigrationReport({
    to: 2, dryRun: false, parseErrors: [], perMigration: [
      { id: 'normalize-vision-legacy', version: 2, target: 'vision', touched: [] },
    ],
  })
  assert.match(vOnly, /vision-state up to date across 1 migration\(s\) → stateVersion 2/)
})

// ===========================================================================
// COMP-MIGRATE-UNIFY-VISION — shared vision-state transforms
// ===========================================================================

// --- unit: pure transforms -------------------------------------------------

test('normalizeGateOutcome: maps legacy past-tense to imperative, leaves others, idempotent', () => {
  assert.equal(normalizeGateOutcome('approved'), 'approve')
  assert.equal(normalizeGateOutcome('killed'), 'kill')
  assert.equal(normalizeGateOutcome('revised'), 'revise')
  for (const stable of ['approve', 'kill', 'revise', 'pending', undefined, '']) {
    assert.equal(normalizeGateOutcome(stable), stable)
  }
  assert.equal(normalizeGateOutcome(normalizeGateOutcome('approved')), 'approve')
})

test('migrateVisionItemFeatureCode: feature:X → lifecycle.featureCode, in place + idempotent', () => {
  const item = { id: 'i1', type: 'feature', title: 'T', featureCode: 'feature:FEAT-9' }
  const r = migrateVisionItemFeatureCode(item)
  assert.equal(r.changed, true)
  assert.equal('featureCode' in item, false, 'top-level featureCode removed')
  assert.equal(item.lifecycle.featureCode, 'FEAT-9')
  // idempotent
  assert.equal(migrateVisionItemFeatureCode(item).changed, false)
})

test('migrateVisionItemFeatureCode: no-op when already lifecycle-bound or absent or non-prefixed', () => {
  // already lifecycle-bound (legacy top-level present but lifecycle wins → untouched)
  const bound = { id: 'i', lifecycle: { featureCode: 'X' }, featureCode: 'feature:Y' }
  assert.equal(migrateVisionItemFeatureCode(bound).changed, false)
  assert.equal(bound.featureCode, 'feature:Y', 'left as-is when lifecycle.featureCode present')
  // absent
  assert.equal(migrateVisionItemFeatureCode({ id: 'i' }).changed, false)
  // non-prefixed (a UI-created bare id, not legacy format) is left alone
  const bare = { id: 'i', featureCode: 'ui-uuid-1' }
  assert.equal(migrateVisionItemFeatureCode(bare).changed, false)
  assert.equal(bare.featureCode, 'ui-uuid-1')
  // total on non-object
  for (const v of [null, undefined, 3, 'x', []]) {
    assert.equal(migrateVisionItemFeatureCode(v).changed, false)
  }
})

test('migrateVisionItemFeatureCode: TOTAL on a malformed truthy non-string featureCode (never throws)', () => {
  // The registry invariant is PURE + TOTAL: a transform never throws on parseable
  // JSON. The prior inline code called `.startsWith` unguarded and would throw on
  // a non-string truthy featureCode (a load-path crash → fresh-state fallback).
  // The shared helper deliberately no-ops instead, so the eager runner can't crash
  // on the same pathological item. This is intentional alignment, not a regression.
  for (const bad of [7, true, {}, { x: 1 }, ['feature:X']]) {
    const item = { id: 'i', featureCode: bad }
    assert.doesNotThrow(() => migrateVisionItemFeatureCode(item))
    assert.equal(migrateVisionItemFeatureCode(item).changed, false)
    assert.deepEqual(item.featureCode, bad, 'malformed featureCode left untouched')
  }
  // And the whole-state transform stays total too.
  assert.doesNotThrow(() => migrateVisionState({ items: [{ id: 'i', featureCode: 7 }], gates: [] }))
})

test('migrateVisionState: applies both transforms over items+gates, idempotent', () => {
  const state = {
    items: [
      { id: 'a', featureCode: 'feature:A' },
      { id: 'b', lifecycle: { featureCode: 'B' } },
    ],
    gates: [{ id: 'g1', outcome: 'approved' }, { id: 'g2', outcome: 'approve' }],
  }
  const r = migrateVisionState(state)
  assert.equal(r.changed, true)
  assert.equal(r.state, state, 'returns the same (mutated) object')
  assert.equal(state.items[0].lifecycle.featureCode, 'A')
  assert.equal('featureCode' in state.items[0], false)
  assert.equal(state.gates[0].outcome, 'approve')
  // idempotent second pass
  assert.equal(migrateVisionState(state).changed, false)
  // total on a shape with missing arrays
  assert.equal(migrateVisionState({}).changed, false)
})

// --- AC2: byte-identity golden (locks the pre-refactor on-disk image) -------

test('migrateVisionState: byte-identical to the prior inline output (key order preserved)', () => {
  const state = {
    items: [{ id: 'old-1', type: 'feature', title: 'Old', featureCode: 'feature:FEAT-OLD' }],
    connections: [],
    gates: [{ id: 'g', status: 'resolved', outcome: 'approved' }],
  }
  migrateVisionState(state)
  // featureCode is deleted from its slot and lifecycle is appended last — exactly
  // what `item.lifecycle = {}; item.lifecycle.featureCode = …; delete item.featureCode` produced.
  assert.equal(
    JSON.stringify(state.items[0]),
    '{"id":"old-1","type":"feature","title":"Old","lifecycle":{"featureCode":"FEAT-OLD"}}',
  )
  assert.equal(state.gates[0].outcome, 'approve')
})

// --- AC4: load-path vs eager-path parity -----------------------------------

test('parity: granular load-path application == eager migrateVisionState (byte-identical)', () => {
  const seed = () => ({
    items: [
      { id: 'a', type: 'feature', title: 'A', featureCode: 'feature:A' },
      { id: 'b', type: 'feature', title: 'B', lifecycle: { featureCode: 'B' } },
      { id: 'c', type: 'idea', title: 'C' },
    ],
    connections: [{ id: 'x' }],
    gates: [
      { id: 'g1', outcome: 'approved' },
      { id: 'g2', outcome: 'killed' },
      { id: 'g3', outcome: 'revise' },
    ],
  })

  // Load-path: per-item + per-gate granular helpers (what vision-store/vision-writer now call).
  const loadPath = seed()
  for (const item of loadPath.items) migrateVisionItemFeatureCode(item)
  for (const gate of loadPath.gates) {
    if (gate.outcome) {
      const n = normalizeGateOutcome(gate.outcome)
      if (n !== gate.outcome) gate.outcome = n
    }
  }

  // Eager-path: whole-state transform (what runStateMigrations calls).
  const { state: eagerPath } = migrateVisionState(seed())

  assert.equal(JSON.stringify(loadPath), JSON.stringify(eagerPath))
})

// --- golden runner: eager vision-state walk --------------------------------

function seedVisionState(ws, state) {
  const dir = join(ws, '.compose', 'data')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'vision-state.json')
  writeFileSync(p, JSON.stringify(state, null, 2) + '\n')
  return p
}

function stampAt(ws, version) {
  writeFileSync(
    join(ws, '.compose', 'data', 'migration-state.json'),
    JSON.stringify({ stateVersion: version, applied: [] }, null, 2) + '\n',
  )
}

test('runner: eagerly migrates cold vision-state, stamps, idempotent re-run', () => {
  const ws = mkWorkspace()
  try {
    // Workspace already at the feature stateVersion (1) — only the vision migration is pending.
    stampAt(ws, 1)
    const vpath = seedVisionState(ws, {
      items: [{ id: 'old-1', type: 'feature', title: 'Old', featureCode: 'feature:FEAT-OLD' }],
      connections: [],
      gates: [{ id: 'g', status: 'resolved', outcome: 'approved' }],
    })

    const r = runStateMigrations(ws, {})
    assert.equal(r.to, LATEST)
    assert.equal(r.parseErrors.length, 0)
    const visionMig = r.perMigration.find((m) => m.id === 'normalize-vision-legacy')
    assert.deepEqual(visionMig.touched, ['vision-state.json'])

    const migrated = readJson(vpath)
    assert.equal('featureCode' in migrated.items[0], false)
    assert.equal(migrated.items[0].lifecycle.featureCode, 'FEAT-OLD')
    assert.equal(migrated.gates[0].outcome, 'approve')
    assert.equal(readMigrationState(ws).stateVersion, LATEST)

    // Re-run is a no-op.
    const r2 = runStateMigrations(ws, {})
    assert.equal(r2.noop, true)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: already-current vision-state is left byte-for-byte untouched', () => {
  const ws = mkWorkspace()
  try {
    stampAt(ws, 1)
    const original = JSON.stringify({
      items: [{ id: 'a', type: 'feature', title: 'A', lifecycle: { featureCode: 'A' } }],
      connections: [],
      gates: [{ id: 'g', outcome: 'approve' }],
    }, null, 2) + '\n'
    const vpath = join(ws, '.compose', 'data', 'vision-state.json')
    mkdirSync(join(ws, '.compose', 'data'), { recursive: true })
    writeFileSync(vpath, original)

    const r = runStateMigrations(ws, {})
    assert.equal(r.to, LATEST)
    const visionMig = r.perMigration.find((m) => m.id === 'normalize-vision-legacy')
    assert.deepEqual(visionMig.touched, [], 'nothing changed → not reported as touched')
    assert.equal(readFileSync(vpath, 'utf-8'), original, 'file left byte-for-byte identical')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: absent vision-state still advances the stamp (vision noop)', () => {
  const ws = mkWorkspace()
  try {
    stampAt(ws, 1)
    const r = runStateMigrations(ws, {})
    assert.equal(r.to, LATEST, 'stamp advances even with no vision-state.json to walk')
    assert.equal(readMigrationState(ws).stateVersion, LATEST)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: corrupt vision-state.json is reported but does NOT block the stamp', () => {
  const ws = mkWorkspace()
  try {
    stampAt(ws, 1)
    const vpath = join(ws, '.compose', 'data', 'vision-state.json')
    mkdirSync(join(ws, '.compose', 'data'), { recursive: true })
    writeFileSync(vpath, '{ not valid json')

    const r = runStateMigrations(ws, {})
    assert.equal(r.to, LATEST, 'stamp still advances despite corrupt vision-state')
    assert.equal(r.parseErrors.length, 1)
    assert.equal(r.parseErrors[0].path, vpath)
    assert.equal(readMigrationState(ws).stateVersion, LATEST)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: dry-run reports the vision migration but writes nothing', () => {
  const ws = mkWorkspace()
  try {
    stampAt(ws, 1)
    const original = JSON.stringify({
      items: [{ id: 'old-1', featureCode: 'feature:FEAT-OLD' }], connections: [], gates: [],
    }, null, 2) + '\n'
    const vpath = join(ws, '.compose', 'data', 'vision-state.json')
    mkdirSync(join(ws, '.compose', 'data'), { recursive: true })
    writeFileSync(vpath, original)

    const r = runStateMigrations(ws, { dryRun: true })
    assert.equal(r.dryRun, true)
    assert.equal(r.to, LATEST)
    assert.equal(readFileSync(vpath, 'utf-8'), original, 'vision-state untouched in dry-run')
    assert.equal(readMigrationState(ws).stateVersion, 1, 'stamp not advanced in dry-run')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
