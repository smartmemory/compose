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
import { resolvePort } from '../lib/resolve-port.js'
import { resolveRoadmapPath, resolveFeaturesPath, resolveContextPathFromConfig, resolveFeaturesPathFromConfig, resolveRoadmapPathFromConfig } from '../lib/project-paths.js'
import { installAgentDefs } from '../lib/install-agent-defs.js'

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
import { loadDeps, checkExternalSkills, printDepReport, buildDepReport, checkExternalBinaries, printBinaryReport, buildBinaryReport } from '../lib/deps.js';
import { checkLatestVersion } from '../lib/version-check.js';
import { computeHooksStatus, formatHookStatusLines, HOOK_MARKERS } from '../lib/hooks-status.js';

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
  console.log('  start     Start the compose app (UI + API) for this project')
  console.log('  remote    Manage remote access: pair, list, revoke, status')
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
  console.log('  roadmap xref-sync  Pull-reconcile feature.json external links to live state')
  console.log('  roadmap xref-push  Push-write GitHub trackers to match expect= (dry-run; --apply to write)')
  console.log('  migrate-anon       Promote historical anonymous ROADMAP rows to typed features (interactive)')
  console.log('  items              List vision items from local state (no server)')
  console.log('  items show <id>    Show detail for a specific vision item')
  console.log('  triage    Analyze a feature and recommend build profile')
  console.log('  qa-scope  Show affected routes from a feature\'s changed files')
  console.log('  context decisions  Show the build decision log (--feature <FC>, --format text|json)')
  console.log('  gate list          List pending gates (--item <id>, --status pending|all|resolved)')
  console.log('  gate resolve <id>  Resolve a gate (--approve|--revise|--kill, --comment <text>)')
  console.log('  init      Initialize Compose in the current project')
  console.log('  setup     Install/sync global skills + register stratum-mcp (alias: sync)')
  console.log('  sync      Re-sync global skills from this install (alias of setup)')
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

    // COMP-AGENT-VENDOR-1: install the vendored Claude subagents the compose
    // SKILL.md depends on (compose-explorer/compose-architect) into the Claude
    // agents dir — sibling of the skills root. Claude tree only (basename check):
    // gemini is skipped above and codex shares the claude root.
    if (basename(dirname(agentSkillsRoot)) === '.claude') {
      const agentDefsDest = join(dirname(agentSkillsRoot), 'agents')
      for (const d of installAgentDefs(join(PACKAGE_ROOT, '.claude', 'agents'), agentDefsDest)) {
        console.log(`  + ${agent.name}/agents/${d}`)
      }
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
    printBinaryReport(checkExternalBinaries(deps))
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
    const binaries = buildBinaryReport(checkExternalBinaries(deps))
    console.log(JSON.stringify({ ...report, binaries, version: versionInfo }, null, 2))
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
  printBinaryReport(checkExternalBinaries(deps))
  if (strict && !allRequiredPresent) process.exit(1)
}

// ---------------------------------------------------------------------------
// compose init — project-local setup
// ---------------------------------------------------------------------------

