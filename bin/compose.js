#!/usr/bin/env node
/**
 * compose CLI
 *
 * compose init     — initialize Compose in the current project (project-local)
 * compose setup    — install global skill + register stratum-mcp (user-global)
 * compose install  — run init + setup (backwards-compat alias)
 * compose start    — start the compose app (supervisor.js)
 * compose build    — headless feature lifecycle runner
 * compose fix      — headless bug-fix lifecycle runner (pipelines/bug-fix.stratum.yaml)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, readdirSync } from 'fs'
import { resolve, join, basename, dirname, sep } from 'path'
import { homedir } from 'os'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { findProjectRoot } from '../server/find-root.js'
import { resolveWorkspace, getWorkspaceFlag } from '../lib/resolve-workspace.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(__dirname, '..')

function dieOnWorkspaceError(err) {
  switch (err.code) {
    case 'WorkspaceAmbiguous':
      console.error('Multiple workspaces match cwd. Add --workspace=<id> or set COMPOSE_TARGET:')
      for (const c of err.candidates) console.error(`  --workspace=${c.id}    (${c.root})`)
      process.exit(1)
    case 'WorkspaceIdCollision':
      console.error(`workspaceId "${err.id}" is used by multiple roots:`)
      for (const r of err.roots) console.error(`  ${r}`)
      console.error('Set an explicit workspaceId in each .compose/compose.json.')
      process.exit(1)
    case 'WorkspaceUnknown':
      // err.message may be the path-doesn't-exist form; prefer it when richer.
      console.error(err.message.includes('does not exist') ? err.message : `Unknown workspace: ${err.id}. Run \`compose doctor\` to list candidates.`)
      process.exit(1)
    case 'WorkspaceUnset':
      console.error('No compose workspace found from the current directory.')
      console.error('Run `compose init` to scaffold one, or cd into a project that has a .compose/ directory.')
      process.exit(1)
    case 'WorkspaceDiscoveryTooBroad':
      console.error('Workspace discovery exceeded its bound from anchor.')
      console.error('Set COMPOSE_TARGET=/absolute/path/to/workspace to bypass discovery.')
      process.exit(1)
    default:
      throw err
  }
}

// Cache the resolved cwd for the lifetime of this CLI process. resolveCwdWithWorkspace
// strips --workspace from args on first call (via getWorkspaceFlag splice), so a second
// call would re-resolve without the hint. Cache prevents this; ensures auto-init paths
// (runInit re-entry from build/fix/import/new) see the same workspace.
//
// COMP-WORKSPACE-HTTP T7: shape changed from bare string root → { root, id }.
// Consumers read `.root` for path; HTTP callers read `.id` to inject
// `X-Compose-Workspace-Id` header. id may be null/undefined when a workspace
// resolved without an id (legacy projects).
let _resolvedCwdCache = null

function resolveCwdWithWorkspace(args) {
  if (_resolvedCwdCache !== null) return _resolvedCwdCache
  let wsId = getWorkspaceFlag(args)
  // Legacy hooks may pass the unsubstituted token literally — treat as absent.
  if (wsId === '__COMPOSE_WORKSPACE_ID__') {
    console.warn('[compose] hook predates workspace-aware install — re-run `compose hooks install`')
    wsId = null
  }
  try {
    const ws = resolveWorkspace({ workspaceId: wsId })
    _resolvedCwdCache = { root: ws.root, id: ws.id }
    return _resolvedCwdCache
  } catch (err) {
    dieOnWorkspaceError(err)
  }
}

// ---------------------------------------------------------------------------
// --team flag (COMP-TEAMS)
// ---------------------------------------------------------------------------
import { parseTeamFlag } from '../lib/team-flag.js';
import { loadDeps, checkExternalSkills, printDepReport, buildDepReport } from '../lib/deps.js';
import { checkLatestVersion } from '../lib/version-check.js';

const [,, cmd, ...args] = process.argv

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
  const pkgPath = join(PACKAGE_ROOT, 'package.json')
  let version = 'unknown'
  try { version = JSON.parse(readFileSync(pkgPath, 'utf-8')).version } catch {}
  console.log(`compose ${version}`)
  const gitDir = join(PACKAGE_ROOT, '.git')
  if (existsSync(gitDir)) {
    const sha = spawnSync('git', ['-C', PACKAGE_ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' })
    if (sha.status === 0) console.log(`  git: ${sha.stdout.trim()}`)
  }
  console.log(`  root: ${PACKAGE_ROOT}`)
  process.exit(0)
}

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('Usage: compose <command>')
  console.log('')
  console.log('Commands:')
  console.log('  new       Kickoff a product (research, brainstorm, roadmap, scaffold)')
  console.log('  import    Scan existing project and generate structured analysis')
  console.log('  feature   Add a single feature (folder, design seed, ROADMAP entry)')
  console.log('  build     Run a feature through the headless lifecycle')
  console.log('  fix       Run a bug through the headless bug-fix lifecycle')
  console.log('  gsd       Per-task fresh-context dispatch from existing blueprint+Boundary Map')
  console.log('  pipeline  View and edit the build pipeline')
  console.log('  roadmap            Show roadmap status and next buildable features')
  console.log('  roadmap generate   Regenerate ROADMAP.md from feature.json files')
  console.log('  roadmap migrate    Extract ROADMAP.md entries into feature.json files')
  console.log('  roadmap check      Verify feature.json and ROADMAP.md are in sync')
  console.log('  triage    Analyze a feature and recommend build profile')
  console.log('  qa-scope  Show affected routes from a feature\'s changed files')
  console.log('  init      Initialize Compose in the current project')
  console.log('  setup     Install global skill + register stratum-mcp')
  console.log('  update    Pull latest compose, reinstall deps, refresh global skill')
  console.log('  doctor    Check external skill dependencies')
  console.log('  --version Print compose version, git SHA, and install root')
  process.exit(0)
}

// ---------------------------------------------------------------------------
// compose init — project-local setup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent detection + skill installation
// ---------------------------------------------------------------------------

function detectAgents() {
  const agents = []
  const home = homedir()

  // Claude Code
  const hasClaude = spawnSync('which', ['claude'], { encoding: 'utf-8' }).status === 0
    || existsSync(join(home, '.claude'))
  if (hasClaude) {
    agents.push({ name: 'claude', skillDir: join(home, '.claude', 'skills', 'stratum') })
  }

  // Codex (via opencode) — shares ~/.claude/skills/ with Claude Code
  const hasCodex = spawnSync('which', ['opencode'], { encoding: 'utf-8' }).status === 0
    || existsSync(join(home, '.codex'))
  if (hasCodex) {
    agents.push({ name: 'codex', skillDir: join(home, '.claude', 'skills', 'stratum'), sharedWith: 'claude' })
  }

  // Gemini CLI
  const hasGemini = spawnSync('which', ['gemini-cli'], { encoding: 'utf-8' }).status === 0
    || existsSync(join(home, '.gemini'))
  if (hasGemini) {
    agents.push({ name: 'gemini', skillDir: join(home, '.gemini', 'skills', 'stratum') })
  }

  return agents
}

/**
 * Sync compose-owned skills to ~/.claude/skills/ (and other agent skill dirs).
 * Copies all skills from source dirs, removes previously-installed skills that
 * no longer exist in source. Tracks installed set via a manifest file.
 *
 * Source dirs:
 *   - PACKAGE_ROOT/.claude/skills/*   (compose skill)
 *   - PACKAGE_ROOT/skills/*           (stratum base skill)
 */
function syncSkills(agents) {
  // Collect source skills: { name -> sourcePath }
  const sourceSkills = new Map()
  const skillSourceDirs = [
    join(PACKAGE_ROOT, '.claude', 'skills'),
    join(PACKAGE_ROOT, 'skills'),
  ]
  for (const dir of skillSourceDirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const skillFile = join(dir, entry, 'SKILL.md')
      if (existsSync(skillFile)) {
        sourceSkills.set(entry, skillFile)
      }
    }
  }

  if (sourceSkills.size === 0) {
    console.log('Warning: no skills found to install')
    return
  }

  console.log('\nSyncing skills...')
  const syncedRoots = new Set()
  for (const agent of agents) {
    if (agent.name === 'gemini') {
      console.log(`  - ${agent.name} — detected but skill sync skipped (unverified path)`)
      continue
    }
    // Skip if this agent shares a skill dir already synced (e.g. codex → ~/.claude/skills/)
    const agentRoot = dirname(agent.skillDir)
    if (syncedRoots.has(agentRoot)) {
      console.log(`  ~ ${agent.name} — shares skill dir with ${agent.sharedWith ?? 'another agent'}, skipped`)
      continue
    }
    syncedRoots.add(agentRoot)

    const agentSkillsRoot = agentRoot
    const manifestPath = join(agentSkillsRoot, '.compose-skills.json')

    // Load previous manifest
    let previousSkills = []
    if (existsSync(manifestPath)) {
      try { previousSkills = JSON.parse(readFileSync(manifestPath, 'utf-8')) } catch {}
    }

    // Install current skills
    for (const [name, srcPath] of sourceSkills) {
      const destDir = join(agentSkillsRoot, name)
      mkdirSync(destDir, { recursive: true })
      copyFileSync(srcPath, join(destDir, 'SKILL.md'))
      console.log(`  + ${agent.name}/${name}`)
    }

    // Copy .compose-deps.json next to the compose SKILL.md so the lifecycle
    // can read it as a fallback when `compose doctor` is unreachable.
    const depsSrc = join(PACKAGE_ROOT, '.compose-deps.json')
    const composeSkillDir = join(agentSkillsRoot, 'compose')
    if (existsSync(depsSrc) && existsSync(composeSkillDir)) {
      copyFileSync(depsSrc, join(composeSkillDir, '.compose-deps.json'))
    }

    // Remove skills we previously installed that no longer exist in source
    const removed = previousSkills.filter(name => !sourceSkills.has(name))
    for (const name of removed) {
      const destDir = join(agentSkillsRoot, name)
      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true })
        console.log(`  - ${agent.name}/${name} (removed)`)
      }
    }

    // Write updated manifest
    writeFileSync(manifestPath, JSON.stringify([...sourceSkills.keys()], null, 2))
  }

  // Report undetected agents
  const detected = new Set(agents.map(a => a.name))
  for (const name of ['claude', 'codex', 'gemini']) {
    if (!detected.has(name)) {
      console.log(`  - ${name} — not found`)
    }
  }

  // External skill dep check — surface missing plugins / user skills with
  // actionable install hints. Soft check: warnings only, exit code unaffected.
  const deps = loadDeps(PACKAGE_ROOT)
  if (deps) {
    const result = checkExternalSkills(deps)
    printDepReport(result)
  }
}

// ---------------------------------------------------------------------------
// compose doctor — re-run the external dep check
// ---------------------------------------------------------------------------

async function runDoctor(flags = []) {
  const json = flags.includes('--json')
  const strict = flags.includes('--strict')
  const verbose = flags.includes('--verbose') || flags.includes('-v')
  const refresh = flags.includes('--refresh-versions')

  const deps = loadDeps(PACKAGE_ROOT)
  if (!deps) {
    console.error('Error: .compose-deps.json missing or invalid at package root')
    process.exit(1)
  }
  const result = checkExternalSkills(deps)

  // Version drift check — never fails the doctor run.
  const currentVersion = (() => {
    try { return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version }
    catch { return null }
  })()
  const versionInfo = await checkLatestVersion(currentVersion, { force: refresh })

  if (json) {
    // Single top-level JSON document — the deps report and the version block share one root
    // so consumers like `JSON.parse(stdout)` work. (Previously two concatenated objects.)
    const report = buildDepReport(result)
    console.log(JSON.stringify({ ...report, version: versionInfo }, null, 2))
    const allRequiredPresent = result.missing.every(d => d.optional)
    if (strict && !allRequiredPresent) process.exit(1)
    return
  }

  // Version section — printed first so it's visible above long dep lists.
  console.log('Version:')
  console.log(`  installed: ${currentVersion ?? 'unknown'}`)
  if (versionInfo) {
    console.log(`  latest:    ${versionInfo.latest} (${versionInfo.source})`)
    if (versionInfo.behind) {
      console.log(`  ⚠ behind — run: compose update`)
    } else {
      console.log(`  ✓ up to date`)
    }
  } else {
    console.log(`  latest:    unavailable (registry unreachable or cache missing)`)
  }

  const allRequiredPresent = printDepReport(result, { json: false, verbose })
  if (strict && !allRequiredPresent) process.exit(1)
}

// ---------------------------------------------------------------------------
// compose init — project-local setup
// ---------------------------------------------------------------------------

