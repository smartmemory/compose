/**
 * COMP-DEPS-PACKAGE — external skill dependency manifest helpers.
 *
 * Three exported functions used by `bin/compose.js` (and tested in
 * `test/comp-deps-package.test.js`):
 *
 *   loadDeps(packageRoot)                — load and validate .compose-deps.json
 *   checkExternalSkills(deps, home?)     — scan disk, return present/missing dep records
 *   printDepReport(result, opts?)        — human or JSON output, returns true if all required deps present
 *
 * Manifest schema is documented in docs/features/COMP-DEPS-PACKAGE/blueprint.md.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

/**
 * Load .compose-deps.json from `packageRoot`. Returns the parsed manifest with
 * invalid entries filtered out (skip-and-warn), or null if the manifest file
 * is missing/unparseable/structurally invalid.
 */
export function loadDeps(packageRoot) {
  const manifestPath = join(packageRoot, '.compose-deps.json')
  if (!existsSync(manifestPath)) return null
  let raw
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch (e) {
    console.warn(`Warning: failed to parse .compose-deps.json: ${e.message}`)
    return null
  }
  if (raw.version !== 1) {
    console.warn(`Warning: .compose-deps.json version ${raw.version} unsupported (expected 1)`)
    return null
  }
  if (!Array.isArray(raw.external_skills)) {
    console.warn('Warning: .compose-deps.json external_skills must be an array')
    return null
  }
  const valid = []
  for (const dep of raw.external_skills) {
    const idOk = typeof dep?.id === 'string'
    const reqOk = Array.isArray(dep?.required_for) && dep.required_for.every(v => typeof v === 'string')
    const installOk = typeof dep?.install === 'string'
    const fallbackOk = dep?.fallback === null || typeof dep?.fallback === 'string'
    const optOk = typeof dep?.optional === 'boolean'
    if (!(idOk && reqOk && installOk && fallbackOk && optOk)) {
      console.warn(`Warning: skipping invalid dep entry in .compose-deps.json: ${JSON.stringify(dep)}`)
      continue
    }
    valid.push(dep)
  }

  // COMP-RTK-INTEROP: external_binaries is optional and additive. A missing or
  // malformed array degrades to [] — it never nulls the whole manifest (the
  // required external_skills check above remains the only fatal gate).
  const validBinaries = []
  if (raw.external_binaries !== undefined) {
    if (!Array.isArray(raw.external_binaries)) {
      console.warn('Warning: .compose-deps.json external_binaries must be an array — ignoring')
    } else {
      for (const bin of raw.external_binaries) {
        const idOk = typeof bin?.id === 'string'
        const detectOk = typeof bin?.detect === 'string'
        const installOk = typeof bin?.install === 'string'
        const optOk = typeof bin?.optional === 'boolean'
        // required_for / recommend are optional; validate only when present.
        const reqOk = bin?.required_for === undefined
          || (Array.isArray(bin.required_for) && bin.required_for.every(v => typeof v === 'string'))
        const recOk = bin?.recommend === undefined || bin?.recommend === null || typeof bin?.recommend === 'string'
        if (!(idOk && detectOk && installOk && optOk && reqOk && recOk)) {
          console.warn(`Warning: skipping invalid binary entry in .compose-deps.json: ${JSON.stringify(bin)}`)
          continue
        }
        validBinaries.push(bin)
      }
    }
  }

  return { ...raw, external_skills: valid, external_binaries: validBinaries }
}

/**
 * Scan disk for installed skills and commands matching the manifest's deps.
 * Returns { present: [...], missing: [...], scannedPaths: [...] }.
 *
 * Scans:
 *   - <home>/.claude/skills/<id>/SKILL.md                                 (bare-name skills)
 *   - <home>/.claude/plugins/marketplaces/<m>/plugins/<p>/skills/<s>/SKILL.md   (pattern A)
 *   - <home>/.claude/plugins/marketplaces/<m>/plugins/<p>/commands/<n>.md       (pattern A')
 *   - <home>/.claude/plugins/marketplaces/<m>/.claude/skills/<s>/SKILL.md       (pattern B)
 *   - <home>/.claude/plugins/marketplaces/<m>/.claude/commands/<n>.md           (pattern B')
 *   - <home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<s>/SKILL.md  (pattern C)
 */