async function runInit(flags, cwdOverride) {
  const noStratum = flags.includes('--no-stratum')
  const noLifecycle = flags.includes('--no-lifecycle')
  // init creates the workspace — never go through resolveCwdWithWorkspace (which
  // requires one to exist). Strip --workspace if present to avoid leaving it in
  // the shared args array for downstream subcommands.
  getWorkspaceFlag(args)
  // cwdOverride lets callers (e.g. runUpdate) target the resolved workspace root
  // instead of process.cwd(), which differs when run from a subdirectory.
  const cwd = cwdOverride || process.cwd()

  // 1. Create .compose/ directory
  const composeDir = join(cwd, '.compose')
  mkdirSync(composeDir, { recursive: true })

  // 2. Detect / auto-install stratum
  let hasStratum = !noStratum && spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
  if (!noStratum && !hasStratum) {
    console.log('stratum-mcp not found — installing via pip...')
    const pipResult = spawnSync('pip', ['install', 'stratum-mcp'], {
      stdio: 'inherit',
      encoding: 'utf-8',
    })
    if (pipResult.status === 0) {
      // Verify the binary is now on PATH
      hasStratum = spawnSync('which', ['stratum-mcp'], { encoding: 'utf-8' }).status === 0
      if (hasStratum) {
        console.log('stratum-mcp installed successfully')
      } else {
        console.warn('Warning: pip install stratum-mcp succeeded but stratum-mcp not found on PATH')
        console.warn('  The binary may live in a pyenv version dir not on $PATH.')
        console.warn('  Try: ln -sf "$(python -c \'import sys,os; print(os.path.join(sys.prefix, "bin", "stratum-mcp"))\')" ~/.local/bin/stratum-mcp')
      }
    } else {
      console.warn('Warning: pip install stratum-mcp failed — Stratum will be disabled')
      console.warn('  Install manually: pip install stratum-mcp  (requires Python >= 3.11)')
    }
  }
  const hasLifecycle = !noLifecycle

  // 3. Detect agents
  const agents = detectAgents()

  // 4. Write .compose/compose.json (merge with existing if present)
  const configPath = join(composeDir, 'compose.json')
  let existing = {}
  let existingConfigCorrupt = false
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, 'utf-8')) }
    catch { existingConfigCorrupt = true }
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
    // Preserve unknown top-level keys (tracker, roadmap, stateVersion, …) — the
    // explicit keys below override the merged sub-objects. Without this spread,
    // init/upgrade silently drops e.g. `roadmap.narrative` and `tracker` config.
    ...existing,
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
      roadmap: 'ROADMAP.md',
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

  // 5a. Run pending feature.json state migrations (COMP-MIGRATE-ON-UPGRADE).
  // Uses init's own resolved cwd; never aborts init on a migration fault. Skip
  // when the prior compose.json was corrupt — init just normalized it to a
  // default, so its tracker/paths can't be trusted to scope the migration.
  if (existingConfigCorrupt) {
    console.warn('state migration skipped: prior compose.json was unreadable (normalized to default; re-run `compose migrate-state` after verifying config)')
  } else {
    try {
      const { runStateMigrations, summarizeMigrationReport } = await import('../lib/state-migrations.js')
      const rep = runStateMigrations(cwd, {})
      const line = summarizeMigrationReport(rep)
      if (line && !rep.noop) console.log(line)
    } catch (err) {
      console.warn(`state migration skipped: ${err.message}`)
    }
  }

  // 5b. Scaffold docs/context/ with ambient context templates.
  // COMP-PATHS-EXTERNAL: resolve from the in-memory config (may be relocated).
  const contextDir = resolveContextPathFromConfig(cwd, config)
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
  const { resolveIdeaboxPath: _resolveIdeaboxPathInit } = await import('../lib/project-paths.js')
  const ideaboxDest = _resolveIdeaboxPathInit(cwd)
  if (!existsSync(ideaboxDest)) {
    mkdirSync(dirname(ideaboxDest), { recursive: true })
    const { IDEABOX_TEMPLATE } = await import('../lib/ideabox.js')
    writeFileSync(ideaboxDest, IDEABOX_TEMPLATE)
    console.log(`Created ${ideaboxDest}`)
  }

  // 5d. STRAT-VOCAB-3: scaffold contracts/vocabulary.yaml (starter is comments-only,
  // so vocabulary enforcement stays inert until the user fills it in).
  const { VOCABULARY_FILE, VOCABULARY_TEMPLATE } = await import('../lib/vocabulary-inject.js')
  const vocabDest = join(cwd, VOCABULARY_FILE)
  if (!existsSync(vocabDest)) {
    mkdirSync(dirname(vocabDest), { recursive: true })
    writeFileSync(vocabDest, VOCABULARY_TEMPLATE)
    console.log(`Created ${vocabDest}`)
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

  // 7. Scaffold ROADMAP.md from template if absent. COMP-PATHS-EXTERNAL:
  // honor a configured (possibly relocated) paths.roadmap instead of always
  // seeding <cwd>/ROADMAP.md. Byte-identical for the default.
  const roadmapDest = resolveRoadmapPathFromConfig(cwd, config)
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
  for (const specName of ['build.stratum.yaml', 'build-quick.stratum.yaml', 'new.stratum.yaml']) {
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
    // Thread the RESOLVED workspace root into runInit (it otherwise uses
    // process.cwd(), which differs when upgrading from a subdirectory). This
    // makes all of init's refresh — including its state-migration step — target
    // the right workspace (COMP-MIGRATE-ON-UPGRADE finding 6).
    await runInit([], cwd)
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

if (cmd === 'setup' || cmd === 'sync') {
  // `sync` is an alias for `setup` — both mirror compose-owned skills into the
  // agent skill dirs and register stratum-mcp. The name `sync` better signals
  // the idempotent "reconcile local skills with this install" job (run it after
  // editing skills locally, when there's no new version to `update` to).
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

if (cmd === 'migrate-state') {
  // COMP-MIGRATE-ON-UPGRADE — run pending feature.json state migrations explicitly.
  // Distinct from `compose roadmap migrate` (ROADMAP→feature.json backfill).
  const { root: cwd } = resolveCwdWithWorkspace(args)
  const dryRun = args.includes('--dry-run')
  const { runStateMigrations, summarizeMigrationReport } = await import('../lib/state-migrations.js')
  const rep = runStateMigrations(cwd, { dryRun })
  if (rep.skipped) {
    console.log(`migrate-state: skipped (${rep.skipped})`)
    process.exit(0)
  }
  console.log(summarizeMigrationReport(rep))
  for (const m of rep.perMigration) {
    if (m.touched.length) console.log(`  [${m.id}] v${m.version}: ${m.touched.join(', ')}`)
  }
  for (const e of rep.parseErrors) console.error(`  unparseable: ${e.path} — ${e.message}`)
  process.exit(0)
}

if (cmd === 'migrate-anon') {
  // COMP-MCP-MIGRATION-2-1-1-1 — interactively promote historical anonymous
  // ROADMAP rows to typed features. The non-TTY guard lives here (where
  // process.stdin does): piped stdin / --non-interactive / --dry-run → list-only,
  // never hang waiting for a prompt.
  const { root: cwd } = resolveCwdWithWorkspace(args)
  const nonInteractive = args.includes('--non-interactive') || args.includes('--dry-run') || !process.stdin.isTTY
  const dryRun = args.includes('--dry-run')
  const { runMigrateAnon } = await import('../lib/migrate-anon.js')
  try {
    await runMigrateAnon(cwd, { nonInteractive, dryRun })
  } catch (err) {
    console.error(`\nError: ${err.message}`)
    process.exit(1)
  }
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
  // COMP-PATHS-EXTERNAL: absolute features dir (may be relocated outside cwd).
  // Never join(cwd, …) below — that would re-root an absolute/../-escaping override.
  const featuresDir = resolveFeaturesPath(cwd)

  // 1. Create feature folder + seed design doc
  const featureDir = join(featuresDir, featureCode)
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
      const fdir = featuresDir
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
  const roadmapPath = resolveRoadmapPath(cwd)
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

  // compose roadmap generate — regenerate ROADMAP.md from feature.json files,
  // converging to a fixed point before finishing.
  if (subcmd === 'generate' || subcmd === 'gen') {
    const { writeRoadmap } = await import('../lib/roadmap-gen.js')
    const { checkRoundtrip } = await import('../lib/roadmap-roundtrip.js')
    const { listFeatures } = await import('../lib/feature-json.js')
    const { loadExternalPrefixes } = await import('../lib/project-paths.js')
    const { isNarrativeOwned } = await import('../lib/roadmap-config.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    // Narrative-owned workspaces (#39): ROADMAP.md is hand-authored, not a render
    // of feature.json. writeRoadmap already no-ops, but the canonicalization pass
    // below would still overwrite the file (or crash if it's absent) — skip the
    // whole generate path here so the hand-authored file is never touched.
    if (isNarrativeOwned(cwd)) {
      console.log('narrative-owned workspace (roadmap.narrative=true) — ROADMAP.md is hand-authored; generate skipped.')
      process.exit(0)
    }
    const path = writeRoadmap(cwd)
    const externalPrefixes = loadExternalPrefixes(cwd)
    // checkRoundtrip's now:'0000-00-00' is only used to detect/canonicalize
    // structural non-convergence — once the file has headings, readPreamble
    // preserves the existing preamble date verbatim, so no sentinel date leaks.
    const rt = checkRoundtrip(readFileSync(path, 'utf-8'), listFeatures(cwd), { now: '0000-00-00', externalPrefixes })
    if (!rt.fixedPoint) {
      writeFileSync(path, rt.canonical)
      console.log(`Generated ${path} (canonicalized over ${rt.passes} passes)`)
    } else {
      console.log(`Generated ${path} from feature.json files`)
    }
    process.exit(0)
  }

  // compose roadmap migrate — extract ROADMAP.md entries into feature.json files
  if (subcmd === 'migrate') {
    const { migrateRoadmap } = await import('../lib/migrate-roadmap.js')
    const { loadExternalPrefixes } = await import('../lib/project-paths.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const dryRun = args.includes('--dry-run')
    const overwrite = args.includes('--overwrite')
    const externalPrefixes = loadExternalPrefixes(cwd)
    const result = migrateRoadmap(cwd, { dryRun, overwrite, externalPrefixes })
    if (!dryRun) {
      console.log(`Created: ${result.created.length} feature.json files`)
      if (result.created.length > 0) console.log(`  ${result.created.join(', ')}`)
      console.log(`Updated: ${result.updated.length}`)
      if (result.updated.length > 0) console.log(`  ${result.updated.join(', ')}`)
      console.log(`Skipped: ${result.skipped.length} (already exist, use --overwrite to replace)`)
      if (result.skipped.length > 0) console.log(`  ${result.skipped.join(', ')}`)
      const ext = result.skippedExternal ?? []
      console.log(`Skipped (external, cross-project refs): ${ext.length}`)
      if (ext.length > 0) console.log(`  ${ext.join(', ')}`)
    }
    process.exit(0)
  }

  // compose roadmap check — verify feature.json ↔ ROADMAP.md consistency
  if (subcmd === 'check') {
    const { listFeatures } = await import('../lib/feature-json.js')
    const { checkRoundtrip, describeLossyDiff } = await import('../lib/roadmap-roundtrip.js')
    const { loadExternalPrefixes } = await import('../lib/project-paths.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const roadmapPath = resolveRoadmapPath(cwd)
    if (!existsSync(roadmapPath)) {
      console.error('No ROADMAP.md found. Run: compose roadmap generate')
      process.exit(1)
    }
    // Narrative-owned workspaces (#39): ROADMAP.md is hand-authored, not a render
    // of feature.json — the roundtrip would always report false drift. The file
    // must still EXIST (checked above); we only skip the drift comparison.
    const { isNarrativeOwned } = await import('../lib/roadmap-config.js')
    if (isNarrativeOwned(cwd)) {
      console.log('narrative-owned workspace (roadmap.narrative=true) — ROADMAP.md is hand-authored; roundtrip check skipped.')
      process.exit(0)
    }
    const externalPrefixes = loadExternalPrefixes(cwd)
    const rt = checkRoundtrip(readFileSync(roadmapPath, 'utf-8'), listFeatures(cwd), { now: '0000-00-00', externalPrefixes })
    if (rt.fixedPoint && rt.lossless) {
      console.log('feature.json and ROADMAP.md are in sync (fixed point, lossless).')
      process.exit(0)
    }
    if (!rt.fixedPoint) {
      const d = rt.diffs.find(x => x.kind === 'FIXED_POINT_DIVERGENCE')
      console.log(`NOT A FIXED POINT: ${d?.detail ?? 'ROADMAP.md changes on regen'}`)
    }
    for (const d of rt.diffs.filter(x => x.kind.startsWith('LOSSLESS_'))) {
      console.log(describeLossyDiff(d))
    }
    console.log('\nRun `compose roadmap generate` to regenerate ROADMAP.md from feature.json.')
    process.exit(1)
  }

  // compose roadmap xref-sync — pull-reconcile feature.json external links'
  // expect= to live target state (COMP-ROADMAP-XREF-SYNC v1). Never writes external.
  if (subcmd === 'xref-sync') {
    const { syncExternalRefs } = await import('../lib/xref-sync.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const dryRun = args.includes('--dry-run')
    const res = await syncExternalRefs(cwd, { dryRun })
    const verb = dryRun ? 'would update' : 'updated'
    if (res.synced.length === 0) {
      console.log(`No external-link drift to reconcile (${res.scanned} resolvable link(s) checked, ${res.unchanged} already in sync).`)
    } else {
      console.log(`${dryRun ? 'Would reconcile' : 'Reconciled'} ${res.synced.length} external link(s):`)
      for (const s of res.synced) console.log(`  ${s.code}  ${s.provider} ${s.target}: expect ${s.from} → ${s.to} (${verb})`)
    }
    if (res.skipped.length > 0) {
      console.log(`\nSkipped ${res.skipped.length} unresolved link(s):`)
      for (const s of res.skipped) console.log(`  ${s.code}  ${s.provider} ${s.target}: ${s.reason}`)
    }
    process.exit(0)
  }

  // compose roadmap xref-push — write GitHub trackers to match feature.json
  // expect= declared intent (COMP-ROADMAP-XREF-PUSH v1). Dry-run by default,
  // per-ref push:true opt-in, --apply to mutate. Degrade-skip, never guesses.
  if (subcmd === 'xref-push') {
    const { pushExternalRefs } = await import('../lib/xref-push.js')
    const { root: cwd } = resolveCwdWithWorkspace(args)
    const apply = args.includes('--apply')
    const res = await pushExternalRefs(cwd, { apply })
    const verb = apply ? 'wrote' : 'would write'
    if (res.pushed.length === 0) {
      console.log(`No external trackers to push (${res.scanned} push-opted link(s) checked, ${res.unchanged} already in sync).`)
    } else {
      console.log(`${apply ? 'Pushed' : 'Would push'} ${res.pushed.length} external target(s):`)
      for (const s of res.pushed) console.log(`  ${s.code}  ${s.provider} ${s.target}: ${s.summary} (${verb})`)
    }
    if (res.skipped.length > 0) {
      console.log(`\nSkipped ${res.skipped.length} link(s):`)
      for (const s of res.skipped) console.log(`  ${s.code}  ${s.provider} ${s.target}: ${s.reason}`)
    }
    if (!apply && res.pushed.length > 0) {
      console.log(`\nDry-run — pass --apply to write these changes.`)
    }
    process.exit(0)
  }

  // compose roadmap graph — generate a self-contained dependency-graph HTML
  // from the canonical vision projection (COMP-ROADMAP-GRAPH-2: the vision
  // model is the single source, deterministically seeded from feature.json +
  // deps.yaml; renders through the one shared renderer).
  if (subcmd === 'graph') {
    const { generateRoadmapGraph, checkRoadmapGraph } = await import('../server/roadmap-graph-vision.js')
    let cwd
    const projIdx = args.indexOf('--project')
    if (projIdx !== -1 && args[projIdx + 1]) {
      cwd = resolve(args[projIdx + 1])
    } else {
      cwd = resolveCwdWithWorkspace(args).root
    }
    let out
    const outIdx = args.indexOf('--out')
    if (outIdx !== -1 && args[outIdx + 1]) out = args[outIdx + 1]
    const checkMode = args.includes('--check')
    try {
      if (checkMode) {
        const r = checkRoadmapGraph(cwd, { out })
        for (const w of r.warnings) console.warn(`  warning: ${w}`)
        if (r.matches) {
          console.log(`roadmap-graph up to date (${r.nodeCount} nodes, ${r.edgeCount} edges): ${r.path}`)
          process.exit(0)
        }
        console.error(r.diffSummary)
        process.exit(1)
      }
      const r = generateRoadmapGraph(cwd, { out })
      for (const w of r.warnings) console.warn(`  warning: ${w}`)
      console.log(`Generated ${r.path} — ${r.nodeCount} nodes, ${r.edgeCount} edges` +
        (r.droppedCount ? ` (${r.droppedCount} completed/superseded/killed dropped)` : ''))
      process.exit(0)
    } catch (err) {
      if (err && err.code === 'DANGLING_EDGE') {
        console.error(err.message)
        console.error('\nFix the deps.yaml edge(s) above, or complete/register the missing feature(s).')
        process.exit(1)
      }
      throw err
    }
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
  const roadmapPath = resolveRoadmapPath(cwd)

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
      marker:   HOOK_MARKERS['post-commit'],
      dest:     pjoin(hooksDir, 'post-commit'),
    },
    'pre-push': {
      template: pjoin(presolve(futp(import.meta.url), '..'), 'git-hooks', 'pre-push.template'),
      marker:   HOOK_MARKERS['pre-push'],
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

  // Resolve the expected workspace id once (identical across hook types).
  // Hook-status detection itself lives in lib/hooks-status.js (shared with the
  // /api/environment-health endpoint); this just supplies the comparison id.
  function resolveExpectedWsId() {
    const wsHint = hookFlags['workspace']
    try {
      return resolveWorkspace(wsHint ? { cwd: projectRoot, workspaceId: wsHint } : { cwd: projectRoot }).id
    } catch { return null /* ignore for status */ }
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
    const computed = computeHooksStatus({
      projectRoot,
      expectedWsId: resolveExpectedWsId(),
      composeNode,
      composeBin,
    })
    for (const t of Object.keys(HOOK_TYPES)) {
      for (const line of formatHookStatusLines(t, computed[t], { composeNode, composeBin })) {
        console.log(line)
      }
    }
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
  let externalXref = false
  let doFix = false
  let doApply = false
  let fixClasses = null
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
  --fix                       Reconcile mechanical drift (dry-run: prints a fix plan)
  --apply                     With --fix, write the fixes (default is dry-run)
  --fix-class=CSV             Override the fix class set, e.g.
                              dangling_link,invalid_link_kind,status_fj_vision,
                              partial_age,roadmap_status_rewrite,invalid_link_kind_repair

Exit codes:
  0   no findings >= block-on threshold
  1   findings >= block-on threshold present
  2   usage error (or reconcile refused on a non-local provider)`)
      process.exit(0)
    }
    if (a === '--json') { asJson = true; continue }
    if (a === '--external') { externalXref = true; continue }
    if (a === '--fix') { doFix = true; continue }
    if (a === '--apply') { doApply = true; continue }
    if (a.startsWith('--fix-class=')) { fixClasses = a.slice('--fix-class='.length).split(',').map((s) => s.trim()).filter(Boolean); continue }
    if (a.startsWith('--scope=')) scope = a.slice('--scope='.length)
    else if (a === '--scope') scope = args[++i]
    else if (a.startsWith('--code=')) code = a.slice('--code='.length)
    else if (a === '--code') code = args[++i]
    else if (a.startsWith('--block-on=')) blockOn = a.slice('--block-on='.length)
    else if (a === '--block-on') blockOn = args[++i]
    else if (a === '--workspace' || a.startsWith('--workspace=')) {
      // --workspace is a valid global flag consumed by resolveCwdWithWorkspace(args)
      // below; skip it here so the unknown-flag guard doesn't reject it. Don't
      // consume the next token: a bare `--workspace <id>` leaves <id> as a
      // positional (harmlessly ignored by this loop, parsed by resolveCwdWith-
      // Workspace), so `--workspace --help` still resolves --help correctly.
    }
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
      : await validateProject(valCwd, { external: externalXref })
  } catch (err) {
    if (err.code === 'INVALID_INPUT') {
      console.error(`Error [INVALID_INPUT]: ${err.message}`)
      process.exit(2)
    }
    console.error(`Error: ${err.message}`)
    process.exit(2)
  }

  // --fix: reconcile mechanical drift. Dry-run prints a plan; --apply writes and
  // re-validates so the exit code reflects what's left after the fixes.
  let reconcile = null
  if (doFix) {
    const { reconcileProject } = await import('../lib/feature-reconciler.js')
    reconcile = await reconcileProject(valCwd, {
      apply: doApply,
      classes: fixClasses,
      scope,
      code,
      external: externalXref,
    })
    if (reconcile.refused === 'non_local_provider') {
      console.error('compose validate --fix: reconcile is local-provider only (this workspace uses a remote tracker). No changes made.')
      process.exit(2)
    }
    if (doApply) {
      // Re-validate so findings/exit reflect the post-fix state.
      result = scope === 'feature'
        ? await validateFeature(valCwd, code)
        : await validateProject(valCwd, { external: externalXref })
    }
    if (!asJson) {
      const verb = doApply ? 'applied' : 'would apply'
      const total = reconcile.plan.length
      console.log(`compose validate --fix (${doApply ? 'apply' : 'dry-run'}): ${verb} ${total} fix(es)`)
      for (const e of reconcile.plan) {
        const cls = e.classes.join(',')
        console.log(`  [${cls}] ${e.feature_code}: ${e.action}`)
        console.log(`    before: ${Array.isArray(e.before) ? e.before.join(', ') : e.before}`)
        console.log(`    after:  ${Array.isArray(e.after) ? e.after.join(', ') : e.after}`)
      }
      for (const s of reconcile.skipped_classes || []) {
        console.log(`  (skipped class ${s.class}: ${s.reason})`)
      }
      if (doApply) {
        const failed = (reconcile.applied || []).filter((a) => !a.ok)
        if (failed.length) {
          console.log(`  ${failed.length} fix(es) failed:`)
          for (const f of failed) console.log(`    ${f.feature_code} ${f.action}: ${f.error}`)
        }
        const noops = (reconcile.applied || []).filter((a) => a.ok && a.noop)
        if (noops.length) {
          console.log(`  ${noops.length} fix(es) made no change (refused as unsafe/ambiguous; left for manual review):`)
          for (const n of noops) console.log(`    ${n.feature_code} ${n.action}`)
        }
      }
      console.log('')
    }
  }

  // Threshold: findings at or above this severity block the exit code
  const SEV_RANK = { error: 3, warning: 2, info: 1 }
  const threshold = SEV_RANK[blockOn]
  const blocking = result.findings.filter((f) => SEV_RANK[f.severity] >= threshold)

  if (asJson) {
    console.log(JSON.stringify(reconcile ? { ...result, reconcile } : result, null, 2))
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
  // COMP-BUILD-QUICK: --quick selects the trimmed build-quick pipeline
  // (design → implement → ship). Symmetric to fix mode's Quick path; the real
  // mirror is the existing --template mechanism (fix dispatches template:'bug-fix'),
  // so --quick is sugar for template:'build-quick'. Single-feature only.
  const quick = filteredArgs2.includes('--quick')
  // COMP-CODEX-IMPL: --codex flips the implementer to Codex (Claude reviews). v1 is
  // full-build, single-feature only — mutually exclusive with --quick and batch.
  const codex = filteredArgs2.includes('--codex')

  // Multiple codes: compose build FEAT-1 FEAT-2 FEAT-3
  const isMulti = featureCodes.length > 1
  // Single prefix: compose build STRAT-COMP (no trailing digit)
  const isPrefix = featureCodes.length === 1 && featureCode && !/\d$/.test(featureCode)
  const isBatch = all || isPrefix || isMulti

  if (abort && isBatch) {
    console.error('Error: --abort and --all/prefix/multi are mutually exclusive')
    process.exit(1)
  }

  // COMP-BUILD-QUICK: --quick is a single-feature shortcut for a specific
  // template, so it conflicts with an explicit --template and with batch builds.
  if (quick && templateName) {
    console.error('Error: --quick and --template are mutually exclusive (--quick selects the build-quick template)')
    process.exit(1)
  }
  if (quick && isBatch) {
    console.error('Error: --quick cannot be combined with --all/prefix/multi (single feature only)')
    process.exit(1)
  }

  // COMP-CODEX-IMPL: v1 scopes --codex to the full build, single feature.
  if (codex && quick) {
    console.error('Error: --codex and --quick are mutually exclusive in v1 (build-quick Codex parity is a follow-up)')
    process.exit(1)
  }
  if (codex && templateName) {
    console.error('Error: --codex and --template are mutually exclusive (--codex parameterizes the build template)')
    process.exit(1)
  }
  if (codex && isBatch) {
    console.error('Error: --codex cannot be combined with --all/prefix/multi (single feature only in v1)')
    process.exit(1)
  }

  if (!featureCode && !abort && !all) {
    console.error('Usage: compose build <feature-code> [feature-code...]')
    console.error('       compose build STRAT-COMP          (prefix — builds all matching)')
    console.error('       compose build --all               (builds entire roadmap)')
    console.error('')
    console.error('Options:')
    console.error('  --quick        Trimmed lifecycle (design → implement → ship) for small additive work')
    console.error('  --abort        Abort the active build')
    console.error('  --all          Build all PLANNED features in dependency order')
    console.error('  --dry-run      Print build order without executing')
    console.error('  --cwd <path>   Agent working directory (for cross-repo features)')
    process.exit(1)
  }

  // Auto-init if needed. COMP-BUILD-QUICK: a workspace initialized before the
  // build-quick pipeline existed won't have pipelines/build-quick.stratum.yaml,
  // and there's no bundled preset fallback — so when --quick is requested and
  // that file is absent, treat it as init-needed (runInit re-seeds it) rather
  // than letting runBuild fail later with "Lifecycle spec not found".
  const { root: buildCwd } = resolveCwdWithWorkspace(args)
  const needsInit =
    !existsSync(join(buildCwd, '.compose', 'compose.json')) ||
    !existsSync(join(buildCwd, 'pipelines', 'build.stratum.yaml')) ||
    (quick && !existsSync(join(buildCwd, 'pipelines', 'build-quick.stratum.yaml')))
  if (needsInit) {
    console.log('Running compose init...\n')
    // Thread the RESOLVED workspace root into runInit. Without it runInit seeds
    // process.cwd(), which differs from buildCwd when invoked from a subdirectory
    // — the guard checks buildCwd but the seed would land in the wrong dir, so
    // runBuild would still fail with the same missing-spec error (Codex review).
    await runInit(args.filter(a => a.startsWith('--')), buildCwd)
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
      if (quick) singleOpts.template = 'build-quick'   // COMP-BUILD-QUICK
      if (codex) singleOpts.codex = true               // COMP-CODEX-IMPL
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

  // COMP-GSD-6: `compose gsd query <feature>` — instant read-only JSON snapshot
  // (no LLM/server/Stratum). For status pollers + CI dashboards.
  if (args[0] === 'query') {
    const qCode = args.find((a, i) => i > 0 && !a.startsWith('-'))
    if (!qCode) {
      console.error('Usage: compose gsd query <feature-code> [--cwd <path>]')
      process.exit(1)
    }
    const { root: qRoot } = resolveCwdWithWorkspace(args.slice(1))
    const qCwdIdx = args.indexOf('--cwd')
    const qCwd = qCwdIdx !== -1 ? resolve(args[qCwdIdx + 1]) : qRoot
    const { buildGsdQuery } = await import('../lib/gsd-state.js')
    const snapshot = buildGsdQuery(qCwd, qCode)
    console.log(JSON.stringify(snapshot, null, 2))
    process.exit(snapshot.status === 'absent' ? 3 : 0)
  }

  // COMP-GSD-7: `compose gsd report <feature>` — (re)generate the milestone HTML
  // report from persisted run artifacts (auto-generated on completion; this is
  // the retroactive/archival path). Writes docs/gsd-reports/<feature>.html.
  if (args[0] === 'report') {
    const rCwdIdx = args.indexOf('--cwd')
    const rCwdValIdx = rCwdIdx !== -1 ? rCwdIdx + 1 : -1
    const rCode = args.find((a, i) => i > 0 && i !== rCwdValIdx && !a.startsWith('-'))
    if (!rCode) {
      console.error('Usage: compose gsd report <feature-code> [--cwd <path>]')
      process.exit(1)
    }
    const { root: rRoot } = resolveCwdWithWorkspace(args.slice(1))
    const rCwd = rCwdIdx !== -1 ? resolve(args[rCwdIdx + 1]) : rRoot
    const { generateGsdMilestoneReport } = await import('../lib/gsd-milestone-report.js')
    const r = generateGsdMilestoneReport(rCode, rCwd)
    if (!r.ok) {
      console.error(`gsd report: ${r.error}`)
      process.exit(1)
    }
    console.log(`Milestone report written: ${r.path}`)
    process.exit(0)
  }

  const gsdCode = args.find(a => !a.startsWith('-'))
  const gsdResume = args.includes('--resume')
  const gsdResetBudget = args.includes('--reset-budget')
  const gsdHeadless = args.includes('--headless')
  if (!gsdCode) {
    console.error('Usage: compose gsd <feature-code> [--resume] [--reset-budget] [--headless]')
    console.error('       compose gsd query <feature-code>   (instant JSON status snapshot)')
    console.error('       compose gsd report <feature-code>  (generate milestone HTML report)')
    console.error('')
    console.error('Runs the per-task fresh-context dispatch pipeline (COMP-GSD-2).')
    console.error('Hard-requires docs/features/<code>/blueprint.md with a valid Boundary Map.')
    console.error('Detects stuck tasks (COMP-GSD-5) and halts with a structured diagnostic.')
    console.error('Enforces budget ceilings (COMP-GSD-4) from .compose/compose.json gsd.budget.*')
    console.error('')
    console.error('Options:')
    console.error('  --resume        Resume a halted run: re-dispatch the unfinished tasks')
    console.error('                  from .compose/gsd/<code>/pause.json (skips completed tasks).')
    console.error('  --reset-budget  Clear the feature\'s cumulative budget ledger before running')
    console.error('                  (use after raising or removing a spent gsd.budget.cumulative cap).')
    console.error('  --headless      Unattended supervisor (COMP-GSD-6): auto-resume on crash/stuck')
    console.error('                  with backoff + crash recovery. Policy: gsd.headless.* in compose.json.')
    console.error('  --cwd <path>    Working directory (defaults to current)')
    process.exit(1)
  }
  const { root: gsdCwd } = resolveCwdWithWorkspace(args)
  const cwdIdx = args.indexOf('--cwd')
  const gsdAgentCwd = cwdIdx !== -1 ? resolve(args[cwdIdx + 1]) : gsdCwd

  // COMP-GSD-6: --headless hands off to the supervisor, which spawns plain
  // `compose gsd` children and auto-resumes per policy. Exit 0 on completion,
  // non-zero on a terminal stop (failed/fatal/budget/stuck-exhausted/aborted).
  if (gsdHeadless) {
    const { runGsdHeadless } = await import('../lib/gsd-supervisor.js')
    try {
      const r = await runGsdHeadless(gsdCode, { cwd: gsdAgentCwd, resume: gsdResume })
      if (r.ok) {
        console.log(`gsd headless: complete after ${r.attempts} attempt(s).`)
        process.exit(0)
      }
      console.error(`gsd headless: stopped with status "${r.status}" after ${r.attempts} attempt(s).`)
      console.error(`Query: compose gsd query ${gsdCode}`)
      process.exit(r.status === 'failed' || r.status === 'fatal' ? 1 : 2)
    } catch (err) {
      console.error(`gsd headless failed: ${err.message}`)
      process.exit(1)
    }
  }

  const { runGsd } = await import('../lib/gsd.js')
  try {
    if (gsdResetBudget) {
      // COMP-GSD-4: clear the cumulative ledger so a spent ceiling no longer
      // refuses the run. Runs before dispatch; per-run windows reset anyway.
      const { resetGsdUsage } = await import('../lib/budget-ledger.js')
      resetGsdUsage(resolve(gsdAgentCwd, '.compose'), gsdCode)
      console.log(`gsd: cleared cumulative budget ledger for ${gsdCode}.`)
    }
    const result = await runGsd(gsdCode, { cwd: gsdAgentCwd, resume: gsdResume })
    if (result.status === 'stuck') {
      // COMP-GSD-5: a stuck halt is a clean, recoverable stop — not a crash.
      console.error(`gsd stuck: task ${result.stuckTaskId} tripped the ${result.signal} detector.`)
      console.error(`Diagnostic: .compose/gsd/${gsdCode}/stuck.md`)
      console.error(`Resume with: compose gsd ${gsdCode} --resume`)
      process.exit(2)
    }
    if (result.status === 'budget') {
      // COMP-GSD-4: a budget halt is a clean, recoverable stop — not a crash.
      if (result.axis === 'cumulative') {
        console.error(`gsd budget: cumulative ceiling for ${gsdCode} is already spent.`)
        console.error(`Diagnostic: .compose/gsd/${gsdCode}/budget.md`)
        console.error(`Raise gsd.budget.cumulative.* or clear it: compose gsd ${gsdCode} --reset-budget`)
      } else {
        console.error(`gsd budget: the ${result.axis} ceiling tripped mid-run.`)
        console.error(`Diagnostic: .compose/gsd/${gsdCode}/budget.md`)
        console.error(`Raise gsd.budget.* and resume: compose gsd ${gsdCode} --resume`)
      }
      process.exit(2)
    }
    if (result.status !== 'complete') {
      // COMP-GSD-6: any non-complete terminal (e.g. a stratum 'killed') is a
      // failure, not success — don't print "complete" or exit 0.
      console.error(`gsd ${result.status}: run ended without completing.`)
      console.error(`Inspect: compose gsd query ${gsdCode}`)
      process.exit(1)
    }
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

  // --host=<addr> forwards COMPOSE_HOST to the supervisor → api-server child.
  // supervisor.js already threads COMPOSE_HOST to api-server only; agent-server
  // stays 127.0.0.1 always (see supervisor.js ~line 146).
  const hostFlagIdx = args.findIndex((a) => a.startsWith('--host='))
  const startEnv = { ...process.env, COMPOSE_TARGET: targetRoot }
  if (hostFlagIdx !== -1) {
    startEnv.COMPOSE_HOST = args[hostFlagIdx].slice('--host='.length)
  }

  const child = spawn('node', [join(PACKAGE_ROOT, 'server', 'supervisor.js')], {
    stdio: 'inherit',
    cwd: PACKAGE_ROOT,
    env: startEnv,
  })
  child.on('error', (err) => {
    console.error(`Failed to start compose: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
} else if (cmd === 'remote') {
  // ---------------------------------------------------------------------------
  // compose remote — remote access management (COMP-MOBILE-REMOTE S03)
  // ---------------------------------------------------------------------------
  const { runRemoteCommand } = await import('../lib/cli-remote.js')
  const { root: remoteCwd } = resolveCwdWithWorkspace(args)

  await runRemoteCommand(args, {
    port: resolvePort(),
    token: process.env.COMPOSE_API_TOKEN,
    cwd: remoteCwd,
    lines: { push: (l) => console.log(l) },
    // qr and poll use defaults (qrcode-terminal + setTimeout)
  }).catch((err) => {
    // Errors already printed to output; only exit non-zero
    if (
      err.message !== 'COMPOSE_API_TOKEN not set' &&
      err.message !== '--yes required' &&
      err.message !== 'Missing device-id'
    ) {
      console.error(`remote: ${err.message}`)
    }
    process.exit(1)
  })
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
  // ibFullPath is used for direct file ops (existsSync/mkdirSync/writeFileSync/
  // display); resolve it absolute-safe. ibRelPath stays relative because the
  // lib readIdeabox/writeIdeabox readers re-join it under ibCwd.
  const { resolveIdeaboxPath: _resolveIdeaboxPathCli } = await import('../lib/project-paths.js')
  const ibFullPath = _resolveIdeaboxPathCli(ibCwd)

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

    // Create feature folder if missing — respect paths.features (may be
    // relocated outside ibCwd — COMP-PATHS-EXTERNAL; resolve absolute, no re-root)
    const featuresBase = resolveFeaturesPathFromConfig(ibCwd, ibConfig)
    const featuresDir = join(featuresBase, resolvedCode)
    if (!existsSync(featuresDir)) {
      // COMP-MCP-VALIDATE-1: route through the validated writer (schema-guarded)
      // instead of a raw writeFileSync.
      const { writeFeature } = await import('../lib/feature-json.js')
      writeFeature(ibCwd, {
        code: resolvedCode,
        description: idea.title,
        status: 'PLANNED',
        promotedFrom: ideaId,
        createdAt: new Date().toISOString(),
      }, featuresBase)
      console.log(`Created feature folder: ${join(featuresBase, resolvedCode)}/`)
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

} else if (cmd === 'context') {
  // ---------------------------------------------------------------------------
  // compose context decisions [--feature <FC>] [--format text|json]
  // COMP-CTX-3: read-side of the decision log. During `compose build` each gate
  // outcome is auto-appended to docs/context/decisions.md (appendDecisionEntry);
  // this surfaces it. Read-only; no server.
  // ---------------------------------------------------------------------------
  const contextSubcmd = args[0]
  if (contextSubcmd === 'decisions') {
    const { existsSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { resolveContextPath } = await import('../lib/project-paths.js')
    const flagVal = (flag) => {
      const i = args.indexOf(flag)
      return i !== -1 && args[i + 1] ? args[i + 1] : null
    }
    const featureFilter = flagVal('--feature')
    const format = flagVal('--format') || 'text'

    const decisionsPath = join(resolveContextPath(process.cwd()), 'decisions.md')
    if (!existsSync(decisionsPath)) {
      console.error(`No decision log at ${decisionsPath} — run \`compose init\` to scaffold docs/context/, then decisions accrue during builds.`)
      process.exit(1)
    }
    const raw = readFileSync(decisionsPath, 'utf-8')

    // Each entry is a "## [YYYY-MM-DD] FEATURE — step" heading + body
    // (see appendDecisionEntry in lib/build.js). Slice raw on the headings.
    const heads = []
    const re = /^## \[(\d{4}-\d{2}-\d{2})\] (\S+) — (.+)$/gm
    let m
    while ((m = re.exec(raw)) !== null) {
      heads.push({ idx: m.index, date: m[1], feature: m[2], step: m[3] })
    }
    const blocks = heads.map((h, i) => ({
      ...h,
      text: raw.slice(h.idx, i + 1 < heads.length ? heads[i + 1].idx : raw.length).trim(),
    }))
    const filtered = featureFilter ? blocks.filter(b => b.feature === featureFilter) : blocks

    if (format === 'json') {
      const out = filtered.map(b => ({
        date: b.date,
        feature: b.feature,
        step: b.step,
        outcome: (b.text.match(/\*\*Outcome:\*\* (.+)/) || [])[1] || null,
        rationale: (b.text.match(/\*\*Rationale:\*\* ([\s\S]+?)(?:\n## |\s*$)/) || [])[1]?.trim() || null,
      }))
      console.log(JSON.stringify(out, null, 2))
    } else if (filtered.length === 0) {
      console.log(featureFilter ? `No decisions recorded for ${featureFilter}.` : 'No decisions recorded yet.')
    } else {
      const label = featureFilter ? ` for ${featureFilter}` : ''
      console.log(`Decision log${label} — ${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'}:\n`)
      for (const b of filtered) console.log(b.text + '\n')
    }
  } else {
    console.error('usage: compose context decisions [--feature <FC>] [--format text|json]')
    process.exit(1)
  }

} else if (cmd === 'gates' || cmd === 'gate') {
  // ---------------------------------------------------------------------------
  // compose gate list [--item <id>] [--status pending|all|resolved] [--format text|json]
  // compose gate resolve <gateId> (--approve|--revise|--kill) [--comment <text>] [--reason <text>]
  //   COMP-PARITY-1: CLI gate resolution — wraps GET/POST /api/vision/gates[/:id/resolve]
  // compose gates report [--since 24h|7d|1h|<ISO>] [--feature <FC>]
  //                       [--format text|json] [--rubber-stamp-ms <N>]
  //   COMP-OBS-GATELOG: audit gate log report (Decision 5)
  // (`gate` and `gates` are aliases.)
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

  if (gatesSubcmd === 'list' || gatesSubcmd === 'resolve') {
    // --- COMP-PARITY-1: CLI gate list/resolve over the :4001 vision endpoints ---
    const flagVal = (flag) => { const i = args.indexOf(flag); return i !== -1 && args[i + 1] ? args[i + 1] : null }
    const hasFlag = (flag) => args.includes(flag)
    const baseUrl = process.env.COMPOSE_URL || `http://127.0.0.1:${resolvePort()}`

    // Tolerant workspace resolution (mirror `compose loops`): attach the header
    // when resolvable, otherwise send none (server soft-falls back to boot ws).
    let _wsId = null
    try {
      const wsId = getWorkspaceFlag(args)
      const ws = resolveWorkspace({ workspaceId: wsId === '__COMPOSE_WORKSPACE_ID__' ? null : wsId })
      _wsId = ws.id || null
    } catch { /* no header */ }

    const reqJson = async (method, urlStr, body) => {
      const { default: http } = await import(urlStr.startsWith('https') ? 'https' : 'http')
      return new Promise((resolveP, reject) => {
        const u = new URL(urlStr)
        const data = body ? JSON.stringify(body) : null
        const headers = {}
        if (_wsId) headers['X-Compose-Workspace-Id'] = _wsId
        if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data) }
        // Sensitive-token header — only consumed when capabilities.guardAuth is on.
        if (method === 'POST' && process.env.COMPOSE_API_TOKEN) headers['x-compose-token'] = process.env.COMPOSE_API_TOKEN
        const r = http.request({
          hostname: u.hostname,
          port: u.port || (urlStr.startsWith('https') ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers,
        }, (res) => {
          let buf = ''
          res.on('data', c => { buf += c })
          res.on('end', () => { try { resolveP({ status: res.statusCode, body: JSON.parse(buf) }) } catch { resolveP({ status: res.statusCode, body: buf }) } })
        })
        r.on('error', reject)
        if (data) r.end(data); else r.end()
      })
    }

    const dieUnreachable = (err) => {
      if (err && (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(err.message || ''))) {
        console.error(`compose server not reachable on :${resolvePort()} — start it with \`npm run dev:server\` (or \`npm run dev:watch\`)`)
      } else {
        console.error(`gate ${gatesSubcmd}: ${err.message}`)
      }
      process.exit(1)
    }

    if (gatesSubcmd === 'list') {
      const itemId = flagVal('--item')
      const status = flagVal('--status') || 'pending'
      const format = flagVal('--format') || 'text'
      if (!['pending', 'all', 'resolved'].includes(status)) {
        console.error(`gate list: --status must be one of pending|all|resolved (got '${status}')`)
        process.exit(1)
      }
      if (!['text', 'json'].includes(format)) {
        console.error(`gate list: --format must be one of text|json (got '${format}')`)
        process.exit(1)
      }
      const params = new URLSearchParams()
      if (status !== 'pending') params.set('status', status)
      if (itemId) params.set('itemId', itemId)
      const qs = params.toString() ? `?${params.toString()}` : ''
      let resp
      try { resp = await reqJson('GET', `${baseUrl}/api/vision/gates${qs}`) } catch (e) { dieUnreachable(e) }
      if (resp.status !== 200) {
        console.error(`gate list failed (HTTP ${resp.status}): ${resp.body?.error || JSON.stringify(resp.body)}`)
        process.exit(1)
      }
      // The server only honors itemId on the pending path; filter client-side so
      // --item works uniformly across --status all|resolved too (Codex review).
      let gates = resp.body.gates || []
      if (itemId) gates = gates.filter(g => g.itemId === itemId)
      if (format === 'json') { console.log(JSON.stringify(gates, null, 2)); process.exit(0) }
      if (gates.length === 0) { console.log(`No ${status} gates.`); process.exit(0) }
      const ageOf = (iso) => {
        const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
        if (m < 60) return `${m}m`
        const h = Math.floor(m / 60)
        return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
      }
      // Record-per-gate, not a fixed-width table: real gate ids are long
      // `<uuid>:<step>:<round>` strings, so columns smush together. Keep the full
      // copy-pasteable id on its own line (it's the arg to `gate resolve`).
      console.log(`${gates.length} ${status} gate${gates.length === 1 ? '' : 's'}:\n`)
      for (const g of gates) {
        console.log(`${g.id}  [${g.status || 'pending'}]`)
        console.log(`    item ${g.itemId || '·'}   step ${g.stepId || '·'}   ${g.fromPhase || '·'}→${g.toPhase || '·'}   ${ageOf(g.createdAt)}\n`)
      }
      process.exit(0)
    }

    if (gatesSubcmd === 'resolve') {
      const gateId = args[1] && !args[1].startsWith('-') ? args[1] : null
      if (!gateId) {
        console.error('usage: compose gate resolve <gateId> (--approve|--revise|--kill) [--comment <text>] [--reason <text>]')
        process.exit(1)
      }
      const outcomes = ['approve', 'revise', 'kill'].filter(o => hasFlag(`--${o}`))
      if (outcomes.length !== 1) {
        console.error('gate resolve: exactly one of --approve | --revise | --kill is required')
        process.exit(1)
      }
      const outcome = outcomes[0]
      const comment = flagVal('--comment') ?? flagVal('--reason') ?? undefined
      let resp
      try {
        resp = await reqJson('POST', `${baseUrl}/api/vision/gates/${encodeURIComponent(gateId)}/resolve`, { outcome, comment, resolvedBy: 'cli' })
      } catch (e) { dieUnreachable(e) }
      if (resp.status < 200 || resp.status >= 300) {
        console.error(`gate resolve failed (HTTP ${resp.status}): ${resp.body?.error || JSON.stringify(resp.body)}`)
        process.exit(1)
      }
      console.log(`Gate ${gateId} resolved: ${outcome}${comment ? ` — ${comment}` : ''}`)
      process.exit(0)
    }
  }

  console.error(`Unknown gate subcommand: ${gatesSubcmd}`)
  console.error('Usage:')
  console.error('  compose gate list [--item <id>] [--status pending|all|resolved] [--format text|json]')
  console.error('  compose gate resolve <gateId> (--approve|--revise|--kill) [--comment <text>] [--reason <text>]')
  console.error('  compose gates report [--since 24h] [--feature FC] [--format text|json] [--rubber-stamp-ms N]')
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

  // Resolve compose server URL. Default must match the API server port
  // (resolvePort: COMPOSE_PORT > PORT > 4001) — a stale :3000 here made every
  // `compose loops` call fail with ECONNREFUSED in a default install.
  const baseUrl = process.env.COMPOSE_URL || `http://127.0.0.1:${resolvePort()}`

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

} else if (cmd === 'tracker') {
  // ---------------------------------------------------------------------------
  // compose tracker status   — print provider name, canonical, pendingOps, conflicts, mixedSources
  // compose tracker sync     — flush op-log and report drained/quarantined counts
  // COMP-TRACKER-PROVIDER T18
  // ---------------------------------------------------------------------------
  try {
    const { runTrackerCli } = await import('../lib/tracker/cli.js')
    const result = await runTrackerCli(process.cwd(), args)
    console.log(result.output)
    if (result.exitCode !== 0) process.exit(result.exitCode)
  } catch (err) {
    console.error(`tracker: ${err.message}`)
    process.exit(1)
  }

} else if (cmd === 'items') {
  // ---------------------------------------------------------------------------
  // compose items — read vision-state.json directly (no server required)
  // ---------------------------------------------------------------------------
  const itemsSub = args[0] && !args[0].startsWith('-') ? args[0] : 'list'
  const jsonFlag = args.includes('--json')

  const { root: itemsCwd } = resolveCwdWithWorkspace(args)
  const vsPath = join(itemsCwd, '.compose', 'data', 'vision-state.json')

  if (!existsSync(vsPath)) {
    console.error('No vision state found at .compose/data/vision-state.json')
    console.error('Run `compose start` at least once to generate it, then you can use `compose items` offline.')
    process.exit(1)
  }

  let visionState
  try {
    visionState = JSON.parse(readFileSync(vsPath, 'utf-8'))
  } catch (err) {
    console.error(`Failed to read vision state: ${err.message}`)
    process.exit(1)
  }

  const allItems = visionState.items || []

  if (itemsSub === 'list') {
    if (jsonFlag) {
      console.log(JSON.stringify(allItems, null, 2))
      process.exit(0)
    }

    if (allItems.length === 0) {
      console.log('No items found.')
      process.exit(0)
    }

    // Table output: id (truncated), title, status, type
    const header = { id: 'ID', title: 'TITLE', status: 'STATUS', type: 'TYPE' }
    const rows = allItems.map(it => ({
      id: (it.id || '').slice(0, 8),
      title: (it.title || '(untitled)').slice(0, 50),
      status: it.status || '-',
      type: it.type || '-',
    }))

    // Compute column widths
    const cols = ['id', 'title', 'status', 'type']
    const widths = {}
    for (const c of cols) {
      widths[c] = Math.max(header[c].length, ...rows.map(r => r[c].length))
    }

    const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length))
    const line = cols.map(c => pad(header[c], widths[c])).join('  ')
    console.log(line)
    console.log(cols.map(c => '-'.repeat(widths[c])).join('  '))
    for (const r of rows) {
      console.log(cols.map(c => pad(r[c], widths[c])).join('  '))
    }
    process.exit(0)

  } else if (itemsSub === 'show') {
    const positionalArgs = args.filter(a => !a.startsWith('-'))
    const showId = positionalArgs[1]
    if (!showId) {
      console.error('Usage: compose items show <id>')
      process.exit(1)
    }

    const matches = allItems.filter(it => it.id === showId || it.id.startsWith(showId))
    if (matches.length > 1) {
      console.error(`Ambiguous ID prefix '${showId}' matches ${matches.length} items:`)
      for (const m of matches) console.error(`  ${(m.id || '').slice(0, 8)}  ${m.title || '(untitled)'}`)
      process.exit(1)
    }
    const match = matches[0]
    if (!match) {
      console.error(`No item found matching: ${showId}`)
      process.exit(1)
    }

    if (jsonFlag) {
      console.log(JSON.stringify(match, null, 2))
    } else {
      for (const [key, val] of Object.entries(match)) {
        if (val == null) continue
        if (typeof val === 'object') {
          console.log(`${key}: ${JSON.stringify(val)}`)
        } else {
          console.log(`${key}: ${val}`)
        }
      }
    }
    process.exit(0)

  } else {
    console.error(`Unknown items subcommand: ${itemsSub}`)
    console.error('Usage:')
    console.error('  compose items              List all items')
    console.error('  compose items list         List all items')
    console.error('  compose items show <id>    Show detail for a specific item')
    console.error('  --json                     Output as JSON')
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
