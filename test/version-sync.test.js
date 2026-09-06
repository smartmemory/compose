/**
 * Version sync across the three published packages — the enforcement half of
 * `.claude/rules/versioning.md`.
 *
 * A rule in a doc fires only when someone reads it, and nobody reads a rule at
 * the moment they are editing a version number. These assertions do.
 *
 * Constraints:
 *   1. compose-mcp carries compose's exact version, and depends on ^that.
 *   2. compose and stratum share a MINOR; patches move independently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p) => JSON.parse(readFileSync(join(REPO_ROOT, ...p), 'utf8'))

const composePkg = read('package.json')
const mcpPkg = read('compose-mcp', 'package.json')
const mcpServer = read('compose-mcp', 'server.json')

/** "0.4.5" -> "0.4"; throws on anything that is not a plain 3-part version. */
function minorOf(version, what) {
  const m = /^(\d+)\.(\d+)\.\d+/.exec(version)
  assert.ok(m, `${what} must be a plain MAJOR.MINOR.PATCH version, got ${JSON.stringify(version)}`)
  return `${m[1]}.${m[2]}`
}

test('VERSION-SYNC: compose-mcp carries compose\'s exact version', () => {
  assert.equal(
    mcpPkg.version, composePkg.version,
    'compose-mcp is a shim with no independent feature surface — it moves with compose or not at all '
    + '(.claude/rules/versioning.md)',
  )
})

test('VERSION-SYNC: compose-mcp server.json agrees with its package.json in both places', () => {
  // The publish workflow validates these too, but CI has not run since 2026-07-22,
  // so the suite is the only gate that actually fires today.
  assert.equal(mcpServer.version, mcpPkg.version, 'server.json top-level version')
  assert.equal(mcpServer.packages[0].version, mcpPkg.version, 'server.json packages[0].version')
})

test('VERSION-SYNC: compose-mcp depends on the exact compose version it ships with', () => {
  assert.equal(
    mcpPkg.dependencies['@smartmemory/compose'], `^${composePkg.version}`,
    'a hardcoded range rots: this sat at ^0.1.5-beta across nine compose releases',
  )
})

test('VERSION-SYNC: compose and stratum share a minor', () => {
  const range = composePkg.dependencies['@smartmemory/stratum']
  assert.equal(typeof range, 'string', 'compose must declare a @smartmemory/stratum dependency')
  const pinned = range.replace(/^[\^~>=<\s]+/, '')
  assert.equal(
    minorOf(pinned, 'the stratum dependency'), minorOf(composePkg.version, 'compose'),
    `compose ${composePkg.version} and stratum ${pinned} must share a minor — compose calls stratum's `
    + 'MCP surface directly, and a surface change lands as a stratum minor (.claude/rules/versioning.md)',
  )
})