async function runInit(flags) {
  const noStratum = flags.includes('--no-stratum')
  const noLifecycle = flags.includes('--no-lifecycle')
  // init creates the workspace — never go through resolveCwdWithWorkspace (which
  // requires one to exist). Strip --workspace if present to avoid leaving it in
  // the shared args array for downstream subcommands.
  getWorkspaceFlag(args)
  const cwd = process.cwd()

  // 1. Create .compose/ directory
  const composeDir = join(cwd, '.compose')
  mkdirSync(composeDir, { recursive: true })

  // 2. Detect / auto-install stratum
  let hasStratum = !noStratum && spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
  if (!noStratum && !hasStratum) {
    console.log('stratum-mcp not found — installing via pip...')
    const pipResult = spawnSync('pip', ['install', 'stratum'], {
      stdio: 'inherit',
      encoding: 'utf-8',
    })
    if (pipResult.status === 0) {
      // Verify the binary is now on PATH
      hasStratum = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
      if (hasStratum) {
        console.log('stratum-mcp installed successfully')
      } else {
        console.warn('Warning: pip install stratum succeeded but stratum-mcp not found on PATH')
      }
    } else {
      console.warn('Warning: pip install stratum failed — Stratum will be disabled')
      console.warn('  Install manually: pip install stratum')
    }
  }
  const hasLifecycle = !noLifecycle

  // 3. Detect agents
  const agents = detectAgents()

  // 4. Write .compose/compose.json (merge with existing if present)
  const configPath = join(composeDir, 'compose.json')
  let existing = {}
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  }

  const agentsConfig = {}
  for (const agent of agents) {
    agentsConfig[agent.name] = { detected: true, skillInstalled: agent.name !== 'gemini' }
  }
  for (const name of ['claude', 'codex', 'gemini']) {
    if (!agentsConfig[name]) {
      agentsConfig[name] = { detected: false }
    }
  }

  const config = {
    version: 2,
    capabilities: {
      ...(existing.capabilities || {}),
      stratum: hasStratum,
      lifecycle: hasLifecycle,
    },
    agents: {
      ...(existing.agents || {}),
      ...agentsConfig,
    },
    paths: {
      docs: 'docs',
      features: 'docs/features',
      journal: 'docs/journal',
      context: 'docs/context',
      ideabox: 'docs/product/ideabox.md',
      ...(existing.paths || {}),
    },
  }

  // Flags override existing values
  if (noStratum) config.capabilities.stratum = false
  if (noLifecycle) config.capabilities.lifecycle = false

  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`Wrote ${configPath}`)

  // 5. Create .compose/data/
  mkdirSync(join(composeDir, 'data'), { recursive: true })

  // 5b. Scaffold docs/context/ with ambient context templates
  const contextDir = join(cwd, config.paths.context)
  mkdirSync(contextDir, { recursive: true })
  const contextTemplates = {
    'tech-stack.md': '# Tech Stack\n\nDescribe your technology stack here.\n',
    'conventions.md': '# Conventions\n\nDescribe coding conventions here.\n',
    'decisions.md': '# Decision Log\n\nDecisions accumulate here during builds.\n',
  }
  for (const [filename, content] of Object.entries(contextTemplates)) {
    const dest = join(contextDir, filename)
    if (!existsSync(dest)) {
      writeFileSync(dest, content)
      console.log(`Created ${dest}`)
    }
  }

  // 5c. Scaffold docs/product/ideabox.md if absent
  const ideaboxRel = config.paths.ideabox || 'docs/product/ideabox.md'
  const ideaboxDest = join(cwd, ideaboxRel)
  if (!existsSync(ideaboxDest)) {
    mkdirSync(dirname(ideaboxDest), { recursive: true })
    const { IDEABOX_TEMPLATE } = await import('../lib/ideabox.js')
    writeFileSync(ideaboxDest, IDEABOX_TEMPLATE)
    console.log(`Created ${ideaboxDest}`)
  }

  // 6. Register compose-mcp in .mcp.json
  const mcpPath = join(cwd, '.mcp.json')
  let mcpConfig = {}
  if (existsSync(mcpPath)) {
    try { mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf-8')) } catch {}
  }
  mcpConfig.mcpServers = mcpConfig.mcpServers || {}
  mcpConfig.mcpServers.compose = {
    command: 'node',
    args: [join(PACKAGE_ROOT, 'server', 'compose-mcp.js')],
  }
  // T2-F5 retirement: remove legacy 'agents' entry. The file it points to is
  // now a retirement shim that exits non-zero with a migration message;
  // removing the entry prevents Claude Code from spawning the shim on session start.
  // The agent_run capability lives on stratum-mcp as stratum_agent_run.
  if (mcpConfig.mcpServers.agents) {
    delete mcpConfig.mcpServers.agents
    console.log('Removed retired agents MCP server from .mcp.json (T2-F5). '
      + 'Use stratum_agent_run on the stratum MCP server instead.')
  }
  if (hasStratum && !mcpConfig.mcpServers.stratum) {
    // Use absolute path — miniconda/pip binaries may not be on Claude Code's PATH
    const stratumPath = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).stdout.trim()
    mcpConfig.mcpServers.stratum = {
      command: stratumPath || 'stratum-mcp',
    }
    console.log('Registered stratum-mcp in .mcp.json')
  }
  writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2))
  console.log(`Registered compose-mcp in ${mcpPath}`)

  // 6b. Run stratum-mcp install to register hooks + CLAUDE.md in this project
  if (hasStratum) {
    console.log('Running stratum-mcp install for hooks...')
    const stratumResult = spawnSync('stratum-mcp', ['install'], { cwd, stdio: 'inherit' })
    if (stratumResult.status !== 0) {
      console.warn('Warning: stratum-mcp install failed (hooks may not be registered)')
    }
  }

  // 7. Scaffold ROADMAP.md from template if absent
  const roadmapDest = join(cwd, 'ROADMAP.md')
  if (!existsSync(roadmapDest)) {
    const roadmapSrc = join(PACKAGE_ROOT, 'templates', 'ROADMAP.md')
    if (existsSync(roadmapSrc)) {
      const projectName = basename(cwd)
      const today = new Date().toISOString().slice(0, 10)
      let template = readFileSync(roadmapSrc, 'utf-8')
      template = template
        .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
        .replace(/\{\{PROJECT_DESCRIPTION\}\}/g, 'describe your project here')
        .replace(/\{\{DATE\}\}/g, today)
      writeFileSync(roadmapDest, template)
      console.log('Created ROADMAP.md from template')
    }
  }

  // 8. Copy default pipeline specs if absent
  const pipelinesDir = join(cwd, 'pipelines')
  mkdirSync(pipelinesDir, { recursive: true })
  for (const specName of ['build.stratum.yaml', 'new.stratum.yaml']) {
    const dest = join(pipelinesDir, specName)
    if (!existsSync(dest)) {
      const src = join(PACKAGE_ROOT, 'pipelines', specName)
      if (existsSync(src)) {
        copyFileSync(src, dest)
        console.log(`Copied default pipeline to ${dest}`)
      }
    }
  }

  // 9. Sync all compose-owned skills to detected agents
  syncSkills(agents)

  // 10. Summary
  console.log('')
  console.log('Compose initialized:')
  console.log(`  Stratum:   ${config.capabilities.stratum ? 'enabled' : 'disabled'}`)
  console.log(`  Lifecycle: ${config.capabilities.lifecycle ? 'enabled' : 'disabled'}`)
  console.log(`  Agents:    ${agents.map(a => a.name).join(', ') || 'none detected'}`)
}

// ---------------------------------------------------------------------------
// compose setup — user-global setup
// ---------------------------------------------------------------------------

function runSetup() {
  // 1. Sync all compose-owned skills to detected agents.
  //    If none detected, fall back to Claude — setup is unconditional
  //    "install global skill" per its help text.
  let agents = detectAgents()
  if (agents.length === 0) {
    agents = [{ name: 'claude', skillDir: join(homedir(), '.claude', 'skills', 'stratum') }]
  }
  syncSkills(agents)

  // 2. Register stratum-mcp if available
  const hasStratum = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
  if (hasStratum) {
    console.log('Registering stratum-mcp with Claude Code...')
    const result = spawnSync('stratum-mcp', ['install'], { stdio: 'inherit' })
    if (result.status !== 0) {
      console.warn('Warning: stratum-mcp install failed (non-fatal)')
    }
  } else {
    console.log('stratum-mcp not found — skipping global registration')
    console.log('  Install later: pip install stratum && compose setup')
  }
}

// ---------------------------------------------------------------------------
// compose update — pull latest, reinstall deps, refresh global skill
// ---------------------------------------------------------------------------

function detectInstallStyle() {
  // npm install resolves bin to either:
  //   - global: /<prefix>/lib/node_modules/@smartmemory/compose/bin/compose.js
  //   - local:  <project>/node_modules/@smartmemory/compose/bin/compose.js
  //   - npx cache: ~/.npm/_npx/<hash>/node_modules/@smartmemory/compose/bin/compose.js
  // git clone places it under any path WITHOUT a node_modules ancestor that
  // contains the package itself, but WITH a .git directory at PACKAGE_ROOT.
  if (PACKAGE_ROOT.includes(`${sep}node_modules${sep}`)) {
    return { style: 'npm', root: PACKAGE_ROOT }
  }
  if (existsSync(join(PACKAGE_ROOT, '.git'))) {
    return { style: 'git', root: PACKAGE_ROOT }
  }
  return { style: 'unknown', root: PACKAGE_ROOT }
}

function getPkgVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')).version
  } catch { return 'unknown' }
}

