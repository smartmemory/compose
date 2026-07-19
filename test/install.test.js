/**
 * Integration tests for `compose install` side effects.
 *
 * Each test runs `node bin/compose.js install` in a real subprocess with:
 *   - a temp CWD  (isolated from the real project)
 *   - a temp HOME (prevents touching ~/.claude)
 *   - the adjacent Stratum TS runtime used by the develop checkout
 *
 * No mocking frameworks needed — node:test + node:assert only.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE_BIN = join(REPO_ROOT, 'bin', 'compose.js')

function makeEnv(cwd, home) {
  return {
    ...process.env,
    HOME: home,
  }
}

function runInstall(cwd, env) {
  return execFileSync(process.execPath, [COMPOSE_BIN, 'install'], {
    cwd,
    env,
    encoding: 'utf-8',
  })
}

// Collect temp dirs for cleanup after all tests
const temps = []
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'compose-install-'))
  temps.push(d)
  return d
}

// ---------------------------------------------------------------------------

test('writes .mcp.json with compose server entry', () => {
  const cwd = tmpDir()
  const home = tmpDir()
  const env = makeEnv(cwd, home)

  runInstall(cwd, env)

  const mcpPath = join(cwd, '.mcp.json')
  assert.ok(existsSync(mcpPath), '.mcp.json should exist')

  const cfg = JSON.parse(readFileSync(mcpPath, 'utf-8'))
  assert.ok(cfg.mcpServers?.compose, 'mcpServers.compose should be present')
  assert.equal(cfg.mcpServers.compose.command, 'node')
  assert.ok(
    Array.isArray(cfg.mcpServers.compose.args),
    'args should be an array'
  )
  assert.ok(
    cfg.mcpServers.compose.args[0].endsWith('compose-mcp.js'),
    'args[0] should point to compose-mcp.js'
  )
})

test('merges into existing .mcp.json without clobbering other servers', () => {
  const cwd = tmpDir()
  const home = tmpDir()
  const env = makeEnv(cwd, home)

  const existing = { mcpServers: { other: { command: 'other-server', args: [] } } }
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(existing, null, 2))

  runInstall(cwd, env)

  const cfg = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'))
  assert.ok(cfg.mcpServers.other, 'existing server should be preserved')
  assert.ok(cfg.mcpServers.compose, 'compose server should be added')
})

test('installs compose skill to ~/.claude/skills/compose/SKILL.md', () => {
  const cwd = tmpDir()
  const home = tmpDir()
  const env = makeEnv(cwd, home)

  runInstall(cwd, env)

  const skillPath = join(home, '.claude', 'skills', 'compose', 'SKILL.md')
  assert.ok(existsSync(skillPath), 'SKILL.md should exist in ~/.claude/skills/compose/')

  const content = readFileSync(skillPath, 'utf-8')
  assert.ok(content.length > 100, 'SKILL.md should have meaningful content')
  assert.ok(content.includes('compose'), 'SKILL.md should reference compose')
})

test('scaffolds ROADMAP.md with project name substituted', () => {
  const cwd = tmpDir()
  const home = tmpDir()
  const env = makeEnv(cwd, home)

  // cwd basename is the "project name"
  const projectName = cwd.split('/').at(-1)

  runInstall(cwd, env)

  const roadmapPath = join(cwd, 'ROADMAP.md')
  assert.ok(existsSync(roadmapPath), 'ROADMAP.md should be created')

  const content = readFileSync(roadmapPath, 'utf-8')
  assert.ok(content.includes(projectName), 'ROADMAP.md should contain the project name')
  assert.ok(!content.includes('{{PROJECT_NAME}}'), 'template placeholders should be replaced')
  assert.ok(!content.includes('{{DATE}}'), 'template placeholders should be replaced')
})

test('does not overwrite an existing ROADMAP.md', () => {
  const cwd = tmpDir()
  const home = tmpDir()
  const env = makeEnv(cwd, home)

  const roadmapPath = join(cwd, 'ROADMAP.md')
  writeFileSync(roadmapPath, 'existing content')

  runInstall(cwd, env)

  assert.equal(readFileSync(roadmapPath, 'utf-8'), 'existing content')
})

test('is idempotent: running install twice produces the same .mcp.json', () => {
  const cwd = tmpDir()
  const home = tmpDir()
  const env = makeEnv(cwd, home)

  runInstall(cwd, env)
  const first = readFileSync(join(cwd, '.mcp.json'), 'utf-8')

  runInstall(cwd, env)
  const second = readFileSync(join(cwd, '.mcp.json'), 'utf-8')

  assert.equal(first, second, '.mcp.json should be identical after two installs')
})

test('does not depend on a Python Stratum binary on PATH', () => {
  const cwd = tmpDir()
  const home = tmpDir()
  const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin' }
  execFileSync(process.execPath, [COMPOSE_BIN, 'install'], { cwd, env, encoding: 'utf-8' })
  const config = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf-8'))
  assert.equal(config.mcpServers.stratum.command, process.execPath)
  // The wired bin is either the adjacent stratum source (monorepo) or the installed
  // @smartmemory/stratum compiled bin (CI) — both are the TS engine, not python.
  assert.match(config.mcpServers.stratum.args[0], /(ts\/src\/mcp\/bin\.mjs|dist\/mcp\/main\.js)$/)
})