export function checkExternalSkills(deps, home = homedir()) {
  const userSkillsRoot = join(home, '.claude', 'skills')
  const marketplacesRoot = join(home, '.claude', 'plugins', 'marketplaces')
  const cacheRoot = join(home, '.claude', 'plugins', 'cache')
  const scannedPaths = [userSkillsRoot, marketplacesRoot, cacheRoot]

  const bareInstalled = new Set()
  const namespacedInstalled = new Set()
  // Leaf names of namespaced (plugin-provided) skills. Claude Code surfaces many
  // plugin skills under their bare leaf name (e.g. coder-config's `refactor`),
  // so a bare manifest dep is satisfied by a same-leaf plugin skill.
  const namespacedLeaves = new Set()
  const addNs = (ns, leaf) => {
    namespacedInstalled.add(`${ns}:${leaf}`)
    namespacedLeaves.add(leaf)
  }

  // Helpers: list only entries of a given dirent kind, swallow scandir errors.
  const listDirs = (path) => {
    if (!existsSync(path)) return []
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch { return [] }
  }
  const listFiles = (path) => {
    if (!existsSync(path)) return []
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => e.name)
    } catch { return [] }
  }

  // 1. Bare-name user skills
  for (const entry of listDirs(userSkillsRoot)) {
    if (existsSync(join(userSkillsRoot, entry, 'SKILL.md'))) bareInstalled.add(entry)
  }

  // 2. Marketplaces — skills (A, B) and commands (A', B')
  for (const m of listDirs(marketplacesRoot)) {
    // Pattern A / A': marketplaces/<m>/plugins/<p>/{skills,commands}/...
    const pluginsDir = join(marketplacesRoot, m, 'plugins')
    for (const p of listDirs(pluginsDir)) {
      const skillsDir = join(pluginsDir, p, 'skills')
      for (const s of listDirs(skillsDir)) {
        if (existsSync(join(skillsDir, s, 'SKILL.md'))) addNs(p, s)
      }
      const commandsDir = join(pluginsDir, p, 'commands')
      for (const f of listFiles(commandsDir)) {
        if (f.endsWith('.md')) addNs(p, f.slice(0, -3))
      }
    }
    // Pattern B / B': marketplaces/<m>/.claude/{skills,commands}/...
    const dotSkillsDir = join(marketplacesRoot, m, '.claude', 'skills')
    for (const s of listDirs(dotSkillsDir)) {
      if (existsSync(join(dotSkillsDir, s, 'SKILL.md'))) addNs(m, s)
    }
    const dotCommandsDir = join(marketplacesRoot, m, '.claude', 'commands')
    for (const f of listFiles(dotCommandsDir)) {
      if (f.endsWith('.md')) addNs(m, f.slice(0, -3))
    }
  }

  // 3. Cache — pattern C: cache/<marketplace>/<plugin>/<version>/skills/<s>/SKILL.md
  for (const marketplace of listDirs(cacheRoot)) {
    for (const plugin of listDirs(join(cacheRoot, marketplace))) {
      for (const version of listDirs(join(cacheRoot, marketplace, plugin))) {
        const skillsDir = join(cacheRoot, marketplace, plugin, version, 'skills')
        for (const s of listDirs(skillsDir)) {
          if (existsSync(join(skillsDir, s, 'SKILL.md'))) addNs(plugin, s)
        }
      }
    }
  }

  const present = []
  const missing = []
  for (const dep of deps.external_skills) {
    const isNamespaced = dep.id.includes(':')
    // Namespaced dep: require the exact <plugin>:<skill> match.
    // Bare dep: a user skill at ~/.claude/skills/<id>/ OR any plugin skill whose
    // leaf name is <id> (Claude Code exposes those under the bare name).
    const found = isNamespaced
      ? namespacedInstalled.has(dep.id)
      : (bareInstalled.has(dep.id) || namespacedLeaves.has(dep.id))
    if (found) present.push(dep); else missing.push(dep)
  }

  return { present, missing, scannedPaths }
}

/**
 * Print human or JSON dep report. Returns true if all required (non-optional) deps present.
 *
 * opts:
 *   json    — emit JSON with full dep records (id, required_for, install, fallback, optional)
 *   verbose — also list scanned paths in human mode
 */