function getGitSha(repoPath) {
  const r = spawnSync('git', ['-C', repoPath, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' })
  return r.status === 0 ? r.stdout.trim() : null
}

async function runUpdate(flags) {
  const force = flags.includes('--force')
  // update is user-global — workspace is optional. Try to resolve; if no
  // workspace exists, just use process.cwd() (we may still operate on
  // user-global state below).
  const wsId = getWorkspaceFlag(args)
  let cwd
  try {
    const ws = resolveWorkspace({ workspaceId: wsId })
    cwd = ws.root
    _resolvedCwdCache = { root: ws.root, id: ws.id }
  } catch (err) {
    // Only WorkspaceUnset is benign for `update` (user-global). Any explicit
    // mistake (bad --workspace, collision, ambiguity, too-broad) should still die.
    if (err.code !== 'WorkspaceUnset') dieOnWorkspaceError(err)
    cwd = process.cwd()
  }
  const { style, root } = detectInstallStyle()

  console.log(`compose update — install style: ${style}`)
  console.log(`  root: ${root}`)
  console.log(`  current: v${getPkgVersion()}${style === 'git' ? ` @ ${getGitSha(root) || '?'}` : ''}`)
  console.log('')

  if (style === 'unknown') {
    console.error('Cannot determine install style. Expected either:')
    console.error(`  - npm install: PACKAGE_ROOT inside node_modules`)
    console.error(`  - git clone:   .git directory at ${root}`)
    console.error('Reinstall with: npm install -g @smartmemory/compose')
    process.exit(1)
  }

  if (style === 'npm') {
    // Decide global vs local: global if root is under a global prefix.
    const npmPrefix = spawnSync('npm', ['prefix', '-g'], { encoding: 'utf-8' }).stdout.trim()
    const isGlobal = npmPrefix && root.startsWith(npmPrefix)
    const installCmd = isGlobal
      ? ['install', '-g', '@smartmemory/compose@latest']
      : ['install', '@smartmemory/compose@latest']
    console.log(`Running: npm ${installCmd.join(' ')}`)
    const r = spawnSync('npm', installCmd, { stdio: 'inherit' })
    if (r.status !== 0) {
      console.error('npm install failed')
      process.exit(r.status || 1)
    }
  } else {
    // git clone — check clean, fast-forward pull, npm install
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf-8' })
    if (status.stdout.trim() && !force) {
      console.error(`Working tree at ${root} has uncommitted changes.`)
      console.error('Commit/stash them, or re-run with --force to skip the check.')
      process.exit(1)
    }
    const beforeSha = getGitSha(root)
    console.log(`Running: git fetch && git pull --ff-only`)
    const fetch = spawnSync('git', ['-C', root, 'fetch'], { stdio: 'inherit' })
    if (fetch.status !== 0) { process.exit(fetch.status || 1) }
    const pull = spawnSync('git', ['-C', root, 'pull', '--ff-only'], { stdio: 'inherit' })
    if (pull.status !== 0) {
      console.error('git pull --ff-only failed (likely diverged from remote).')
      console.error(`Reconcile manually in ${root}, then re-run compose update.`)
      process.exit(pull.status || 1)
    }
    const afterSha = getGitSha(root)
    if (beforeSha === afterSha) {
      console.log(`Already up to date at ${afterSha}.`)
    } else {
      console.log(`Updated ${beforeSha} → ${afterSha}`)
    }

    console.log('Running: npm install')
    const ni = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit' })
    if (ni.status !== 0) { process.exit(ni.status || 1) }
  }

  // Refresh global skill + stratum-mcp registration
  console.log('')
  console.log('Refreshing global skill installation...')
  runSetup()

  // If invoked from inside a Compose project, refresh project artifacts too
  if (existsSync(join(cwd, '.compose', 'compose.json'))) {
    console.log('')
    console.log(`Refreshing project at ${cwd}...`)
    await runInit([])
  }

  console.log('')
  console.log(`compose updated to v${getPkgVersion()}${style === 'git' ? ` @ ${getGitSha(root) || '?'}` : ''}`)
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

if (cmd === 'init') {
  await runInit(args)
  process.exit(0)
}

if (cmd === 'setup') {
  runSetup()
  process.exit(0)
}

if (cmd === 'doctor') {
  await runDoctor(args)
  process.exit(0)
}

if (cmd === 'update' || cmd === 'upgrade') {
  await runUpdate(args)
  process.exit(0)
}

if (cmd === 'install') {
  // Backwards-compat: run both init + setup
  await runInit(args)
  runSetup()
  process.exit(0)
}

if (cmd === 'import') {
  const { root: cwd } = resolveCwdWithWorkspace(args)

  // Auto-init if needed
  if (!existsSync(join(cwd, '.compose', 'compose.json'))) {
    console.log('No .compose/ found — running init first...\n')
    await runInit(args.filter(a => a.startsWith('--')))
    console.log('')
  }

  const { runImport } = await import('../lib/import.js')
  try {
    await runImport({ cwd })
  } catch (err) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'new') {
  const autoMode = args.includes('--auto')
  const askMode = args.includes('--ask')
  const fromIdeaIdx = args.indexOf('--from-idea')
  const fromIdeaId = fromIdeaIdx !== -1 ? args[fromIdeaIdx + 1] : null
  const intent = args.filter((a, i) => !a.startsWith('-') && i !== fromIdeaIdx + 1).join(' ')

  if (!intent) {
    console.error('Usage: compose new "description of the product" [--auto] [--ask]')
    console.error('')
    console.error('Run from inside your project directory.')
    console.error('')
    console.error('Options:')
    console.error('  --auto    Skip questionnaire entirely')
    console.error('  --ask     Re-run questionnaire (uses previous answers as defaults)')
    console.error('')
    console.error('Examples:')
    console.error('  cd myapp && compose new "Structured log analyzer CLI for JSON-lines files"')
    console.error('  compose new "REST API for managing team todo lists" --auto')
    process.exit(1)
  }

  const { root: cwd } = resolveCwdWithWorkspace(args)
  const name = basename(cwd)

  // --from-idea <ID>: pre-populate intent from a promoted ideabox entry (Item 184)
  let fromIdeaIntent = ''
  if (fromIdeaId) {
    try {
      const { readIdeabox: _ribNew } = await import('../lib/ideabox.js')
      const ibCfgNew = (() => { try { return JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8')) } catch { return {} } })()
      const ibRelNew = ibCfgNew?.paths?.ideabox || 'docs/product/ideabox.md'
      const ibDataNew = _ribNew(cwd, ibRelNew)
      const foundIdea = [...ibDataNew.ideas, ...ibDataNew.killed].find(
        i => i.id.toUpperCase() === fromIdeaId.toUpperCase()
      )
      if (foundIdea) {
        const parts = [`Feature idea: ${foundIdea.title}`]
        if (foundIdea.description) parts.push(`Description: ${foundIdea.description}`)
        if (foundIdea.cluster) parts.push(`Cluster: ${foundIdea.cluster}`)
        fromIdeaIntent = parts.join('\n')
        console.log(`Pre-populating intent from ${foundIdea.id}: ${foundIdea.title}`)
      } else {
        console.warn(`--from-idea: idea not found: ${fromIdeaId}`)
      }
    } catch (err) {
      console.warn(`--from-idea: could not load idea: ${err.message}`)
    }
  }

  // Read any existing context to enrich intent
  let existingContext = ''

  // Project analysis from compose import (richest source)
  const analysisPath = join(cwd, 'docs', 'discovery', 'project-analysis.md')
  if (existsSync(analysisPath)) {
    existingContext += `\n\n--- project-analysis.md (from compose import) ---\n${readFileSync(analysisPath, 'utf-8')}`
  }

  // Key project files
  for (const contextFile of ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml']) {
    const p = join(cwd, contextFile)
    if (existsSync(p)) {
      existingContext += `\n\n--- ${contextFile} ---\n${readFileSync(p, 'utf-8')}`
    }
  }

  // Auto-init if not already initialized (or missing pipeline specs)
  if (!existsSync(join(cwd, '.compose', 'compose.json')) || !existsSync(join(cwd, 'pipelines', 'new.stratum.yaml'))) {
    console.log('Running compose init...\n')
    await runInit(args.filter(a => a.startsWith('--')))
    console.log('')
  }

  // Questionnaire: runs on first time automatically, then only with --ask
  // Skip questionnaire if a design doc exists — it provides the enriched intent
  // Also skip if --from-idea provided — the idea already carries title/description/cluster
  const hasDesignDoc = existsSync(join(cwd, 'docs', 'design.md'))
  let finalIntent = fromIdeaIntent ? `${fromIdeaIntent}${intent ? '\n\n' + intent : ''}` : intent
  let skipResearch = false
  const hasAnswers = existsSync(join(cwd, '.compose', 'questionnaire.json'))
  const runQuestionnaireNow = !autoMode && !hasDesignDoc && (!hasAnswers || askMode) && !fromIdeaId

  if (runQuestionnaireNow) {
    const { runQuestionnaire } = await import('../lib/questionnaire.js')
    const hasExisting = existingContext.length > 0
    const result = await runQuestionnaire(name, intent, { cwd, hasExistingContent: hasExisting })
    if (!result) process.exit(0) // user aborted

    finalIntent = result.enrichedIntent
    skipResearch = !result.options.doResearch

    // Apply pipeline customizations from questionnaire
    if (result.options.reviewAgent === 'Codex (automated review)') {
      const { pipelineSet } = await import('../lib/pipeline-cli.js')
      try {
        pipelineSet(cwd, 'review_gate', ['--mode', 'review'], 'new.stratum.yaml')
      } catch { /* kickoff spec missing or review_gate already absent */ }
    } else if (result.options.reviewAgent === 'Skip review') {
      const { pipelineDisable } = await import('../lib/pipeline-cli.js')
      try {
        pipelineDisable(cwd, ['review_gate'], 'new.stratum.yaml')
      } catch { /* kickoff spec missing or review_gate already absent */ }
    }
  } else if (hasAnswers && !autoMode) {
    // Load saved answers to enrich intent without prompting
    const saved = JSON.parse(readFileSync(join(cwd, '.compose', 'questionnaire.json'), 'utf-8'))
    const parts = [saved.refined ?? intent]
    parts.push(`\n## Project Constraints`)
    parts.push(`- Type: ${saved.projectType ?? 'unknown'}`)
    parts.push(`- Language/Runtime: ${saved.language ?? 'unknown'}`)
    parts.push(`- Scope: ${saved.complexity ?? 'unknown'}`)
    if (saved.notes) parts.push(`\n## Additional Context\n${saved.notes}`)
    finalIntent = parts.join('\n')
    skipResearch = saved.doResearch === false
  }

  // Build final enriched intent with existing context
  const enrichedIntent = existingContext
    ? `${finalIntent}\n\n## Existing project context\n${existingContext}`
    : finalIntent

  const { runNew } = await import('../lib/new.js')
  try {
    await runNew(enrichedIntent, { cwd, projectName: name, skipResearch })
  } catch (err) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'feature') {
  const featureCode = args.find(a => !a.startsWith('-'))
  const description = args.filter(a => !a.startsWith('-')).slice(1).join(' ')

  if (!featureCode) {
    console.error('Usage: compose feature <CODE> "description of the feature"')
    console.error('')
    console.error('Examples:')
    console.error('  compose feature LOG-1 "CLI tool for parsing JSON-lines log files"')
    console.error('  compose feature AUTH-2 "Add OAuth2 login flow with PKCE"')
    process.exit(1)
  }

  if (!description) {
    console.error(`Usage: compose feature ${featureCode} "description of the feature"`)
    process.exit(1)
  }

  const { root: cwd } = resolveCwdWithWorkspace(args)
  const configPath = join(cwd, '.compose', 'compose.json')
  if (!existsSync(configPath)) {
    console.error("No .compose/compose.json found. Run 'compose init' first.")
    process.exit(1)
  }

  let config = {}
  try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch {}
  const featuresDir = config.paths?.features || 'docs/features'

  // 1. Create feature folder + seed design doc
  const featureDir = join(cwd, featuresDir, featureCode)
  const designPath = join(featureDir, 'design.md')

  if (existsSync(designPath)) {
    console.error(`Feature ${featureCode} already exists at ${featureDir}/`)
    process.exit(1)
  }

  mkdirSync(featureDir, { recursive: true })

  // ── COMP-UX-3a: Infer project defaults ────────────────────────────────────
  // Detect language from lock files / manifests
  let detectedLang = null
  if (existsSync(join(cwd, 'package.json'))) detectedLang = 'node'
  else if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) detectedLang = 'python'
  else if (existsSync(join(cwd, 'Cargo.toml'))) detectedLang = 'rust'
  else if (existsSync(join(cwd, 'go.mod'))) detectedLang = 'go'

  // Detect test framework
  let detectedTestFramework = null
  if (detectedLang === 'node') {
    if (existsSync(join(cwd, 'jest.config.js')) || existsSync(join(cwd, 'jest.config.ts')) || existsSync(join(cwd, 'jest.config.mjs'))) detectedTestFramework = 'jest'
    else if (existsSync(join(cwd, 'vitest.config.js')) || existsSync(join(cwd, 'vitest.config.ts')) || existsSync(join(cwd, 'vitest.config.mjs'))) detectedTestFramework = 'vitest'
    else {
      // Check package.json devDependencies
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'))
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
        if (deps.jest) detectedTestFramework = 'jest'
        else if (deps.vitest) detectedTestFramework = 'vitest'
        else if (deps.mocha) detectedTestFramework = 'mocha'
      } catch { /* ignore */ }
    }
  } else if (detectedLang === 'python') {
    if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'conftest.py'))) detectedTestFramework = 'pytest'
  }

  // Count existing features for complexity estimate
  const existingFeatureCount = (() => {
    try {
      const fdir = join(cwd, featuresDir)
      if (!existsSync(fdir)) return 0
      return readdirSync(fdir, { withFileTypes: true })
        .filter(e => e.isDirectory() && existsSync(join(fdir, e.name, 'feature.json')))
        .length
    } catch { return 0 }
  })()

  // Infer smart defaults for feature.json profile
  const isSmallProject = existingFeatureCount < 3
  const profile = {
    needs_prd: !isSmallProject,
    needs_architecture: existingFeatureCount >= 3,
    needs_verification: true,
    needs_report: !isSmallProject,
    ...(detectedLang ? { language: detectedLang } : {}),
    ...(detectedTestFramework ? { test_framework: detectedTestFramework } : {}),
  }

  if (detectedLang) console.log(`Detected language: ${detectedLang}${detectedTestFramework ? ` (${detectedTestFramework})` : ''}`)
  if (existingFeatureCount > 0) console.log(`Existing features: ${existingFeatureCount} — profile: ${JSON.stringify({ needs_prd: profile.needs_prd, needs_architecture: profile.needs_architecture })}`)
  // ── end COMP-UX-3a ─────────────────────────────────────────────────────────

  // Write feature.json (source of truth)
  const { writeFeature } = await import('../lib/feature-json.js')
  const today = new Date().toISOString().slice(0, 10)
  writeFeature(cwd, {
    code: featureCode,
    description,
    status: 'PLANNED',
    created: today,
    profile,
  }, featuresDir)
  console.log(`Created ${join(featureDir, 'feature.json')}`)

  const designContent = `# ${featureCode}: ${description}

**Status:** PLANNED
**Created:** ${today}

---

## Intent

${description}

---

## Notes

_This is a seed design doc created by \`compose feature\`. The \`compose build\` pipeline will expand it into a full design, blueprint, and implementation plan._
`

  writeFileSync(designPath, designContent)
  console.log(`Created ${designPath}`)

  // 2. Add entry to ROADMAP.md
  const roadmapPath = join(cwd, 'ROADMAP.md')
  if (existsSync(roadmapPath)) {
    let roadmap = readFileSync(roadmapPath, 'utf-8')

    // Find the last table row with a number to get the next item number
    const itemNums = [...roadmap.matchAll(/^\| (\d+) \|/gm)].map(m => parseInt(m[1], 10))
    const nextNum = itemNums.length > 0 ? Math.max(...itemNums) + 1 : 1

    // Find the first PLANNED phase table and append, or append to the last table
    const tableRowPattern = /^(\| \d+ \|.*\| PLANNED \|)$/m
    const match = roadmap.match(tableRowPattern)

    if (match) {
      // Insert after the last row of this table
      const tableEnd = roadmap.indexOf(match[0]) + match[0].length
      // Find end of table (next blank line or ---)
      let insertPos = tableEnd
      const rest = roadmap.slice(tableEnd)
      const nextRows = rest.match(/^(\| \d+ \|.*\|)$/gm)
      if (nextRows) {
        for (const row of nextRows) {
          insertPos = roadmap.indexOf(row, insertPos) + row.length
        }
      }
      const newRow = `\n| ${nextNum} | ${featureCode} | ${description} | PLANNED |`
      roadmap = roadmap.slice(0, insertPos) + newRow + roadmap.slice(insertPos)
    } else {
      // No PLANNED table found — append a features section
      roadmap += `\n\n## Features\n\n| # | Feature | Item | Status |\n|---|---------|------|--------|\n| ${nextNum} | ${featureCode} | ${description} | PLANNED |\n`
    }

    writeFileSync(roadmapPath, roadmap)
    console.log(`Added ${featureCode} to ROADMAP.md (item #${nextNum})`)
  }

  // 3. Update project description in ROADMAP if still placeholder
  if (existsSync(roadmapPath)) {
    let roadmap = readFileSync(roadmapPath, 'utf-8')
    if (roadmap.includes('describe your project here')) {
      // Use the first feature description as a hint
      roadmap = roadmap.replace('describe your project here', description)
      writeFileSync(roadmapPath, roadmap)
    }
  }

  console.log('')
  console.log(`Feature ${featureCode} ready. Next:`)
  console.log(`  compose build ${featureCode}`)
  process.exit(0)
}

if (cmd === 'roadmap') {
  const subcmd = args[0]

  // compose roadmap generate — regenerate ROADMAP.md from feature.json files
  if (subcmd === 'generate' || subcmd === 'gen') {
    const { writeRoadmap } = await import('../lib/roadmap-gen.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const path = writeRoadmap(cwd)
    console.log(`Generated ${path} from feature.json files`)
    process.exit(0)
  }

  // compose roadmap migrate — extract ROADMAP.md entries into feature.json files
  if (subcmd === 'migrate') {
    const { migrateRoadmap } = await import('../lib/migrate-roadmap.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const dryRun = args.includes('--dry-run')
    const overwrite = args.includes('--overwrite')
    const result = migrateRoadmap(cwd, { dryRun, overwrite })
    if (!dryRun) {
      console.log(`Created: ${result.created.length} feature.json files`)
      if (result.created.length > 0) console.log(`  ${result.created.join(', ')}`)
      console.log(`Updated: ${result.updated.length}`)
      if (result.updated.length > 0) console.log(`  ${result.updated.join(', ')}`)
      console.log(`Skipped: ${result.skipped.length} (already exist, use --overwrite to replace)`)
      if (result.skipped.length > 0) console.log(`  ${result.skipped.join(', ')}`)
    }
    process.exit(0)
  }

  // compose roadmap check — verify feature.json ↔ ROADMAP.md consistency
  if (subcmd === 'check') {
    const { listFeatures } = await import('../lib/feature-json.js')
    const { parseRoadmap } = await import('../lib/roadmap-parser.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const roadmapPath = join(cwd, 'ROADMAP.md')
    if (!existsSync(roadmapPath)) {
      console.error('No ROADMAP.md found. Run: compose roadmap generate')
      process.exit(1)
    }
    const features = listFeatures(cwd)
    const roadmapEntries = parseRoadmap(readFileSync(roadmapPath, 'utf-8'))
    const roadmapCodes = new Set(roadmapEntries.filter(e => !e.code.startsWith('_anon_')).map(e => e.code))
    const featureCodes = new Set(features.map(f => f.code))

    let clean = true
    // Features in feature.json but missing from ROADMAP.md
    for (const f of features) {
      if (!roadmapCodes.has(f.code)) {
        console.log(`MISSING from ROADMAP.md: ${f.code}`)
        clean = false
      }
    }
    // Features in ROADMAP.md but missing feature.json
    for (const e of roadmapEntries) {
      if (e.code.startsWith('_anon_')) continue
      if (!featureCodes.has(e.code)) {
        console.log(`NO feature.json: ${e.code}`)
        clean = false
      }
    }
    // Status mismatches
    const roadmapMap = new Map(roadmapEntries.map(e => [e.code, e]))
    for (const f of features) {
      const rm = roadmapMap.get(f.code)
      if (rm && rm.status !== f.status) {
        console.log(`STATUS MISMATCH: ${f.code} — feature.json=${f.status}, ROADMAP.md=${rm.status}`)
        clean = false
      }
    }

    if (clean) {
      console.log('feature.json and ROADMAP.md are in sync.')
    } else {
      console.log('\nRun `compose roadmap generate` to regenerate ROADMAP.md from feature.json.')
      process.exit(1)
    }
    process.exit(0)
  }

  // Default: compose roadmap (show status)
  const { parseRoadmap, filterBuildable } = await import('../lib/roadmap-parser.js')
  const { buildDag, topoSort } = await import('../lib/build-dag.js')
  const { readdirSync, statSync } = await import('fs')

  const SYM = { COMPLETE: '\x1b[32m✓\x1b[0m', PLANNED: '\x1b[90m○\x1b[0m', IN_PROGRESS: '\x1b[33m◐\x1b[0m', PARTIAL: '\x1b[33m◐\x1b[0m', SUPERSEDED: '\x1b[90m✗\x1b[0m', PARKED: '\x1b[90m⏸\x1b[0m' }

  function showRoadmap(roadmapPath, fallbackLabel) {
    const text = readFileSync(roadmapPath, 'utf-8')
    // Extract project name from "# Title Roadmap" or "# Title" heading
    const titleMatch = text.match(/^#\s+(.+?)(?:\s+Roadmap)?\s*$/m)
    const label = titleMatch ? titleMatch[1].trim() : fallbackLabel
    const allEntries = parseRoadmap(text)
    const named = allEntries.filter(e => !e.code.startsWith('_anon_'))

    if (named.length === 0) return

    // Group by phase
    const phases = new Map()
    for (const entry of named) {
      const phase = entry.phaseId || '(ungrouped)'
      if (!phases.has(phase)) phases.set(phase, [])
      phases.get(phase).push(entry)
    }

    // Counts
    const counts = {}
    for (const e of named) counts[e.status] = (counts[e.status] ?? 0) + 1
    const total = named.length

    console.log(`\n\x1b[1m${label}\x1b[0m  (${total} features)\n`)

    for (const [phase, entries] of phases) {
      const complete = entries.filter(e => e.status === 'COMPLETE').length
      const phaseColor = complete === entries.length ? '\x1b[32m' : entries.some(e => e.status === 'IN_PROGRESS' || e.status === 'PARTIAL') ? '\x1b[33m' : '\x1b[0m'
      const shortPhase = phase.includes(' > ') ? phase.split(' > ').pop() : phase
      console.log(`${phaseColor}${shortPhase}\x1b[0m  (${complete}/${entries.length})`)
      for (const e of entries) {
        const sym = SYM[e.status] ?? '?'
        const desc = e.description.length > 70 ? e.description.slice(0, 67) + '...' : e.description
        console.log(`  ${sym} ${e.code.padEnd(16)} ${desc}`)
      }
      console.log('')
    }

    // Summary bar
    const bar = []
    if (counts.COMPLETE > 0) bar.push(`\x1b[32m${counts.COMPLETE} complete\x1b[0m`)
    if ((counts.IN_PROGRESS ?? 0) + (counts.PARTIAL ?? 0) > 0) bar.push(`\x1b[33m${(counts.IN_PROGRESS ?? 0) + (counts.PARTIAL ?? 0)} in progress\x1b[0m`)
    if (counts.PLANNED > 0) bar.push(`\x1b[90m${counts.PLANNED} planned\x1b[0m`)
    if (counts.SUPERSEDED > 0) bar.push(`\x1b[90m${counts.SUPERSEDED} superseded\x1b[0m`)
    if (counts.PARKED > 0) bar.push(`\x1b[90m${counts.PARKED} parked\x1b[0m`)
    console.log(bar.join('  '))

    // Next buildable
    const buildable = filterBuildable(allEntries)
    if (buildable.length > 0) {
      const dag = buildDag(allEntries)
      const order = topoSort(dag)
      const buildableSet = new Set(buildable.map(e => e.code))
      const buildOrder = order.filter(code => buildableSet.has(code))
      const descMap = new Map(named.map(e => [e.code, e.description]))
      const next = buildOrder.slice(0, 5)
      console.log(`\n\x1b[1mNext up:\x1b[0m`)
      for (const code of next) {
        const desc = descMap.get(code) ?? ''
        const short = desc.length > 60 ? desc.slice(0, 57) + '...' : desc
        console.log(`  compose build ${code}${short ? `  — ${short}` : ''}`)
      }
      if (buildOrder.length > 5) {
        console.log(`  ... and ${buildOrder.length - 5} more`)
      }
    }
  }

  const { root: cwd } = resolveCwdWithWorkspace(args)
  const roadmapPath = join(cwd, 'ROADMAP.md')

  if (existsSync(roadmapPath)) {
    // Show cwd roadmap
    showRoadmap(roadmapPath, basename(cwd))

    // Also scan immediate subdirs for sibling roadmaps
    const subdirs = []
    try {
      for (const entry of readdirSync(cwd)) {
        if (entry.startsWith('.')) continue
        const sub = join(cwd, entry)
        if (statSync(sub).isDirectory() && existsSync(join(sub, 'ROADMAP.md'))) {
          subdirs.push({ name: entry, path: join(sub, 'ROADMAP.md') })
        }
      }
    } catch { /* ignore permission errors */ }

    for (const { name, path } of subdirs) {
      showRoadmap(path, name)
    }
  } else {
    // No roadmap in cwd — scan subdirs (parent folder of multiple projects)
    const subdirs = []
    try {
      for (const entry of readdirSync(cwd)) {
        if (entry.startsWith('.')) continue
        const sub = join(cwd, entry)
        if (statSync(sub).isDirectory() && existsSync(join(sub, 'ROADMAP.md'))) {
          subdirs.push({ name: entry, path: join(sub, 'ROADMAP.md') })
        }
      }
    } catch { /* ignore */ }

    if (subdirs.length === 0) {
      console.error('No ROADMAP.md found in the current directory or any subdirectory.')
      process.exit(1)
    }

    for (const { name, path } of subdirs) {
      showRoadmap(path, name)
    }
  }

  console.log('')
  process.exit(0)
}

if (cmd === 'record-completion') {
  // compose record-completion <feature_code> --commit-sha=<full-40-hex> [options]
  //
  // Flags:
  //   --commit-sha=<sha>          required; full 40-char hex SHA (Decision 9)
  //   --tests-pass=<bool>         default true
  //   --notes=<string>            optional
  //   --files-changed-from-stdin  read newline-separated paths from stdin
  //   --no-status                 set_status: false (don't flip status to COMPLETE)
  //   --force                     force-replace an existing same-(code,sha) record
  //   --idempotency-key=<key>     caller-supplied idempotency key
  //
  // Positional: <feature_code> is the first non-flag argument.

  // Tiny flag parser: handles --key=value, --key value, --no-key
  function parseFlags(rawArgs) {
    const flags = {}
    const positionals = []
    let i = 0
    while (i < rawArgs.length) {
      const a = rawArgs[i]
      if (a.startsWith('--')) {
        const stripped = a.slice(2)
        if (stripped.startsWith('no-')) {
          flags[stripped.slice(3)] = false
          i++
        } else if (stripped.includes('=')) {
          const eq = stripped.indexOf('=')
          flags[stripped.slice(0, eq)] = stripped.slice(eq + 1)
          i++
        } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('--')) {
          flags[stripped] = rawArgs[i + 1]
          i += 2
        } else {
          flags[stripped] = true
          i++
        }
      } else {
        positionals.push(a)
        i++
      }
    }
    return { flags, positionals }
  }

  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: compose record-completion <feature_code> --commit-sha=<full-40-hex> [options]')
    console.log('')
    console.log('Options:')
    console.log('  --commit-sha=<sha>          Full 40-char hex SHA (required)')
    console.log('  --tests-pass=<bool>         Whether tests passed (default: true)')
    console.log('  --notes=<string>            Optional provenance notes')
    console.log('  --files-changed-from-stdin  Read newline-separated repo-relative paths from stdin')
    console.log('  --no-status                 Do not flip feature status to COMPLETE')
    console.log('  --force                     Replace existing record with same (feature_code, commit_sha)')
    console.log('  --idempotency-key=<key>     Caller-supplied idempotency key')
    process.exit(0)
  }

  const { flags, positionals } = parseFlags(args)
  const featureCode = positionals[0]
  if (!featureCode) {
    console.error('Error: feature_code is required as the first positional argument')
    console.error('Usage: compose record-completion <feature_code> --commit-sha=<sha>')
    process.exit(1)
  }

  const commitSha = flags['commit-sha']
  if (!commitSha) {
    console.error('Error: --commit-sha is required (full 40-char hex SHA)')
    process.exit(1)
  }

  // Parse tests-pass: default true
  let testsPass = true
  if (flags['tests-pass'] !== undefined) {
    const tp = flags['tests-pass']
    if (tp === 'false' || tp === false) testsPass = false
    else if (tp === 'true' || tp === true) testsPass = true
    else {
      console.error(`Error: --tests-pass must be true or false, got "${tp}"`)
      process.exit(1)
    }
  }

  // Read files_changed from stdin if flag set
  let filesChanged = []
  if (flags['files-changed-from-stdin'] === true) {
    const { createReadStream } = await import('fs')
    const { createInterface } = await import('readline')
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    for await (const line of rl) {
      const trimmed = line.trim()
      if (trimmed) filesChanged.push(trimmed)
    }
  }

  const completionArgs = {
    feature_code: featureCode,
    commit_sha: commitSha,
    tests_pass: testsPass,
    files_changed: filesChanged,
  }
  if (flags['notes']) completionArgs.notes = flags['notes']
  if (flags['status'] === false) completionArgs.set_status = false  // --no-status
  if (flags['force'] === true) completionArgs.force = true
  if (flags['idempotency-key']) completionArgs.idempotency_key = flags['idempotency-key']

  const { root: cwd } = resolveCwdWithWorkspace(args)
  const { recordCompletion } = await import('../lib/completion-writer.js')
  try {
    const result = await recordCompletion(cwd, completionArgs)
    console.log(JSON.stringify({
      completion_id:  result.completion_id,
      idempotent:     result.idempotent,
      status_changed: result.status_changed,
    }, null, 2))
    process.exit(0)
  } catch (err) {
    let msg = err && err.code ? `[${err.code}]: ${err.message}` : err.message
    if (err && err.cause && typeof err.cause.message === 'string') {
      msg += err.cause.code
        ? `\n  Caused by [${err.cause.code}]: ${err.cause.message}`
        : `\n  Caused by: ${err.cause.message}`
    }
    console.error(msg)
    process.exit(1)
  }
}

if (cmd === 'hooks') {
  // compose hooks {install,uninstall,status}
  const sub = args[0]

  // Tiny flag parser reused here
  function parseHookFlags(rawArgs) {
    const flags = {}
    let i = 0
    while (i < rawArgs.length) {
      const a = rawArgs[i]
      if (a.startsWith('--')) {
        const stripped = a.slice(2)
        if (stripped.includes('=')) {
          const eq = stripped.indexOf('=')
          flags[stripped.slice(0, eq)] = stripped.slice(eq + 1)
          i++
        } else {
          flags[stripped] = true
          i++
        }
      }
      i = i < rawArgs.length && !rawArgs[i].startsWith('--') ? i + 1 : i
    }
    return flags
  }

  // Fix: simpler flag parsing
  const hookFlags = {}
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a === '--force') hookFlags.force = true
    else if (a.startsWith('--')) {
      const stripped = a.slice(2)
      if (stripped.includes('=')) {
        const eq = stripped.indexOf('=')
        hookFlags[stripped.slice(0, eq)] = stripped.slice(eq + 1)
      } else {
        hookFlags[stripped] = true
      }
    }
  }

  const { readFileSync: rfSync, writeFileSync: wfSync, existsSync: exSync, chmodSync } = await import('fs')
  const { join: pjoin, resolve: presolve } = await import('path')
  const { fileURLToPath: futp } = await import('url')

  const { root: projectRoot } = resolveCwdWithWorkspace(args)
  const gitDir = pjoin(projectRoot, '.git')
  if (!exSync(gitDir)) {
    console.error('Error: not a git repository (no .git directory found)')
    process.exit(1)
  }

  const hooksDir = pjoin(gitDir, 'hooks')
  const { mkdirSync: mSync } = await import('fs')
  mSync(hooksDir, { recursive: true })

  // Resolve absolute paths for substitution
  const composeBin = presolve(presolve(futp(import.meta.url), '..'), 'compose.js')
  const composeNode = process.execPath

  // Hook-type table. Each entry knows its template, marker, and destination.
  const HOOK_TYPES = {
    'post-commit': {
      template: pjoin(presolve(futp(import.meta.url), '..'), 'git-hooks', 'post-commit.template'),
      marker:   '# Compose post-commit hook —',
      dest:     pjoin(hooksDir, 'post-commit'),
    },
    'pre-push': {
      template: pjoin(presolve(futp(import.meta.url), '..'), 'git-hooks', 'pre-push.template'),
      marker:   '# Compose pre-push hook —',
      dest:     pjoin(hooksDir, 'pre-push'),
    },
  }

  // Determine which hook types this invocation operates on.
  // Flags: --pre-push, --post-commit, or none (default = post-commit, back-compat).
  const selectedTypes = []
  if (hookFlags['pre-push']) selectedTypes.push('pre-push')
  if (hookFlags['post-commit']) selectedTypes.push('post-commit')
  if (selectedTypes.length === 0) selectedTypes.push('post-commit') // default = back-compat

  function installOne(type) {
    const { template: tplPath, marker, dest } = HOOK_TYPES[type]
    let template
    try {
      template = rfSync(tplPath, 'utf-8')
    } catch (err) {
      console.error(`Error: could not read ${type} template: ${err.message}`)
      return 1
    }
    if (exSync(dest)) {
      const existing = rfSync(dest, 'utf-8')
      const isOurs = existing.includes(marker)
      if (!isOurs && !hookFlags.force) {
        console.error(`Error: a foreign ${type} hook already exists at ${dest}`)
        console.error('')
        console.error(`Run \`compose hooks install --${type} --force\` to overwrite.`)
        return 1
      }
    }
    // Hook install must pick exactly one workspace. Repo-level hooks bake one ID.
    const wsHint = hookFlags['workspace']
    let wsId
    try {
      wsId = resolveWorkspace({ cwd: projectRoot, workspaceId: wsHint }).id
    } catch (err) {
      dieOnWorkspaceError(err)
    }
    const substituted = template
      .replace(/__COMPOSE_NODE__/g, composeNode)
      .replace(/__COMPOSE_BIN__/g, composeBin)
      .replace(/__COMPOSE_WORKSPACE_ID__/g, wsId)
    wfSync(dest, substituted)
    chmodSync(dest, 0o755)
    console.log(`Installed ${type} hook at ${dest}`)
    console.log(`  COMPOSE_NODE=${composeNode}`)
    console.log(`  COMPOSE_BIN=${composeBin}`)
    console.log(`  COMPOSE_WORKSPACE_ID=${wsId}`)
    return 0
  }

  function uninstallOne(type) {
    const { marker, dest } = HOOK_TYPES[type]
    if (!exSync(dest)) {
      console.log(`No ${type} hook installed.`)
      return 0
    }
    const content = rfSync(dest, 'utf-8')
    if (!content.includes(marker)) {
      console.warn(`Warning: ${type} hook exists but does not appear to be a Compose hook (marker not found). Leaving alone.`)
      return 0
    }
    const { rmSync: rmS } = require('fs')
    rmS(dest)
    console.log(`Removed ${type} hook at ${dest}`)
    return 0
  }

  function extractBakedWorkspaceId(content) {
    const m = content.match(/^COMPOSE_WORKSPACE_ID="([^"]*)"$/m)
    return m ? m[1] : null
  }

  function statusOne(type) {
    const { marker, dest } = HOOK_TYPES[type]
    if (!exSync(dest)) {
      console.log(`${type}: absent — no hook installed`)
      return
    }
    const content = rfSync(dest, 'utf-8')
    if (!content.includes(marker)) {
      console.log(`${type}: foreign — hook exists but is not a Compose hook`)
      return
    }
    const wsHint = hookFlags['workspace']
    let expectedWsId = null
    if (wsHint) {
      try { expectedWsId = resolveWorkspace({ cwd: projectRoot, workspaceId: wsHint }).id } catch { /* ignore for status */ }
    } else {
      try { expectedWsId = resolveWorkspace({ cwd: projectRoot }).id } catch { /* ignore for status */ }
    }
    const nodeMatch = content.includes(`COMPOSE_NODE="${composeNode}"`)
    const binMatch  = content.includes(`COMPOSE_BIN="${composeBin}"`)
    const hasRawToken = content.includes('__COMPOSE_WORKSPACE_ID__')
    const wsMatch = hasRawToken ? false
                  : expectedWsId ? content.includes(`COMPOSE_WORKSPACE_ID="${expectedWsId}"`)
                  : true
    if (nodeMatch && binMatch && wsMatch && !hasRawToken) {
      console.log(`${type}: installed (current)`)
      const baked = extractBakedWorkspaceId(content)
      if (baked) console.log(`  workspace: ${baked}`)
    } else {
      const reason = hasRawToken ? 'MISSING_WORKSPACE_ID'
                   : (expectedWsId && !wsMatch) ? 'STALE_WORKSPACE_ID'
                   : 'stale paths'
      console.log(`${type}: installed (${reason} — re-run install)`)
      if (expectedWsId && !wsMatch && !hasRawToken) console.log(`  expected COMPOSE_WORKSPACE_ID="${expectedWsId}"`)
      if (!nodeMatch) console.log(`  expected COMPOSE_NODE="${composeNode}"`)
      if (!binMatch)  console.log(`  expected COMPOSE_BIN="${composeBin}"`)
    }
  }

  if (sub === 'install') {
    let exitCode = 0
    for (const t of selectedTypes) exitCode = installOne(t) || exitCode
    process.exit(exitCode)
  }

  if (sub === 'uninstall') {
    const { rmSync: _rmS } = await import('fs') // ensure fs.rmSync is available
    // uninstallOne calls require('fs') but we're ESM — replace with import-based deletion
    for (const t of selectedTypes) {
      const { marker, dest } = HOOK_TYPES[t]
      if (!exSync(dest)) { console.log(`No ${t} hook installed.`); continue }
      const content = rfSync(dest, 'utf-8')
      if (!content.includes(marker)) {
        console.warn(`Warning: ${t} hook exists but does not appear to be a Compose hook (marker not found). Leaving alone.`)
        continue
      }
      _rmS(dest)
      console.log(`Removed ${t} hook at ${dest}`)
    }
    process.exit(0)
  }

  // status (default)
  if (!sub || sub === 'status') {
    // Status reports on ALL known hook types (selection flags ignored), so users
    // see the full picture. Selection only affects install/uninstall.
    for (const t of Object.keys(HOOK_TYPES)) statusOne(t)
    process.exit(0)
  }

  console.error(`Unknown hooks subcommand: "${sub}". Use: install | uninstall | status`)
  process.exit(1)
}

