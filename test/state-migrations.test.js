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
const { MIGRATIONS, runStateMigrations, readMigrationState, summarizeMigrationReport } =
  await import(`${REPO_ROOT}/lib/state-migrations.js`)

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
    assert.equal(r1.to, 1)
    assert.equal(r1.parseErrors.length, 0)
    assert.deepEqual(r1.perMigration[0].touched, ['COMP-UI-3'])

    assert.equal('complexity' in readJson(bad), false, 'null complexity dropped')
    assert.equal(readJson(ok).complexity, 'M', 'valid complexity untouched')
    assert.equal('complexity' in readJson(plain), false, 'absent stays absent')
    assert.equal(readMigrationState(ws).stateVersion, 1, 'stamp advanced')

    // Re-run is a no-op (no pending migrations)
    const r2 = runStateMigrations(ws, {})
    assert.equal(r2.noop, true)
    assert.equal(r2.to, 1)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: honors paths.features override', () => {
  const ws = mkWorkspace({ featuresDir: 'specs/feat' })
  try {
    const bad = seedFeature(ws, 'X-1', { complexity: null }, 'specs/feat')
    const r = runStateMigrations(ws, {})
    assert.equal(r.to, 1)
    assert.deepEqual(r.perMigration[0].touched, ['X-1'])
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
    assert.equal(r.to, 1, 'stamp still advances despite corrupt file')
    assert.equal(r.parseErrors.length, 1)
    assert.equal(r.parseErrors[0].path, corruptPath)
    assert.equal('complexity' in readJson(bad), false, 'good file still migrated')
    assert.equal(readMigrationState(ws).stateVersion, 1)
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
    assert.equal(r.to, 1)
    assert.deepEqual(r.perMigration[0].touched, ['COMP-UI-5'])
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
