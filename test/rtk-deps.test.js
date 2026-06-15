/**
 * COMP-RTK-INTEROP — `external_binaries` support in lib/deps.js.
 *
 * Verifies loadDeps surfaces the new optional `external_binaries` array (with
 * skip-and-warn on invalid entries, default [] when absent) and that
 * checkExternalBinaries splits present/missing via an injectable probe.
 * The real manifest's rtk entry is asserted too.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(REPO_ROOT, '.compose-deps.json')
const { loadDeps, checkExternalBinaries, buildBinaryReport } = await import(`${REPO_ROOT}/lib/deps.js`)

function withManifest(manifest, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rtk-deps-'))
  try {
    writeFileSync(join(dir, '.compose-deps.json'), JSON.stringify(manifest), 'utf-8')
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const BASE = { version: 1, external_skills: [] }

test('real manifest declares rtk as an optional external binary', () => {
  assert.ok(existsSync(MANIFEST_PATH))
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  assert.ok(Array.isArray(raw.external_binaries))
  const rtk = raw.external_binaries.find(b => b.id === 'rtk')
  assert.ok(rtk, 'rtk binary entry must exist')
  assert.equal(typeof rtk.detect, 'string')
  assert.equal(typeof rtk.install, 'string')
  assert.equal(rtk.optional, true)
})

test('loadDeps returns external_binaries when present', () => {
  withManifest(
    { ...BASE, external_binaries: [{ id: 'rtk', detect: 'rtk --version', install: 'brew install rtk', optional: true }] },
    (dir) => {
      const deps = loadDeps(dir)
      assert.ok(deps)
      assert.equal(deps.external_binaries.length, 1)
      assert.equal(deps.external_binaries[0].id, 'rtk')
    },
  )
})

test('loadDeps defaults external_binaries to [] when the key is absent', () => {
  withManifest({ ...BASE }, (dir) => {
    const deps = loadDeps(dir)
    assert.ok(deps)
    assert.deepEqual(deps.external_binaries, [])
  })
})

test('loadDeps skips invalid binary entries but keeps valid ones', () => {
  withManifest(
    {
      ...BASE,
      external_binaries: [
        { id: 'rtk', detect: 'rtk --version', install: 'brew install rtk', optional: true },
        { id: 'bad' }, // missing detect/install/optional — must be skipped
      ],
    },
    (dir) => {
      const deps = loadDeps(dir)
      assert.equal(deps.external_binaries.length, 1)
      assert.equal(deps.external_binaries[0].id, 'rtk')
    },
  )
})

test('a malformed external_binaries array does not null the whole manifest', () => {
  withManifest({ ...BASE, external_binaries: 'nope' }, (dir) => {
    const deps = loadDeps(dir)
    assert.ok(deps, 'manifest still loads')
    assert.deepEqual(deps.external_binaries, [])
    assert.ok(Array.isArray(deps.external_skills))
  })
})

test('checkExternalBinaries splits present/missing via injected probe', () => {
  const deps = {
    external_binaries: [
      { id: 'rtk', detect: 'rtk --version', install: 'brew install rtk', optional: true },
      { id: 'ghost', detect: 'ghost --version', install: 'n/a', optional: true },
    ],
  }
  const probe = (detect) => detect.startsWith('rtk') // only rtk is "installed"
  const { present, missing } = checkExternalBinaries(deps, { probe })
  assert.equal(present.length, 1)
  assert.equal(present[0].id, 'rtk')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].id, 'ghost')
})

test('buildBinaryReport projects a stable shape and defaults recommend to null', () => {
  const result = {
    present: [{ id: 'rtk', detect: 'rtk --version', install: 'brew install rtk', recommend: 'rtk init -g', optional: true }],
    missing: [{ id: 'ghost', detect: 'ghost --version', install: 'n/a', optional: true }],
  }
  const report = buildBinaryReport(result)
  assert.deepEqual(report.present[0], { id: 'rtk', detect: 'rtk --version', install: 'brew install rtk', recommend: 'rtk init -g', optional: true })
  assert.equal(report.missing[0].recommend, null) // absent recommend → null
})