if (cmd === 'validate') {
  // compose validate [--scope=feature|project] [--code=CODE] [--block-on=error|warning|info] [--json]
  let scope = 'project'
  let code = null
  let blockOn = 'error'
  let asJson = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--help' || a === '-h') {
      console.log(`Usage: compose validate [options]

Options:
  --scope=feature|project     Scope (default: project)
  --code=CODE                 Feature code (required when scope=feature)
  --block-on=LEVEL            Exit non-zero if any finding >= LEVEL (default: error)
                              LEVEL: error | warning | info
  --json                      Emit findings as JSON (default: human-readable)

Exit codes:
  0   no findings >= block-on threshold
  1   findings >= block-on threshold present
  2   usage error`)
      process.exit(0)
    }
    if (a === '--json') { asJson = true; continue }
    if (a.startsWith('--scope=')) scope = a.slice('--scope='.length)
    else if (a === '--scope') scope = args[++i]
    else if (a.startsWith('--code=')) code = a.slice('--code='.length)
    else if (a === '--code') code = args[++i]
    else if (a.startsWith('--block-on=')) blockOn = a.slice('--block-on='.length)
    else if (a === '--block-on') blockOn = args[++i]
    else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`)
      process.exit(2)
    }
  }
  if (!['feature', 'project'].includes(scope)) {
    console.error(`Invalid --scope=${scope}; expected feature or project`)
    process.exit(2)
  }
  if (scope === 'feature' && !code) {
    console.error(`--scope=feature requires --code=<CODE>`)
    process.exit(2)
  }
  if (!['error', 'warning', 'info'].includes(blockOn)) {
    console.error(`Invalid --block-on=${blockOn}; expected error, warning, or info`)
    process.exit(2)
  }

  const { validateFeature, validateProject } = await import('../lib/feature-validator.js')
  const { root: valCwd } = resolveCwdWithWorkspace(args)
  let result
  try {
    result = scope === 'feature'
      ? await validateFeature(valCwd, code)
      : await validateProject(valCwd)
  } catch (err) {
    if (err.code === 'INVALID_INPUT') {
      console.error(`Error [INVALID_INPUT]: ${err.message}`)
      process.exit(2)
    }
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }

  // Threshold: findings at or above this severity block the exit code
  const SEV_RANK = { error: 3, warning: 2, info: 1 }
  const threshold = SEV_RANK[blockOn]
  const blocking = result.findings.filter((f) => SEV_RANK[f.severity] >= threshold)

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const byKind = {}
    for (const f of result.findings) {
      const sev = f.severity.toUpperCase()
      const tag = `[${sev}] ${f.kind}${f.feature_code ? ' ' + f.feature_code : ''}`
      if (!byKind[tag]) byKind[tag] = []
      byKind[tag].push(f.detail)
    }
    if (result.findings.length === 0) {
      console.log(`compose validate: no findings (scope=${scope}${code ? ' code=' + code : ''})`)
    } else {
      console.log(`compose validate findings (scope=${scope}${code ? ' code=' + code : ''}):`)
      for (const tag of Object.keys(byKind).sort()) {
        console.log(`  ${tag}`)
        for (const detail of byKind[tag]) console.log(`    - ${detail}`)
      }
      console.log(`\n${result.findings.length} finding(s); ${blocking.length} at or above --block-on=${blockOn}`)
    }
  }

  process.exit(blocking.length > 0 ? 1 : 0)
}

if (cmd === 'pipeline') {
  const { runPipelineCli } = await import('../lib/pipeline-cli.js')
  const { root: pipeCwd } = resolveCwdWithWorkspace(args)
  try {
    runPipelineCli(pipeCwd, args)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
}

if (cmd === 'build') {
  // Parse --cwd <path> for cross-repo builds
  let agentWorkDir = null
  const cwdIdx = args.indexOf('--cwd')
  if (cwdIdx !== -1) {
    const cwdValue = args[cwdIdx + 1]
    if (!cwdValue || cwdValue.startsWith('-')) {
      console.error('Error: --cwd requires a path argument')
      process.exit(1)
    }
    agentWorkDir = resolve(cwdValue)
  }
  let filteredArgs = args.filter((a, i) => i !== cwdIdx && (cwdIdx === -1 || i !== cwdIdx + 1))

  // --team flag (COMP-TEAMS)
  let teamTemplate = null
  try {
    const teamResult = parseTeamFlag(filteredArgs)
    teamTemplate = teamResult.template
    if (teamTemplate) filteredArgs = teamResult.args
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }

  // --template <name>
  let templateName = null
  const templateIdx = filteredArgs.indexOf('--template')
  if (templateIdx !== -1) {
    const templateValue = filteredArgs[templateIdx + 1]
    if (!templateValue || templateValue.startsWith('-')) {
      console.error('Error: --template requires a name argument')
      process.exit(1)
    }
    templateName = templateValue
  }
  if (teamTemplate && !templateName) {
    templateName = teamTemplate
  }
  const filteredArgs2 = filteredArgs.filter((a, i) => i !== templateIdx && (templateIdx === -1 || i !== templateIdx + 1))

  const featureCodes = filteredArgs2.filter(a => !a.startsWith('-'))
  const featureCode = featureCodes[0]
  const abort = filteredArgs2.includes('--abort')
  const all = filteredArgs2.includes('--all')
  const dryRun = filteredArgs2.includes('--dry-run')
  const skipTriage = filteredArgs2.includes('--skip-triage')

  // Multiple codes: compose build FEAT-1 FEAT-2 FEAT-3
  const isMulti = featureCodes.length > 1
  // Single prefix: compose build STRAT-COMP (no trailing digit)
  const isPrefix = featureCodes.length === 1 && featureCode && !/\d$/.test(featureCode)
  const isBatch = all || isPrefix || isMulti

  if (abort && isBatch) {
    console.error('Error: --abort and --all/prefix/multi are mutually exclusive')
    process.exit(1)
  }

  if (!featureCode && !abort && !all) {
    console.error('Usage: compose build <feature-code> [feature-code...]')
    console.error('       compose build STRAT-COMP          (prefix — builds all matching)')
    console.error('       compose build --all               (builds entire roadmap)')
    console.error('')
    console.error('Options:')
    console.error('  --abort        Abort the active build')
    console.error('  --all          Build all PLANNED features in dependency order')
    console.error('  --dry-run      Print build order without executing')
    console.error('  --cwd <path>   Agent working directory (for cross-repo features)')
    process.exit(1)
  }

  // Auto-init if needed
  const { root: buildCwd } = resolveCwdWithWorkspace(args)
  if (!existsSync(join(buildCwd, '.compose', 'compose.json')) || !existsSync(join(buildCwd, 'pipelines', 'build.stratum.yaml'))) {
    console.log('Running compose init...\n')
    await runInit(args.filter(a => a.startsWith('--')))
    console.log('')
  }

  if (isBatch && teamTemplate) {
    console.error('Error: --team cannot be used with batch builds (--all, multiple features, or prefix matching)')
    process.exit(1)
  }

  if (isBatch) {
    import('../lib/build-all.js').then(({ runBuildAll }) => {
      const batchOpts = { cwd: buildCwd, dryRun }
      if (agentWorkDir) batchOpts.workingDirectory = agentWorkDir
      if (isMulti) {
        batchOpts.features = featureCodes
      } else if (isPrefix) {
        batchOpts.filter = featureCode
      }
      runBuildAll(batchOpts).then((result) => {
        process.exit(result.failed.length > 0 ? 1 : 0)
      }).catch((err) => {
        console.error(`Build all failed: ${err.message}`)
        process.exit(1)
      })
    })
  } else {
    import('../lib/build.js').then(({ runBuild }) => {
      const singleOpts = { abort }
      if (agentWorkDir) singleOpts.workingDirectory = agentWorkDir
      if (skipTriage) singleOpts.skipTriage = true
      if (templateName) singleOpts.template = templateName
      runBuild(featureCode, singleOpts).then(() => {
        process.exit(0)
      }).catch((err) => {
        console.error(`Build failed: ${err.message}`)
        process.exit(1)
      })
    })
  }
} else if (cmd === 'fix') {
  // compose fix <bug-code> — runs the bug-fix.stratum.yaml pipeline.
  // Thin delegation to runBuild() with template='bug-fix'. The pipeline owns
  // iteration (test step retries=5 + ensure passing==true; retro_check enforces
  // hard-stop at attempt 2 for visual/CSS bugs and flags fix chains).
  let agentWorkDir = null
  const cwdIdx = args.indexOf('--cwd')
  if (cwdIdx !== -1) {
    const cwdValue = args[cwdIdx + 1]
    if (!cwdValue || cwdValue.startsWith('-')) {
      console.error('Error: --cwd requires a path argument')
      process.exit(1)
    }
    agentWorkDir = resolve(cwdValue)
  }
  const filteredArgs = args.filter((a, i) => i !== cwdIdx && (cwdIdx === -1 || i !== cwdIdx + 1))
  const bugCodes = filteredArgs.filter(a => !a.startsWith('-'))
  const bugCode = bugCodes[0]
  const abort = filteredArgs.includes('--abort')
  const resume = filteredArgs.includes('--resume')

  if (!bugCode && !abort) {
    console.error('Usage: compose fix <bug-code>')
    console.error('')
    console.error('Runs the bug-fix pipeline (reproduce → diagnose → scope → fix → test → verify → retro → ship).')
    console.error('')
    console.error('Options:')
    console.error('  --abort        Abort the active fix run')
    console.error('  --resume       Resume the active fix run for <bug-code>')
    console.error('  --cwd <path>   Agent working directory (for cross-repo bugs)')
    process.exit(1)
  }

  const { root: fixCwd } = resolveCwdWithWorkspace(args)
  if (!existsSync(join(fixCwd, '.compose', 'compose.json')) || !existsSync(join(fixCwd, 'pipelines', 'bug-fix.stratum.yaml'))) {
    console.log('Running compose init...\n')
    await runInit(args.filter(a => a.startsWith('--')))
    console.log('')
  }

  // COMP-FIX-HARD T4: bug description lives at docs/bugs/<bug-code>/description.md.
  // If absent, scaffold a stub and exit 1 so the user can fill it before retrying.
  let bugDescription = null
  if (!abort && bugCode) {
    const bugDir = join(fixCwd, 'docs', 'bugs', bugCode)
    const descPath = join(bugDir, 'description.md')
    if (!existsSync(descPath)) {
      mkdirSync(bugDir, { recursive: true })
      const scaffold = `# ${bugCode}: <symptom in one sentence>

