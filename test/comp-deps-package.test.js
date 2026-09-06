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

const { loadDeps, checkExternalSkills, printDepReport, installMissingPlugins } = await import(`${REPO_ROOT}/lib/deps.js`)

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

test('T4: a bare dep is satisfied by a plugin-provided skill of the same leaf name', () => {
  // Real-world case: the manifest lists bare `refactor`/`update-docs`, but they
  // ship as coder-config plugin skills (marketplaces/<m>/plugins/coder-config/skills/<s>).
  // Claude Code surfaces them under their BARE names, so doctor must count them present
  // even though they live under a namespaced plugin path on disk.
  const home = setupFakeHome()
  try {
    const p = join(home, '.claude', 'plugins', 'marketplaces', 'claude-config-plugins', 'plugins', 'coder-config', 'skills')
    for (const s of ['refactor', 'update-docs']) {
      mkdirSync(join(p, s), { recursive: true })
      writeFileSync(join(p, s, 'SKILL.md'), `# ${s}\n`)
    }
    const deps = {
      version: 1,
      external_skills: [
        { id: 'refactor', required_for: ['x'], install: 'cmd', fallback: null, optional: true },
        { id: 'update-docs', required_for: ['x'], install: 'cmd', fallback: null, optional: true },
      ],
    }
    const result = checkExternalSkills(deps, home)
    assert.equal(result.present.length, 2, 'bare deps should resolve via plugin leaf match')
    assert.equal(result.missing.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('T4: a bare dep with no install (bare or plugin leaf) is still reported missing', () => {
  // True-negative guard: leaf matching must not turn detection into "always present".
  const home = setupFakeHome()
  try {
    const deps = {
      version: 1,
      external_skills: [
        { id: 'does-not-exist-anywhere', required_for: ['x'], install: 'cmd', fallback: null, optional: false },
      ],
    }
    const result = checkExternalSkills(deps, home)
    assert.equal(result.present.length, 0)
    assert.equal(result.missing.length, 1)
    assert.equal(result.missing[0].id, 'does-not-exist-anywhere')
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
  // COMP-DEPS-AUTOINSTALL added `plugin` to the projection: null when the dep has
  // no automated install path, the `<plugin>@<marketplace>` spec when it does.
  assert.deepEqual(parsed.present[0], { id: 'a', required_for: ['x'], install: 'i', plugin: null, marketplace_source: null, fallback: 'fb', optional: false })
  assert.deepEqual(parsed.missing[0], { id: 'b', required_for: ['y'], install: 'j', plugin: null, marketplace_source: null, fallback: null, optional: true })
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

// ---------------------------------------------------------------------------
// COMP-DEPS-AUTOINSTALL — auto-install of missing required plugins
// ---------------------------------------------------------------------------

/** Build a checkExternalSkills-shaped result from bare dep specs. */
const asResult = (missing) => ({ present: [], missing, scannedPaths: [] })
const dep = (id, over = {}) => ({
  id, required_for: ['x'], install: 'hint', fallback: null, optional: false, ...over,
})

test('AUTOINSTALL: every superpowers dep carries a plugin spec with an explicit marketplace', () => {
  const deps = loadDeps(REPO_ROOT)
  const sp = deps.external_skills.filter(d => d.id.startsWith('superpowers:'))
  assert.ok(sp.length > 0, 'expected superpowers deps in the manifest')
  for (const d of sp) {
    assert.equal(typeof d.plugin, 'string', `${d.id} must declare a plugin spec`)
    assert.ok(d.plugin.includes('@'), `${d.id} plugin spec must pin a marketplace, got ${d.plugin}`)
  }
})

test('AUTOINSTALL: one install per plugin even when many deps share it', () => {
  const calls = []
  const report = installMissingPlugins(
    asResult([
      dep('superpowers:a', { plugin: 'superpowers@claude-plugins-official' }),
      dep('superpowers:b', { plugin: 'superpowers@claude-plugins-official' }),
      dep('superpowers:c', { plugin: 'superpowers@claude-plugins-official' }),
    ]),
    { spawn: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 } } },
  )
  assert.equal(calls.length, 1, 'three deps from one plugin must produce one install')
  assert.deepEqual(calls[0], [
    'claude', 'plugin', 'install', 'superpowers@claude-plugins-official', '-y', '--scope', 'user',
  ])
  assert.deepEqual(report.installed, ['superpowers@claude-plugins-official'])
  assert.deepEqual(report.failed, [])
})

test('AUTOINSTALL: optional deps and deps without a plugin spec are never installed', () => {
  const calls = []
  const report = installMissingPlugins(
    asResult([
      dep('interface-design:init', { plugin: 'interface-design@x', optional: true }),
      dep('refactor'), // required but no plugin spec — prose install path
    ]),
    { spawn: (cmd, args) => { calls.push(args); return { status: 0 } } },
  )
  assert.deepEqual(calls, [], 'optional and prose-only deps must not be installed')
  assert.deepEqual(report.installed, [])
})

test('AUTOINSTALL: an unregistered marketplace is added, then the install retried once', () => {
  // The pristine-machine path: the first install fails because no marketplace is
  // registered yet. Measured against a clean HOME — without the retry every
  // required dep stays missing.
  const calls = []
  const report = installMissingPlugins(
    asResult([dep('superpowers:a', {
      plugin: 'superpowers@claude-plugins-official',
      marketplace_source: 'anthropics/claude-plugins-official',
    })]),
    {
      spawn: (cmd, args) => {
        calls.push(args.join(' '))
        if (args[1] === 'marketplace') return { status: 0 }
        return calls.filter(c => c.startsWith('plugin install')).length === 1
          ? { status: 1, stderr: 'Plugin "superpowers" not found in marketplace "claude-plugins-official".' }
          : { status: 0 }
      },
    },
  )
  assert.deepEqual(calls, [
    'plugin install superpowers@claude-plugins-official -y --scope user',
    'plugin marketplace add anthropics/claude-plugins-official',
    'plugin install superpowers@claude-plugins-official -y --scope user',
  ])
  assert.deepEqual(report.installed, ['superpowers@claude-plugins-official'])
})

test('AUTOINSTALL: no marketplace is added for a failure that is not "not found"', () => {
  const calls = []
  installMissingPlugins(
    asResult([dep('superpowers:a', {
      plugin: 'superpowers@claude-plugins-official',
      marketplace_source: 'anthropics/claude-plugins-official',
    })]),
    { spawn: (cmd, args) => { calls.push(args[1]); return { status: 1, stderr: 'network unreachable' } } },
  )
  assert.deepEqual(calls, ['install'], 'a non-resolution failure must not trigger a marketplace add')
})

test('AUTOINSTALL: a failing install surfaces the real stderr, not a generic message', () => {
  const report = installMissingPlugins(
    asResult([dep('superpowers:a', { plugin: 'superpowers@claude-plugins-official' })]),
    { spawn: () => ({ status: 1, stderr: 'marketplace not found: claude-plugins-official\n' }) },
  )
  assert.deepEqual(report.installed, [])
  assert.equal(report.failed.length, 1)
  assert.match(report.failed[0].reason, /marketplace not found/)
})

test('AUTOINSTALL: a missing claude CLI is a skip with a reason, never a throw', () => {
  const report = installMissingPlugins(
    asResult([dep('superpowers:a', { plugin: 'superpowers@claude-plugins-official' })]),
    { spawn: () => ({ status: null, error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }) }) },
  )
  assert.equal(report.installed.length, 0)
  assert.equal(report.failed.length, 0)
  assert.match(report.skipped, /claude` CLI is not on PATH/)
})

test('AUTOINSTALL: enabled:false short-circuits without spawning', () => {
  let spawned = false
  const report = installMissingPlugins(
    asResult([dep('superpowers:a', { plugin: 'superpowers@claude-plugins-official' })]),
    { enabled: false, spawn: () => { spawned = true; return { status: 0 } } },
  )
  assert.equal(spawned, false)
  assert.equal(report.skipped, 'disabled')
})

test('AUTOINSTALL: nothing missing means no spawn at all', () => {
  let spawned = false
  const report = installMissingPlugins(asResult([]), { spawn: () => { spawned = true; return { status: 0 } } })
  assert.equal(spawned, false)
  assert.deepEqual(report.installed, [])
})

test('AUTOINSTALL: installed_plugins.json is authoritative — a cached-but-uninstalled plugin is missing', () => {
  // The regression this feature was built on top of: `claude plugin uninstall`
  // drops the plugin from installed_plugins.json but LEAVES its cached tree, so
  // walking the cache alone reported an uninstalled plugin as present. doctor
  // then claimed a skill was available that Claude Code would not load, and
  // auto-install never fired because nothing looked missing.
  const home = mkdtempSync(join(tmpdir(), 'compose-home-auth-'))
  try {
    const cache = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official')
    // A: installed AND cached.  B: cached only (the uninstall leftover).
    const keep = join(cache, 'kept', '1.0.0')
    mkdirSync(join(keep, 'skills', 'alive'), { recursive: true })
    writeFileSync(join(keep, 'skills', 'alive', 'SKILL.md'), '# alive\n')
    const gone = join(cache, 'removed', '1.0.0')
    mkdirSync(join(gone, 'skills', 'ghost'), { recursive: true })
    writeFileSync(join(gone, 'skills', 'ghost', 'SKILL.md'), '# ghost\n')

    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'kept@claude-plugins-official': [{ scope: 'user', installPath: keep }] },
      }),
    )

    const deps = {
      version: 1,
      external_skills: [
        { id: 'kept:alive', required_for: ['x'], install: 'c', fallback: null, optional: false },
        { id: 'removed:ghost', required_for: ['x'], install: 'c', fallback: null, optional: false },
      ],
    }
    const r = checkExternalSkills(deps, home)
    assert.deepEqual(r.present.map(d => d.id), ['kept:alive'])
    assert.deepEqual(r.missing.map(d => d.id), ['removed:ghost'],
      'a plugin absent from installed_plugins.json must be missing even though its cache remains')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('AUTOINSTALL: no installed_plugins.json falls back to the cache walk (older Claude Code)', () => {
  const home = mkdtempSync(join(tmpdir(), 'compose-home-legacy-'))
  try {
    const p = join(home, '.claude', 'plugins', 'cache', 'mkt', 'legacy', '1.0.0', 'skills', 'thing')
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'SKILL.md'), '# thing\n')
    const deps = {
      version: 1,
      external_skills: [{ id: 'legacy:thing', required_for: ['x'], install: 'c', fallback: null, optional: false }],
    }
    assert.deepEqual(checkExternalSkills(deps, home).present.map(d => d.id), ['legacy:thing'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
