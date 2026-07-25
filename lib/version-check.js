/**
 * Version drift detection — fetch latest @smartmemory/compose from npm
 * and compare to the locally-installed version.
 *
 * Cached 24h at ~/.compose/version-cache.json. Never throws; returns null
 * on any failure (network, parse, etc.) so it never breaks `compose doctor`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const PACKAGE_NAME = '@smartmemory/compose'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h
const FETCH_TIMEOUT_MS = 3000

export function cachePath() {
  return process.env.COMPOSE_VERSION_CACHE || join(homedir(), '.compose', 'version-cache.json')
}

function readCacheDoc(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Legacy cache is exactly { fetchedAt: <number>, latest: <string> }.
    // A package named `latest` is valid and would otherwise be mistaken for that shape.
    if (typeof parsed.fetchedAt === 'number' && typeof parsed.latest === 'string') return {}
    return parsed
  } catch {
    return {}
  }
}

function readCache(pkg, file) {
  const entry = readCacheDoc(file)[pkg]
  if (typeof entry?.fetchedAt !== 'number' || typeof entry?.latest !== 'string') return null
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null
  return entry
}

function writeCache(pkg, latest, file) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const doc = readCacheDoc(file)
    doc[pkg] = { fetchedAt: Date.now(), latest }
    writeFileSync(file, JSON.stringify(doc, null, 2))
  } catch {
    // best-effort cache; ignore failures
  }
}

async function fetchLatest(pkg) {
  if (typeof fetch !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const url = `https://registry.npmjs.org/${pkg}/latest`
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.version === 'string' ? data.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Compare semver-ish strings. Returns:
 *   -1 if a < b, 0 if equal, 1 if a > b, null if either unparseable.
 * Treats prerelease tags conservatively: "0.1.7-beta" < "0.1.7".
 */
export function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null
  const parse = (s) => {
    const [core, pre] = s.split('-')
    const parts = core.split('.').map(n => Number.parseInt(n, 10))
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n))) return null
    return { parts, pre: pre ?? null }
  }
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.parts[i] < pb.parts[i]) return -1
    if (pa.parts[i] > pb.parts[i]) return 1
  }
  // cores equal — prerelease < release
  if (pa.pre && !pb.pre) return -1
  if (!pa.pre && pb.pre) return 1
  if (pa.pre === pb.pre) return 0
  return pa.pre < pb.pre ? -1 : 1
}

/**
 * Returns { current, latest, behind, source } or null on failure.
 *   behind: true if current < latest, false otherwise.
 *   source: 'cache' | 'network'
 */
export async function checkPackageVersion(pkg, currentVersion, opts) {
  const { force = false, fetchImpl = fetchLatest, cacheFile = cachePath() } = opts ?? {}
  if (!currentVersion) return null

  if (!force) {
    const cached = readCache(pkg, cacheFile)
    if (cached) {
      const cmp = compareVersions(currentVersion, cached.latest)
      if (cmp === null) return null
      return { current: currentVersion, latest: cached.latest, behind: cmp < 0, source: 'cache' }
    }
  }

  let latest = null
  try {
    latest = await fetchImpl(pkg)
  } catch {
    return null
  }
  if (!latest) return null
  writeCache(pkg, latest, cacheFile)
  const cmp = compareVersions(currentVersion, latest)
  if (cmp === null) return null
  return { current: currentVersion, latest, behind: cmp < 0, source: 'network' }
}

/** Compose's own check. Shape and behavior unchanged — `compose doctor` and its
 * --json consumers depend on this exact object. */
export async function checkLatestVersion(currentVersion, opts = {}) {
  return checkPackageVersion(PACKAGE_NAME, currentVersion, opts ?? {})
}

/** The version stratum ACTUALLY resolved to, read from node_modules.
 *
 * Deliberately not the range declared in compose's package.json. Compose 0.3.7
 * moved that declaration from an exact pin to `^0.3.3`, and npm does not
 * re-resolve a caret unless something triggers an install — so the declared
 * range and the installed version drift apart, and the installed one is the
 * only one that tells the user anything true.
 *
 * Absent stratum is a normal state (not installed, capabilities.stratum off),
 * not an error. */
export function resolveStratumVersion(packageRoot) {
  try {
    const manifest = join(packageRoot, 'node_modules', '@smartmemory', 'stratum', 'package.json')
    const version = JSON.parse(readFileSync(manifest, 'utf-8')).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/** Zero or one lines. Pure: no network, no filesystem, no clock — so every
 * branch is decidable in a unit test.
 *
 * Silence is the default. A nudge that prints on every run gets filtered out by
 * the reader, at which point it has negative value. */
export function formatDriftNudge({ compose = null, stratum = null } = {}) {
  const parts = []
  if (compose?.behind) parts.push(`compose ${compose.current} → ${compose.latest}`)
  if (stratum?.behind) parts.push(`stratum ${stratum.current} → ${stratum.latest}`)
  if (parts.length === 0) return []
  return [`⚠ update available: ${parts.join(', ')} — run: compose update`]
}