## Steps to reproduce

1.
2.
3.

## Expected behavior

## Actual behavior

## Environment / Notes
`
      writeFileSync(descPath, scaffold)
      console.error(`No description found at docs/bugs/${bugCode}/description.md. Scaffold written. Edit it and re-run 'compose fix ${bugCode}'.`)
      process.exit(1)
    }
    try {
      bugDescription = readFileSync(descPath, 'utf-8').trim()
    } catch (err) {
      console.error(`Failed to read ${descPath}: ${err.message}`)
      process.exit(1)
    }
    if (!bugDescription) {
      console.error(`docs/bugs/${bugCode}/description.md is empty. Edit it and re-run 'compose fix ${bugCode}'.`)
      process.exit(1)
    }
  }

  // COMP-FIX-HARD T8: --resume requires a matching active build for this bug.
  let resumeFlowId = null
  if (resume && !abort && bugCode) {
    const activeBuildPath = join(fixCwd, '.compose', 'data', 'active-build.json')
    let active = null
    if (existsSync(activeBuildPath)) {
      try { active = JSON.parse(readFileSync(activeBuildPath, 'utf-8')) } catch { active = null }
    }
    if (!active || active.featureCode !== bugCode || !active.flowId) {
      console.error(`No active build to resume for ${bugCode}`)
      process.exit(1)
    }
    // Refuse to resume a feature build as a bug build. Mode is best-effort:
    // legacy active-build.json files that predate the mode field have no
    // active.mode, in which case we trust the runBuild-side mode check.
    if (active.mode && active.mode !== 'bug') {
      console.error(`Cannot --resume: active build for ${bugCode} is in ${active.mode} mode, not bug mode.`)
      process.exit(1)
    }
    resumeFlowId = active.flowId
  }

  import('../lib/build.js').then(({ runBuild }) => {
    const opts = { abort, template: 'bug-fix', mode: 'bug' }
    if (agentWorkDir) opts.workingDirectory = agentWorkDir
    if (bugDescription) opts.description = bugDescription
    if (resumeFlowId) opts.resumeFlowId = resumeFlowId
    runBuild(bugCode, opts).then(() => {
      process.exit(0)
    }).catch((err) => {
      console.error(`Fix failed: ${err.message}`)
      process.exit(1)
    })
  })
} else if (cmd === 'gsd') {
  // compose gsd <feature-code> — runs the per-task fresh-context dispatch
  // pipeline (pipelines/gsd.stratum.yaml). Hard-requires existing
  // docs/features/<code>/blueprint.md with a parseable Boundary Map.
  const gsdCode = args.find(a => !a.startsWith('-'))
  if (!gsdCode) {
    console.error('Usage: compose gsd <feature-code>')
    console.error('')
    console.error('Runs the per-task fresh-context dispatch pipeline (COMP-GSD-2).')
    console.error('Hard-requires docs/features/<code>/blueprint.md with a valid Boundary Map.')
    console.error('')
    console.error('Options:')
    console.error('  --cwd <path>   Working directory (defaults to current)')
    process.exit(1)
  }
  const { root: gsdCwd } = resolveCwdWithWorkspace(args)
  const cwdIdx = args.indexOf('--cwd')
  const gsdAgentCwd = cwdIdx !== -1 ? resolve(args[cwdIdx + 1]) : gsdCwd
  const { runGsd } = await import('../lib/gsd.js')
  try {
    const result = await runGsd(gsdCode, { cwd: gsdAgentCwd })
    console.log(`gsd complete: ${result.blackboardEntries} task results captured.`)
  } catch (err) {
    console.error(`gsd failed: ${err.message}`)
    process.exit(1)
  }
} else if (cmd === 'triage') {
  const triageCode = args.find(a => !a.startsWith('-'))
  if (!triageCode) {
    console.error('Usage: compose triage <feature-code>')
    process.exit(1)
  }
  import('../lib/triage.js').then(({ runTriage }) => {
    import('../lib/feature-json.js').then(({ readFeature, writeFeature, updateFeature }) => {
      const { root: trCwd } = resolveCwdWithWorkspace(args)
      runTriage(triageCode, { cwd: trCwd }).then((result) => {
        console.log(`\nFeature: ${triageCode}`)
        console.log(`Tier:     ${result.tier}`)
        console.log(`Rationale: ${result.rationale}`)
        console.log(`\nProfile:`)
        for (const [k, v] of Object.entries(result.profile)) {
          console.log(`  ${k}: ${v}`)
        }
        console.log(`\nSignals:`)
        console.log(`  file paths found:  ${result.signals.fileCount}`)
        console.log(`  task count:        ${result.signals.taskCount}`)
        console.log(`  security paths:    ${result.signals.securityPaths}`)
        console.log(`  core paths:        ${result.signals.corePaths}`)

        // Persist to feature.json
        const triageTimestamp = new Date().toISOString()
        const existing = readFeature(trCwd, triageCode)
        if (!existing) {
          writeFeature(trCwd, {
            code: triageCode,
            description: triageCode,
            status: 'PLANNED',
            complexity: String(result.tier),
            profile: result.profile,
            triageTimestamp,
          })
          console.log(`\nCreated feature.json for ${triageCode}`)
        } else {
          updateFeature(trCwd, triageCode, {
            complexity: String(result.tier),
            profile: result.profile,
            triageTimestamp,
          })
          console.log(`\nUpdated feature.json for ${triageCode}`)
        }
        process.exit(0)
      }).catch((err) => {
        console.error(`Triage failed: ${err.message}`)
        process.exit(1)
      })
    })
  })
} else if (cmd === 'start') {
  // Resolve target root BEFORE spawning supervisor.
  // Use the unified resolver — it handles COMPOSE_TARGET as either ID or absolute path,
  // --workspace=<id>, and discovery. No need for the legacy explicitTarget short-circuit.
  const { root: targetRoot } = resolveCwdWithWorkspace(args)

  if (!targetRoot || !existsSync(join(targetRoot, '.compose', 'compose.json'))) {
    console.error('[compose] No .compose/ found (searched from cwd upward).')
    console.error("[compose] Run 'compose init' first, or set COMPOSE_TARGET.")
    process.exit(1)
  }

  const child = spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
    env: { ...process.env, COMPOSE_TARGET: targetRoot },
  })
  child.on('error', (err) => {
    console.error(`Failed to start compose: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
} else if (cmd === 'ideabox') {
  // ---------------------------------------------------------------------------
  // compose ideabox — idea management CLI
  // ---------------------------------------------------------------------------
  const ibSubcmd = args[0]
  const { root: ibCwd } = resolveCwdWithWorkspace(args)

  // Resolve compose config (paths, etc.)
  function loadComposeConfig(cwd) {
    const cfgPath = join(cwd, '.compose', 'compose.json')
    if (existsSync(cfgPath)) {
      try { return JSON.parse(readFileSync(cfgPath, 'utf-8')) } catch {}
    }
    return {}
  }
  function getIdeaboxRelPath(cwd) {
    return loadComposeConfig(cwd)?.paths?.ideabox || 'docs/product/ideabox.md'
  }
  const ibConfig = loadComposeConfig(ibCwd)

  const {
    parseIdeabox: _parseIdeabox,
    serializeIdeabox: _serializeIdeabox,
    addIdea: _addIdea,
    promoteIdea: _promoteIdea,
    killIdea: _killIdea,
    setPriority: _setPriority,
    loadLens: _loadLens,
    readIdeabox: _readIdeabox,
    writeIdeabox: _writeIdeabox,
    addDiscussion: _addDiscussion,
  } = await import('../lib/ideabox.js')

  const ibRelPath = getIdeaboxRelPath(ibCwd)
  const ibFullPath = join(ibCwd, ibRelPath)

  if (!ibSubcmd || ibSubcmd === '--help' || ibSubcmd === '-h') {
    console.log('Usage: compose ideabox <subcommand>')
    console.log('')
    console.log('Subcommands:')
    console.log('  add "<title>"                Add a new idea')
    console.log('  list                         List all ideas')
    console.log('  promote <ID>                 Mark idea as PROMOTED (creates feature folder)')
    console.log('  kill <ID> "<reason>"         Move idea to Killed Ideas')
    console.log('  pri <ID> <P0|P1|P2>          Set priority')
    console.log('  discuss <ID> "<comment>"     Add a discussion comment')
    console.log('  triage [--lens <name>]       Walk untriaged ideas and assign priorities')
    process.exit(0)
  }

  if (ibSubcmd === 'add') {
    const title = args.slice(1).find(a => !a.startsWith('-')) || args[1]
    if (!title) {
      console.error('Usage: compose ideabox add "<title>" [--source "..."] [--desc "..."] [--cluster "..."]')
      process.exit(1)
    }
    // Parse optional flags
    const sourceIdx = args.indexOf('--source')
    const descIdx = args.indexOf('--desc')
    const clusterIdx = args.indexOf('--cluster')
    const tagsIdx = args.indexOf('--tags')
    const source = sourceIdx !== -1 ? args[sourceIdx + 1] : ''
    const description = descIdx !== -1 ? args[descIdx + 1] : ''
    const cluster = clusterIdx !== -1 ? args[clusterIdx + 1] : null
    const tagsRaw = tagsIdx !== -1 ? args[tagsIdx + 1] : ''
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim().startsWith('#') ? t.trim() : `#${t.trim()}`) : []

    if (!existsSync(ibFullPath)) {
      const { IDEABOX_TEMPLATE } = await import('../lib/ideabox.js')
      mkdirSync(dirname(ibFullPath), { recursive: true })
      writeFileSync(ibFullPath, IDEABOX_TEMPLATE)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _addIdea(parsed, { title, description, source, tags, cluster })
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    const newIdea = parsed.ideas[parsed.ideas.length - 1]
    console.log(`Added ${newIdea.id}: ${newIdea.title}`)
    process.exit(0)
  }

  if (ibSubcmd === 'list') {
    if (!existsSync(ibFullPath)) {
      console.log('No ideabox found. Run: compose ideabox add "<title>"')
      process.exit(0)
    }
    const parsed = _readIdeabox(ibCwd, ibRelPath)
    if (parsed.ideas.length === 0 && parsed.killed.length === 0) {
      console.log('No ideas yet.')
      process.exit(0)
    }

    // Group by status then priority
    const byStatus = {}
    for (const idea of parsed.ideas) {
      const s = idea.status.startsWith('PROMOTED') ? 'PROMOTED' : idea.status
      if (!byStatus[s]) byStatus[s] = []
      byStatus[s].push(idea)
    }

    const statusOrder = ['NEW', 'DISCUSSING', 'PROMOTED']
    const priorityOrder = { P0: 0, P1: 1, P2: 2, '—': 3 }

    for (const status of statusOrder) {
      const group = byStatus[status]
      if (!group || group.length === 0) continue
      group.sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3))
      console.log(`\n[${status}]`)
      for (const idea of group) {
        const pri = idea.priority !== '—' ? ` [${idea.priority}]` : ''
        const tags = idea.tags.length ? ` ${idea.tags.join(' ')}` : ''
        console.log(`  ${idea.id}${pri}  ${idea.title}${tags}`)
      }
    }

    if (parsed.killed.length > 0) {
      console.log(`\n[KILLED] (${parsed.killed.length})`)
      for (const idea of parsed.killed) {
        console.log(`  ${idea.id}  ${idea.title}  — ${idea.killedReason}`)
      }
    }
    process.exit(0)
  }

  if (ibSubcmd === 'promote') {
    const ideaId = args[1]
    if (!ideaId) {
      console.error('Usage: compose ideabox promote <ID> [<FEATURE-CODE>]')
      process.exit(1)
    }
    const featureCode = args[2] || ''

    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    const idea = parsed.ideas.find(i => i.id.toUpperCase() === ideaId.toUpperCase())
    if (!idea) {
      console.error(`Idea not found: ${ideaId}`)
      process.exit(1)
    }

    // Generate feature code if not provided
    let resolvedCode = featureCode
    if (!resolvedCode) {
      // Derive a slug from the title
      const slug = idea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/-+$/, '')
      resolvedCode = `IDEA-${idea.num}-${slug}`.toUpperCase()
    }

    // Create feature folder if missing — respect paths.features from compose.json
    const featuresRel = ibConfig.paths?.features || 'docs/features'
    const featuresDir = join(ibCwd, featuresRel, resolvedCode)
    if (!existsSync(featuresDir)) {
      mkdirSync(featuresDir, { recursive: true })
      writeFileSync(join(featuresDir, 'feature.json'), JSON.stringify({
        code: resolvedCode,
        description: idea.title,
        status: 'PLANNED',
        promotedFrom: ideaId,
        createdAt: new Date().toISOString(),
      }, null, 2))
      console.log(`Created feature folder: ${featuresRel}/${resolvedCode}/`)
    }

    _promoteIdea(parsed, ideaId, resolvedCode)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    console.log(`Promoted ${ideaId} → ${resolvedCode}`)
    process.exit(0)
  }

  if (ibSubcmd === 'kill') {
    const ideaId = args[1]
    const reason = args[2] || ''
    if (!ideaId) {
      console.error('Usage: compose ideabox kill <ID> "<reason>"')
      process.exit(1)
    }
    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _killIdea(parsed, ideaId, reason)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    console.log(`Killed ${ideaId}: ${reason}`)
    process.exit(0)
  }

  if (ibSubcmd === 'pri') {
    const ideaId = args[1]
    const priority = args[2]
    if (!ideaId || !priority) {
      console.error('Usage: compose ideabox pri <ID> <P0|P1|P2>')
      process.exit(1)
    }
    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _setPriority(parsed, ideaId, priority)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    console.log(`Set ${ideaId} priority → ${priority}`)
    process.exit(0)
  }

  if (ibSubcmd === 'discuss') {
    const ideaId = args[1]
    const comment = args[2]
    if (!ideaId || !comment) {
      console.error('Usage: compose ideabox discuss <ID> "<comment>"')
      process.exit(1)
    }
    if (!existsSync(ibFullPath)) {
      console.error(`Ideabox not found at ${ibFullPath}`)
      process.exit(1)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    _addDiscussion(parsed, ideaId, 'human', comment)
    _writeIdeabox(ibCwd, ibRelPath, parsed)
    const today = new Date().toISOString().slice(0, 10)
    console.log(`[${today}] human: ${comment}`)
    process.exit(0)
  }

  if (ibSubcmd === 'triage') {
    const lensIdx = args.indexOf('--lens')
    const lensName = lensIdx !== -1 ? args[lensIdx + 1] : null

    if (!existsSync(ibFullPath)) {
      console.log('No ideabox found. Run: compose ideabox add "<title>" first.')
      process.exit(0)
    }

    const parsed = _readIdeabox(ibCwd, ibRelPath)
    const untriaged = parsed.ideas.filter(i => i.priority === '—' && i.status === 'NEW')

    if (untriaged.length === 0) {
      console.log('No untriaged ideas.')
      process.exit(0)
    }

    let lens = null
    if (lensName) {
      lens = _loadLens(ibCwd, lensName)
      if (!lens) {
        console.warn(`Lens not found: docs/product/ideabox-priority-${lensName}.md`)
      } else {
        console.log(`Using lens: ${lensName}`)
      }
    }

    // Interactive triage using readline
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const question = (q) => new Promise(resolve => rl.question(q, resolve))

    let changed = false
    for (const idea of untriaged) {
      console.log(`\n${idea.id}: ${idea.title}`)
      if (idea.description) console.log(`  ${idea.description.slice(0, 120)}`)
      if (lens) console.log(`  [lens: ${lensName}]`)

      const ans = await question('  Priority [P0/P1/P2/skip]: ')
      const p = ans.trim().toUpperCase()
      if (['P0', 'P1', 'P2'].includes(p)) {
        _setPriority(parsed, idea.id, p)
        changed = true
        console.log(`  Set ${idea.id} → ${p}`)
      } else {
        console.log('  Skipped')
      }
    }

    rl.close()

    if (changed) {
      _writeIdeabox(ibCwd, ibRelPath, parsed)
      console.log('\nSaved.')
    }
    process.exit(0)
  }

  console.error(`Unknown ideabox subcommand: ${ibSubcmd}`)
  console.error('Run: compose ideabox --help')
  process.exit(1)

} else if (cmd === 'qa-scope') {
  // ---------------------------------------------------------------------------
  // compose qa-scope <featureCode>
  // COMP-QA item 116: inspect which routes are affected by a feature's filesChanged
  // ---------------------------------------------------------------------------
  const qsCode = args.find(a => !a.startsWith('-'))
  if (!qsCode) {
    console.error('Usage: compose qa-scope <feature-code>')
    process.exit(1)
  }

  const { root: qsCwd } = resolveCwdWithWorkspace(args)

  import('../lib/feature-json.js').then(({ readFeature }) => {
    import('../lib/qa-scoping.js').then(({ mapFilesToRoutes, classifyRoutes }) => {
      const feature = readFeature(qsCwd, qsCode)
      if (!feature) {
        console.error(`Feature not found: ${qsCode}`)
        process.exit(1)
      }

      const filesChanged = feature.filesChanged ?? []
      if (filesChanged.length === 0) {
        console.log(`No filesChanged recorded for ${qsCode}.`)
        console.log('Run a build first so the pipeline tracks touched files.')
        process.exit(0)
      }

      const result = mapFilesToRoutes(filesChanged, { cwd: qsCwd })
      const allKnown = []  // v1: no known-routes registry
      const { affected, adjacent } = classifyRoutes(result.affectedRoutes, allKnown)

      console.log(`\nQA Scope for ${qsCode}`)
      console.log(`Framework:  ${result.framework}`)
      console.log(`Docs-only:  ${result.docsOnly}`)
      console.log(`\nAffected routes (${affected.length}):`)
      if (affected.length === 0) {
        console.log('  (none — no code files mapped to known routes)')
      } else {
        for (const r of affected) console.log(`  ${r}`)
      }

      console.log(`\nAdjacent routes (${adjacent.length}):`)
      if (adjacent.length === 0) {
        console.log('  (none)')
      } else {
        for (const r of adjacent) console.log(`  ${r}`)
      }

      console.log(`\nUnmapped files (${result.unmappedFiles.length}):`)
      if (result.unmappedFiles.length === 0) {
        console.log('  (none)')
      } else {
        for (const f of result.unmappedFiles) console.log(`  ${f}`)
      }

      process.exit(0)
    })
  }).catch((err) => {
    console.error(`qa-scope failed: ${err.message}`)
    process.exit(1)
  })

} else if (cmd === 'gates') {
  // ---------------------------------------------------------------------------
  // compose gates report [--since 24h|7d|1h|<ISO>] [--feature <FC>]
  //                       [--format text|json] [--rubber-stamp-ms <N>]
  // COMP-OBS-GATELOG: audit gate log report (Decision 5)
  // ---------------------------------------------------------------------------
  const gatesSubcmd = args[0]

  if (gatesSubcmd === 'report') {
    const { readGateLog } = await import('../server/gate-log-store.js')
    const flagIdx = (flag) => args.indexOf(flag)
    const flagVal = (flag) => {
      const i = flagIdx(flag)
      return i !== -1 && args[i + 1] ? args[i + 1] : null
    }

    // Parse --since: shorthand (24h, 7d, 1h) or ISO date string
    const sinceStr = flagVal('--since')
    let sinceMs = null
    if (sinceStr) {
      const shorthand = sinceStr.match(/^(\d+)(h|d)$/)
      if (shorthand) {
        const n = parseInt(shorthand[1], 10)
        const mult = shorthand[2] === 'h' ? 3600000 : 86400000
        sinceMs = Date.now() - n * mult
      } else {
        const parsed = Date.parse(sinceStr)
        if (!isNaN(parsed)) sinceMs = parsed
        else {
          console.error(`--since: cannot parse "${sinceStr}" (use e.g. 24h, 7d, or ISO date)`)
          process.exit(1)
        }
      }
    } else {
      // Default: last 24h
      sinceMs = Date.now() - 86400000
    }

    const featureFilter = flagVal('--feature')
    const format = flagVal('--format') || 'text'
    const rubberStampMs = parseInt(flagVal('--rubber-stamp-ms') || '3000', 10)

    const entries = readGateLog({ since: sinceMs, featureCode: featureFilter || undefined })

    if (format === 'json') {
      // Per-gate_id stats as JSON
      const stats = buildGateStats(entries, rubberStampMs)
      console.log(JSON.stringify(stats, null, 2))
      process.exit(0)
    }

    // Text table
    const stats = buildGateStats(entries, rubberStampMs)
    if (stats.length === 0) {
      console.log('No gate log entries found for the specified window.')
      process.exit(0)
    }

    const col = (s, w) => String(s ?? '').padEnd(w)
    const hdr = col('gate_id', 28) + col('logged', 8) + col('approve%', 10) + col('deny%', 7) + col('interrupt%', 12) + col('median_ms', 11) + 'rubber_stamp%'
    const sep = '-'.repeat(hdr.length)
    console.log(hdr)
    console.log(sep)
    for (const row of stats) {
      const flag = row.rubber_stamp_pct > 50 ? '  <- rubber-stamp candidate' : ''
      console.log(
        col(row.gate_id, 28) +
        col(row.logged_decisions, 8) +
        col(row.approve_pct.toFixed(1), 10) +
        col(row.deny_pct.toFixed(1), 7) +
        col(row.interrupt_pct.toFixed(1), 12) +
        col(row.median_ms !== null ? row.median_ms : 'N/A', 11) +
        row.rubber_stamp_pct.toFixed(1) + flag
      )
    }
    process.exit(0)
  }

  console.error(`Unknown gates subcommand: ${gatesSubcmd}`)
  console.error('Usage: compose gates report [--since 24h] [--feature FC] [--format text|json] [--rubber-stamp-ms N]')
  process.exit(1)

} else if (cmd === 'loops') {
  // ---------------------------------------------------------------------------
  // compose loops add --feature <FC> --kind <kind> --summary "<text>" [--ttl-days N] [--parent-branch <bid>]
  // compose loops list --feature <FC> [--include-resolved] [--format json]
  // compose loops resolve <loopId> --feature <FC> --note "<text>"
  // COMP-OBS-LOOPS (Decision 4)
  // ---------------------------------------------------------------------------
  const loopsSubcmd = args[0]

  const flagVal = (flag) => {
    const i = args.indexOf(flag)
    return i !== -1 && args[i + 1] ? args[i + 1] : null
  }
  const hasFlag = (flag) => args.includes(flag)

  const featureCode = flagVal('--feature')

  // --feature is required on every subcommand
  if (!featureCode) {
    console.error('compose loops: --feature <FC> is required on every subcommand')
    console.error('  compose loops add --feature <FC> --kind <kind> --summary "<text>"')
    console.error('  compose loops list --feature <FC>')
    console.error('  compose loops resolve <loopId> --feature <FC> --note "<text>"')
    process.exit(1)
  }

  // Resolve compose server URL (default http://localhost:3000)
  const baseUrl = process.env.COMPOSE_URL || 'http://localhost:3000'

  // COMP-WORKSPACE-HTTP T7: resolve workspace tolerantly so we can attach
  // X-Compose-Workspace-Id to the HTTP calls below. Loops CLI did not previously
  // need a workspace; if resolution fails for any reason, we send no header
  // (server middleware soft-falls back to boot workspace, preserving prior
  // behavior). We call resolveWorkspace directly so we can swallow the error
  // instead of going through resolveCwdWithWorkspace -> dieOnWorkspaceError.
  let _loopsWorkspaceId = null
  try {
    const wsId = getWorkspaceFlag(args)
    const ws = resolveWorkspace({ workspaceId: wsId === '__COMPOSE_WORKSPACE_ID__' ? null : wsId })
    _loopsWorkspaceId = ws.id || null
    _resolvedCwdCache = { root: ws.root, id: ws.id }
  } catch { /* preserve prior tolerant behavior — no header sent */ }

  async function httpGet(url, workspaceId) {
    const { default: http } = await import(url.startsWith('https') ? 'https' : 'http')
    return new Promise((resolve, reject) => {
      const u = new URL(url)
      const headers = {}
      if (workspaceId) headers['X-Compose-Workspace-Id'] = workspaceId
      const options = {
        hostname: u.hostname,
        port: u.port || (url.startsWith('https') ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      }
      const req = http.request(options, (res) => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
          catch { resolve({ status: res.statusCode, body: buf }) }
        })
      })
      req.on('error', reject)
      req.end()
    })
  }

  async function httpPost(urlStr, body, workspaceId) {
    const { default: http } = await import(urlStr.startsWith('https') ? 'https' : 'http')
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const url = new URL(urlStr)
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
      if (workspaceId) headers['X-Compose-Workspace-Id'] = workspaceId
      const options = {
        hostname: url.hostname,
        port: url.port || (urlStr.startsWith('https') ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }
      const req = http.request(options, (res) => {
        let buf = ''
        res.on('data', c => { buf += c })
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }) }
          catch { resolve({ status: res.statusCode, body: buf }) }
        })
      })
      req.on('error', reject)
      req.end(data)
    })
  }

  // Resolve item id from feature code
  async function getItemByFeatureCode(fc) {
    const r = await httpGet(`${baseUrl}/api/vision/items`, _loopsWorkspaceId)
    if (r.status !== 200) throw new Error(`Failed to list items: ${JSON.stringify(r.body)}`)
    const items = r.body.items || r.body
    const item = items.find(i => i.lifecycle?.featureCode === fc)
    if (!item) throw new Error(`No item found with featureCode=${fc}`)
    return item
  }

  if (loopsSubcmd === 'add') {
    const kind = flagVal('--kind')
    const summary = flagVal('--summary')
    const ttlDays = flagVal('--ttl-days') ? parseInt(flagVal('--ttl-days'), 10) : undefined
    const parentBranch = flagVal('--parent-branch') || undefined

    if (!kind) { console.error('--kind is required'); process.exit(1) }
    if (!summary) { console.error('--summary is required'); process.exit(1) }

    try {
      const item = await getItemByFeatureCode(featureCode)
      const r = await httpPost(`${baseUrl}/api/vision/items/${item.id}/loops`, { kind, summary, ttl_days: ttlDays, parent_branch: parentBranch }, _loopsWorkspaceId)
      if (r.status !== 201) {
        console.error(`Error: ${JSON.stringify(r.body)}`)
        process.exit(1)
      }
      const format = flagVal('--format')
      if (format === 'json') {
        console.log(JSON.stringify(r.body.loop, null, 2))
      } else {
        console.log(`Created loop: ${r.body.loop.id}`)
        console.log(`  kind:    ${r.body.loop.kind}`)
        console.log(`  summary: ${r.body.loop.summary}`)
      }
      process.exit(0)
    } catch (err) {
      console.error(`loops add failed: ${err.message}`)
      process.exit(1)
    }

  } else if (loopsSubcmd === 'list') {
    const includeResolved = hasFlag('--include-resolved')
    const format = flagVal('--format')
    const nowMs = Date.now()

    try {
      const item = await getItemByFeatureCode(featureCode)
      const r = await httpGet(`${baseUrl}/api/vision/items/${item.id}/loops${includeResolved ? '?includeResolved=true' : ''}`, _loopsWorkspaceId)
      if (r.status !== 200) {
        console.error(`Error: ${JSON.stringify(r.body)}`)
        process.exit(1)
      }
      const loops = r.body.loops

      if (format === 'json') {
        console.log(JSON.stringify(loops, null, 2))
        process.exit(0)
      }

      if (loops.length === 0) {
        console.log(`No open loops for ${featureCode}`)
        process.exit(0)
      }

      // Sort oldest first
      const sorted = [...loops].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      // ANSI red for stale
      const RED = '\x1b[31m'
      const RESET = '\x1b[0m'

      for (const loop of sorted) {
        const { isStaleLoop } = await import('../server/open-loops-store.js')
        const stale = isStaleLoop(loop, nowMs)
        const prefix = stale ? `${RED}>TTL ` : '     '
        const suffix = stale ? RESET : ''
        const status = loop.resolution ? '[resolved]' : '[open]'
        console.log(`${prefix}${loop.id.slice(0, 8)}  ${status}  [${loop.kind}]  ${loop.summary}${suffix}`)
      }
      process.exit(0)
    } catch (err) {
      console.error(`loops list failed: ${err.message}`)
      process.exit(1)
    }

  } else if (loopsSubcmd === 'resolve') {
    const loopId = args[1]
    const note = flagVal('--note') || ''

    if (!loopId || loopId.startsWith('-')) {
      console.error('Usage: compose loops resolve <loopId> --feature <FC> [--note "<text>"]')
      process.exit(1)
    }

    try {
      const item = await getItemByFeatureCode(featureCode)
      const r = await httpPost(`${baseUrl}/api/vision/items/${item.id}/loops/${loopId}/resolve`, {
        note,
        resolved_by: process.env.USER || 'unknown',
      }, _loopsWorkspaceId)
      if (r.status !== 200) {
        console.error(`Error: ${JSON.stringify(r.body)}`)
        process.exit(1)
      }
      const format = flagVal('--format')
      if (format === 'json') {
        console.log(JSON.stringify(r.body.loop, null, 2))
      } else {
        console.log(`Resolved loop: ${r.body.loop.id}`)
        if (note) console.log(`  note: ${note}`)
      }
      process.exit(0)
    } catch (err) {
      console.error(`loops resolve failed: ${err.message}`)
      process.exit(1)
    }

  } else {
    console.error(`Unknown loops subcommand: ${loopsSubcmd}`)
    console.error('  compose loops add --feature <FC> --kind <kind> --summary "<text>"')
    console.error('  compose loops list --feature <FC>')
    console.error('  compose loops resolve <loopId> --feature <FC> --note "<text>"')
    process.exit(1)
  }

} else {
  console.error(`Unknown command: ${cmd}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Helper: build per-gate stats for `compose gates report`
// ---------------------------------------------------------------------------
function buildGateStats(entries, rubberStampMs = 3000) {
  const byGate = new Map()

  for (const e of entries) {
    const gid = e.gate_id
    if (!byGate.has(gid)) byGate.set(gid, [])
    byGate.get(gid).push(e)
  }

  const rows = []
  for (const [gate_id, gEntries] of byGate) {
    const n = gEntries.length
    const approve = gEntries.filter(e => e.decision === 'approve').length
    const deny = gEntries.filter(e => e.decision === 'deny').length
    const interrupt = gEntries.filter(e => e.decision === 'interrupt').length
    const durations = gEntries
      .map(e => e.duration_to_decide_ms)
      .filter(d => typeof d === 'number')
      .sort((a, b) => a - b)
    const median_ms = durations.length > 0
      ? durations[Math.floor(durations.length / 2)]
      : null
    const rubber_stamp_count = durations.filter(d => d < rubberStampMs).length
    const rubber_stamp_pct = n > 0 ? (rubber_stamp_count / n) * 100 : 0

    rows.push({
      gate_id,
      logged_decisions: n,
      approve_pct: n > 0 ? (approve / n) * 100 : 0,
      deny_pct:    n > 0 ? (deny    / n) * 100 : 0,
      interrupt_pct: n > 0 ? (interrupt / n) * 100 : 0,
      median_ms,
      rubber_stamp_pct,
    })
  }

  return rows.sort((a, b) => a.gate_id.localeCompare(b.gate_id))
}
