/**
 * Tests for COMP-DEPS-PACKAGE — external skill dependency manifest, doctor command,
 * and syncSkills extension.
 *
 * Tests the lib/deps.js helpers in isolation (T1–T5), plus a subprocess test for
 * the `compose doctor` CLI (T6). T7 (syncSkills extension) is not exercised here
 * because it mutates the user's home directory; an integration smoke is provided
 * by running `compose doctor` itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = join(REPO_ROOT, '.compose-deps.json')
const SKILL_MD_PATH = join(REPO_ROOT, '.claude', 'skills', 'compose', 'SKILL.md')
const PACKAGE_JSON_PATH = join(REPO_ROOT, 'package.json')
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js')

const { loadDeps, checkExternalSkills, printDepReport } = await import(`${REPO_ROOT}/lib/deps.js`)

// ---------------------------------------------------------------------------
// T1 — Manifest file shape
// ---------------------------------------------------------------------------

test('T1: .compose-deps.json exists and has the expected shape', () => {
  assert.ok(existsSync(MANIFEST_PATH), 'manifest must exist at package root')
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  assert.equal(raw.version, 1)
  assert.ok(Array.isArray(raw.external_skills))
  assert.equal(raw.external_skills.length, 12)
  for (const dep of raw.external_skills) {
    assert.equal(typeof dep.id, 'string')
    assert.ok(Array.isArray(dep.required_for))
    assert.ok(dep.required_for.every(v => typeof v === 'string'))
    assert.equal(typeof dep.install, 'string')
    assert.ok(dep.fallback === null || typeof dep.fallback === 'string')
    assert.equal(typeof dep.optional, 'boolean')
  }
})

test('T1: every manifest id appears somewhere in SKILL.md (drift guard)', () => {
  const skill = readFileSync(SKILL_MD_PATH, 'utf-8')
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'))
  for (const dep of raw.external_skills) {
    assert.ok(skill.includes(dep.id), `SKILL.md missing reference to manifest id: ${dep.id}`)
  }
})

// ---------------------------------------------------------------------------
// T2 — package.json files allowlist
// ---------------------------------------------------------------------------

test('T2: package.json files allowlist includes manifest and skill source dirs', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'))
  assert.ok(Array.isArray(pkg.files))
  assert.ok(pkg.files.includes('.compose-deps.json'), 'files must include .compose-deps.json')
  assert.ok(pkg.files.includes('.claude/skills/**'), 'files must include .claude/skills/**')
  assert.ok(pkg.files.includes('skills/**'), 'files must include skills/**')
})

// ---------------------------------------------------------------------------
// T3 — loadDeps()
// ---------------------------------------------------------------------------

test('T3: loadDeps returns parsed manifest from real package root', () => {
  const deps = loadDeps(REPO_ROOT)
  assert.ok(deps)
  assert.equal(deps.version, 1)
  assert.equal(deps.external_skills.length, 12)
})

test('T3: loadDeps returns null when manifest missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'compose-deps-'))
  try {
    const deps = loadDeps(tmp)
    assert.equal(deps, null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('T3: loadDeps skips invalid entries with a warning, keeps valid ones', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'compose-deps-'))
  try {
    writeFileSync(join(tmp, '.compose-deps.json'), JSON.stringify({
      version: 1,
      external_skills: [
        { id: 'good:one', required_for: ['x'], install: 'cmd', fallback: null, optional: false },
        { id: 'bad-no-optional', required_for: ['x'], install: 'cmd', fallback: null },
        { id: 'good:two', required_for: ['y'], install: 'cmd', fallback: 'fb', optional: true },
        { id: 42, required_for: [], install: 'cmd', fallback: null, optional: true },
      ],
    }))
    const deps = loadDeps(tmp)
    assert.ok(deps)
    assert.equal(deps.external_skills.length, 2)
    assert.deepEqual(deps.external_skills.map(d => d.id), ['good:one', 'good:two'])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('T3: loadDeps returns null when version unsupported', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'compose-deps-'))
  try {
    writeFileSync(join(tmp, '.compose-deps.json'), JSON.stringify({
      version: 99,
      external_skills: [],
    }))
    const deps = loadDeps(tmp)
    assert.equal(deps, null)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T4 — checkExternalSkills()
// ---------------------------------------------------------------------------

function setupFakeHome() {
  const tmp = mkdtempSync(join(tmpdir(), 'compose-home-'))
  // Bare skill: refactor
  mkdirSync(join(tmp, '.claude', 'skills', 'refactor'), { recursive: true })
  writeFileSync(join(tmp, '.claude', 'skills', 'refactor', 'SKILL.md'), '# refactor\n')
  // Pattern A' (commands): codex:review under marketplaces/openai-codex/plugins/codex/commands/review.md
  mkdirSync(join(tmp, '.claude', 'plugins', 'marketplaces', 'openai-codex', 'plugins', 'codex', 'commands'), { recursive: true })
  writeFileSync(join(tmp, '.claude', 'plugins', 'marketplaces', 'openai-codex', 'plugins', 'codex', 'commands', 'review.md'), '# review\n')
  // Pattern B' (commands): interface-design:init under marketplaces/interface-design/.claude/commands/init.md
  mkdirSync(join(tmp, '.claude', 'plugins', 'marketplaces', 'interface-design', '.claude', 'commands'), { recursive: true })
  writeFileSync(join(tmp, '.claude', 'plugins', 'marketplaces', 'interface-design', '.claude', 'commands', 'init.md'), '# init\n')
  // Pattern C (cache): superpowers:test-driven-development
  mkdirSync(join(tmp, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '5.0.7', 'skills', 'test-driven-development'), { recursive: true })
  writeFileSync(join(tmp, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers', '5.0.7', 'skills', 'test-driven-development', 'SKILL.md'), '# tdd\n')
  return tmp
}

test('T4: checkExternalSkills detects bare, command-pattern, and cache-pattern skills', () => {
  const home = setupFakeHome()
  try {
    const deps = {
      version: 1,
      external_skills: [
        { id: 'refactor', required_for: ['x'], install: 'cmd', fallback: null, optional: true },
        { id: 'codex:review', required_for: ['x'], install: 'cmd', fallback: null, optional: true },
        { id: 'interface-design:init', required_for: ['x'], install: 'cmd', fallback: null, optional: true },
        { id: 'superpowers:test-driven-development', required_for: ['x'], install: 'cmd', fallback: null, optional: false },
        { id: 'nope:missing', required_for: ['x'], install: 'cmd', fallback: null, optional: false },
      ],
    }
    const result = checkExternalSkills(deps, home)
    assert.equal(result.present.length, 4)
    assert.equal(result.missing.length, 1)
    assert.equal(result.missing[0].id, 'nope:missing')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('T4: bare-vs-namespaced matching prevents false positives', () => {
  const home = setupFakeHome()
  try {
    // Manifest claims there's a bare skill named "review" — there isn't (only codex:review exists).
    const deps = {
      version: 1,
      external_skills: [
        { id: 'review', required_for: ['x'], install: 'cmd', fallback: null, optional: true },
      ],
    }
    const result = checkExternalSkills(deps, home)
    assert.equal(result.present.length, 0)
    assert.equal(result.missing.length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// T5 — printDepReport()
// ---------------------------------------------------------------------------

function captureStdout(fn) {
  const orig = console.log
  const lines = []
  console.log = (...args) => lines.push(args.join(' '))
  try { fn() } finally { console.log = orig }
  return lines.join('\n')
}

test('T5: printDepReport human output reports all-present cleanly', () => {
  const out = captureStdout(() => {
    const ok = printDepReport({ present: [{ id: 'x' }], missing: [], scannedPaths: [] })
    assert.equal(ok, true)
  })
  assert.ok(out.includes('All 1 deps present'))
  assert.ok(out.includes('✓ x'))
})

test('T5: printDepReport human output flags degraded mode when required missing', () => {
  const out = captureStdout(() => {
    const ok = printDepReport({
      present: [],
      missing: [{ id: 'sp:debug', install: 'claude plugin install superpowers', optional: false }],
      scannedPaths: [],
    })
    assert.equal(ok, false)
  })
  assert.ok(out.includes('degraded mode'))
  assert.ok(out.includes('claude plugin install superpowers'))
})

test('T5: printDepReport JSON mode emits full dep records (Round 2 fix)', () => {
  const out = captureStdout(() => {
    printDepReport({
      present: [{ id: 'a', required_for: ['x'], install: 'i', fallback: 'fb', optional: false }],
      missing: [{ id: 'b', required_for: ['y'], install: 'j', fallback: null, optional: true }],
      scannedPaths: ['/tmp'],
    }, { json: true })
  })
  const parsed = JSON.parse(out)
  assert.deepEqual(parsed.present[0], { id: 'a', required_for: ['x'], install: 'i', fallback: 'fb', optional: false })
  assert.deepEqual(parsed.missing[0], { id: 'b', required_for: ['y'], install: 'j', fallback: null, optional: true })
  assert.deepEqual(parsed.scannedPaths, ['/tmp'])
})

// ---------------------------------------------------------------------------
// T6 — `compose doctor` subprocess
// ---------------------------------------------------------------------------

test('T6: `compose doctor --json` produces parseable JSON with required keys', () => {
  const proc = spawnSync('node', [COMPOSE_BIN, 'doctor', '--json'], { encoding: 'utf-8' })
  assert.equal(proc.status, 0, `compose doctor --json exited ${proc.status}: ${proc.stderr}`)
  const parsed = JSON.parse(proc.stdout)
  assert.ok(Array.isArray(parsed.present))
  assert.ok(Array.isArray(parsed.missing))
  assert.ok(Array.isArray(parsed.scannedPaths))
  // Full record projection (Round 2)
  for (const dep of [...parsed.present, ...parsed.missing]) {
    assert.equal(typeof dep.id, 'string')
    assert.ok(Array.isArray(dep.required_for))
    assert.equal(typeof dep.install, 'string')
    assert.ok(dep.fallback === null || typeof dep.fallback === 'string')
    assert.equal(typeof dep.optional, 'boolean')
  }
})

test('T6: `compose doctor` produces human-readable output', () => {
  const proc = spawnSync('node', [COMPOSE_BIN, 'doctor'], { encoding: 'utf-8' })
  assert.equal(proc.status, 0)
  assert.ok(proc.stdout.includes('External skill dependencies:'))
})

test('T6: `compose --help` lists doctor command', () => {
  const proc = spawnSync('node', [COMPOSE_BIN, '--help'], { encoding: 'utf-8' })
  assert.equal(proc.status, 0)
  assert.ok(proc.stdout.includes('doctor'))
})

// ---------------------------------------------------------------------------
// T8 — SKILL.md drift guard
// ---------------------------------------------------------------------------

test('T8: SKILL.md points to manifest as source of truth', () => {
  const skill = readFileSync(SKILL_MD_PATH, 'utf-8')
  assert.ok(skill.includes('.compose-deps.json'), 'SKILL.md must reference the manifest file')
  assert.ok(skill.includes('compose doctor'), 'SKILL.md must reference the doctor command')
})
