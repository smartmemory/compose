/**
 * Version drift detection — fetch latest @smartmemory/compose from npm
 * and compare to the locally-installed version.
 *
 * Cached 24h at ~/.compose/version-cache.json. Never throws; returns null
 * on any failure (network, parse, etc.) so it never breaks `compose doctor`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const PACKAGE_NAME = '@smartmemory/compose'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000  // 24h
const FETCH_TIMEOUT_MS = 3000

function cachePath() {
  return join(homedir(), '.compose', 'version-cache.json')
}

function readCache() {
  try {
    const raw = readFileSync(cachePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.fetchedAt !== 'number' || typeof parsed?.latest !== 'string') return null
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(latest) {
  try {
    const path = cachePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), latest }, null, 2))
  } catch {
    // best-effort cache; ignore failures
  }
}

async function fetchLatest() {
  if (typeof fetch !== 'function') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const url = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`
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
export async function checkLatestVersion(currentVersion, { force = false } = {}) {
  if (!currentVersion) return null

  if (!force) {
    const cached = readCache()
    if (cached) {
      const cmp = compareVersions(currentVersion, cached.latest)
      if (cmp === null) return null
      return { current: currentVersion, latest: cached.latest, behind: cmp < 0, source: 'cache' }
    }
  }

  const latest = await fetchLatest()
  if (!latest) return null
  writeCache(latest)
  const cmp = compareVersions(currentVersion, latest)
  if (cmp === null) return null
  return { current: currentVersion, latest, behind: cmp < 0, source: 'network' }
}