/**
 * Build a JSON-serializable dep report. Used by both `printDepReport` and
 * callers that need to merge the report with other top-level fields (e.g.
 * `compose doctor --json` adding a version block) into a single JSON document.
 *
 * @param {object} result - from checkExternalSkills
 * @returns {{present:object[], missing:object[], scannedPaths:string[]}}
 */
export function buildDepReport(result) {
  const projectDep = (d) => ({
    id: d.id,
    required_for: d.required_for,
    install: d.install,
    fallback: d.fallback ?? null,
    optional: d.optional,
  })
  return {
    present: result.present.map(projectDep),
    missing: result.missing.map(projectDep),
    scannedPaths: result.scannedPaths,
  }
}

/**
 * COMP-RTK-INTEROP — probe each declared external *binary* (e.g. rtk) on PATH.
 *
 * Returns { present: [...], missing: [...] }. Optional binaries never make the
 * doctor fail; this only reports availability + install/recommend hints.
 *
 * @param {object} deps - from loadDeps (uses deps.external_binaries)
 * @param {object} [opts]
 * @param {(detect:string)=>boolean} [opts.probe] - injectable for tests; default
 *        splits the `detect` string on whitespace and runs it, treating exit 0 as present.
 */
export function checkExternalBinaries(deps, opts = {}) {
  const binaries = deps?.external_binaries ?? []
  const probe = opts.probe ?? ((detect) => {
    const parts = detect.trim().split(/\s+/)
    const [bin, ...binArgs] = parts
    try {
      return spawnSync(bin, binArgs, { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' }).status === 0
    } catch {
      return false
    }
  })
  const present = []
  const missing = []
  for (const bin of binaries) {
    if (probe(bin.detect)) present.push(bin); else missing.push(bin)
  }
  return { present, missing }
}

/**
 * Build a JSON-serializable binary report (mirrors buildDepReport for binaries).
 */
export function buildBinaryReport(result) {
  const projectBin = (b) => ({
    id: b.id,
    detect: b.detect,
    install: b.install,
    recommend: b.recommend ?? null,
    optional: b.optional,
  })
  return {
    present: result.present.map(projectBin),
    missing: result.missing.map(projectBin),
  }
}

/**
 * Print a human-readable external-binary report. Returns true if all required
 * (non-optional) binaries are present. Prints nothing when no binaries are declared.
 */
export function printBinaryReport(result) {
  const total = result.present.length + result.missing.length
  if (total === 0) return true

  console.log('\nExternal binaries:')
  for (const bin of result.present) {
    const rec = bin.recommend ? `  — recommend: ${bin.recommend}` : ''
    console.log(`  ✓ ${bin.id}${rec}`)
  }
  for (const bin of result.missing) {
    const mark = bin.optional ? '○' : '✗'
    const tag = bin.optional ? ' (optional)' : ''
    const rec = bin.recommend ? `  — recommend: ${bin.recommend}` : ''
    console.log(`  ${mark} ${bin.id}${tag} — install: ${bin.install}${rec}`)
  }
  return result.missing.every(b => b.optional)
}

export function printDepReport(result, opts = {}) {
  if (opts.json) {
    console.log(JSON.stringify(buildDepReport(result), null, 2))
    return result.missing.every(d => d.optional)
  }

  console.log('\nExternal skill dependencies:')
  for (const dep of result.present) {
    console.log(`  ✓ ${dep.id}`)
  }

  const missingRequired = result.missing.filter(d => !d.optional)
  const missingOptional = result.missing.filter(d => d.optional)

  for (const dep of missingRequired) {
    console.log(`  ✗ ${dep.id}  — install: ${dep.install}`)
  }
  for (const dep of missingOptional) {
    console.log(`  ○ ${dep.id} (optional) — install: ${dep.install}`)
  }

  const total = result.present.length + result.missing.length
  if (result.missing.length === 0) {
    console.log(`\nAll ${total} deps present.`)
  } else {
    console.log(`\n${result.missing.length} of ${total} deps missing (${missingRequired.length} required, ${missingOptional.length} optional).`)
    if (missingRequired.length > 0) {
      console.log('Lifecycle will run in degraded mode for affected phases. See SKILL.md §Dependencies for fallback paths.')
    }
  }

  if (opts.verbose) {
    console.log('\nScanned paths:')
    for (const p of result.scannedPaths) console.log(`  ${p}`)
  }

  return missingRequired.length === 0
}
