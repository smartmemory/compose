/**
 * cli-commands.js — COMP-AUDIT-13: the single source of truth for compose's
 * top-level command surface.
 *
 * `compose --help` (bin/compose.js) and the Command Index in docs/cli.md are
 * both rendered from COMMANDS here, so installed capability can never again be
 * invisible unless a command is missing from this table — and a drift-guard test
 * (test/cli-commands.test.js) asserts this table matches the real dispatch
 * branches in bin/compose.js in both directions.
 *
 * To add a command: add its `cmd === '<name>'` branch in bin/compose.js AND a
 * row here. The test fails until both exist.
 */

/**
 * @typedef {Object} Command
 * @property {string} name        Canonical command token (matches `cmd === '<name>'`)
 * @property {string[]} aliases   Alternate tokens that dispatch the same command
 * @property {string} group       Display group (must be one of COMMAND_GROUPS)
 * @property {string} summary     One-line description (help + docs index)
 */

/** Ordered display groups. */
export const COMMAND_GROUPS = [
  'Getting started',
  'Features & roadmap',
  'Build & implement',
  'Lifecycle, gates & review',
  'Vision, ideas & tracking',
  'App, integrations & runtime',
  'Maintenance & info',
];

/** @type {Command[]} */
export const COMMANDS = [
  // Getting started
  { name: 'init', aliases: [], group: 'Getting started', summary: 'Initialize Compose in the current project' },
  { name: 'setup', aliases: ['sync'], group: 'Getting started', summary: 'Install/sync global Compose skills' },
  { name: 'install', aliases: [], group: 'Getting started', summary: 'Legacy bootstrap — runs init + setup' },
  { name: 'import', aliases: [], group: 'Getting started', summary: 'Scan an existing project and generate a structured analysis' },
  { name: 'doctor', aliases: [], group: 'Getting started', summary: 'Check external skill dependencies' },
  { name: 'update', aliases: ['upgrade'], group: 'Getting started', summary: 'Pull latest compose, reinstall deps, refresh global skill' },

  // Features & roadmap
  { name: 'new', aliases: [], group: 'Features & roadmap', summary: 'Kickoff a product (research, brainstorm, roadmap, scaffold)' },
  { name: 'feature', aliases: [], group: 'Features & roadmap', summary: 'Add a single feature (folder, design seed, ROADMAP entry)' },
  { name: 'roadmap', aliases: [], group: 'Features & roadmap', summary: 'Show roadmap status; generate/migrate/check ROADMAP.md' },
  { name: 'triage', aliases: [], group: 'Features & roadmap', summary: 'Analyze a feature and recommend a build profile' },
  { name: 'qa-scope', aliases: [], group: 'Features & roadmap', summary: "Show affected routes from a feature's changed files" },

  // Build & implement
  { name: 'build', aliases: [], group: 'Build & implement', summary: 'Run a feature through the headless lifecycle' },
  { name: 'fix', aliases: [], group: 'Build & implement', summary: 'Run a bug through the headless bug-fix lifecycle' },
  { name: 'plan', aliases: [], group: 'Build & implement', summary: 'Plan work into a structured roadmap from a prompt' },
  { name: 'gsd', aliases: [], group: 'Build & implement', summary: 'Per-task fresh-context dispatch from a blueprint + Boundary Map' },
  { name: 'pipeline', aliases: [], group: 'Build & implement', summary: 'View and edit the build pipeline' },
  { name: 'experiment', aliases: [], group: 'Build & implement', summary: 'Run an A/B model experiment from a spec' },

  // Lifecycle, gates & review
  { name: 'gates', aliases: ['gate'], group: 'Lifecycle, gates & review', summary: 'List and resolve pending gates' },
  { name: 'loops', aliases: [], group: 'Lifecycle, gates & review', summary: 'Manage iteration loops for a feature' },
  { name: 'guard', aliases: [], group: 'Lifecycle, gates & review', summary: 'Manage the canon guard and drift detection' },
  { name: 'validate', aliases: [], group: 'Lifecycle, gates & review', summary: 'Validate feature/project artifacts against contracts' },
  { name: 'record-completion', aliases: [], group: 'Lifecycle, gates & review', summary: 'Record a completion bound to a commit SHA (flips status to COMPLETE)' },
  { name: 'lineage', aliases: [], group: 'Lifecycle, gates & review', summary: 'PROV-O artifact lineage: stamp | stale | show' },
  { name: 'context', aliases: [], group: 'Lifecycle, gates & review', summary: 'Show the build decision log' },

  // Vision, ideas & tracking
  { name: 'items', aliases: [], group: 'Vision, ideas & tracking', summary: 'List vision items from local state (no server)' },
  { name: 'ideabox', aliases: [], group: 'Vision, ideas & tracking', summary: 'Capture, review, and promote product ideas' },
  { name: 'judgment', aliases: [], group: 'Vision, ideas & tracking', summary: "Judgment records: trace a position's causal ancestry" },
  { name: 'metrics', aliases: [], group: 'Vision, ideas & tracking', summary: 'Report dispatch, settlement, and triage metrics' },
  { name: 'tracker', aliases: [], group: 'Vision, ideas & tracking', summary: 'Tracker provider status and op-log sync' },

  // App, integrations & runtime
  { name: 'start', aliases: [], group: 'App, integrations & runtime', summary: 'Start the compose app (UI + API) for this project' },
  { name: 'remote', aliases: [], group: 'App, integrations & runtime', summary: 'Manage remote access: pair, list, revoke, status' },
  { name: 'smartmemory', aliases: [], group: 'App, integrations & runtime', summary: 'Sync feature-events/journal/artifacts into SmartMemory' },

  // Maintenance & info
  { name: 'migrate-state', aliases: [], group: 'Maintenance & info', summary: 'Run pending feature.json state migrations' },
  { name: 'migrate-anon', aliases: [], group: 'Maintenance & info', summary: 'Promote anonymous ROADMAP rows to typed features (interactive)' },
  { name: 'hooks', aliases: [], group: 'Maintenance & info', summary: 'Manage Claude Code hooks (install | uninstall | status)' },
  { name: 'version', aliases: ['--version', '-V'], group: 'Maintenance & info', summary: 'Print compose version, git SHA, and install root' },
];

/** Every token (names + aliases) that should dispatch to a command. */
export function allCommandTokens() {
  return COMMANDS.flatMap((c) => [c.name, ...c.aliases]);
}

/** A command's display label: `name` plus any aliases, e.g. `setup, sync`. */
function labelOf(cmd) {
  return cmd.aliases.length ? `${cmd.name}, ${cmd.aliases.join(', ')}` : cmd.name;
}

/**
 * Render the grouped `compose --help` body from COMMANDS.
 * @returns {string}
 */
export function renderHelp() {
  const lines = ['Usage: compose <command>', ''];
  const width = Math.max(...COMMANDS.map((c) => labelOf(c).length));
  for (const group of COMMAND_GROUPS) {
    const inGroup = COMMANDS.filter((c) => c.group === group);
    if (!inGroup.length) continue;
    lines.push(`${group}:`);
    for (const cmd of inGroup) {
      lines.push(`  ${labelOf(cmd).padEnd(width)}  ${cmd.summary}`);
    }
    lines.push('');
  }
  lines.push('Run `compose <command> --help` (or see docs/cli.md) for command details.');
  return lines.join('\n');
}

/**
 * Render the docs/cli.md Command Index — a complete, grouped table generated
 * from COMMANDS. The completeness test in test/cli-commands.test.js asserts
 * every command appears in cli.md, so this table cannot silently omit one.
 * @returns {string}
 */
export function renderCommandIndex() {
  const out = [
    '## Command Index',
    '',
    '<!-- Generated from lib/cli-commands.js (COMP-AUDIT-13). Every shipped command appears here. -->',
    '',
  ];
  for (const group of COMMAND_GROUPS) {
    const inGroup = COMMANDS.filter((c) => c.group === group);
    if (!inGroup.length) continue;
    out.push(`### ${group}`, '', '| Command | Summary |', '|---|---|');
    for (const cmd of inGroup) {
      const label = cmd.aliases.length
        ? `\`compose ${cmd.name}\` (alias: ${cmd.aliases.map((a) => `\`${a}\``).join(', ')})`
        : `\`compose ${cmd.name}\``;
      // Escape pipes so a summary like "stamp | stale | show" can't break the table.
      out.push(`| ${label} | ${cmd.summary.replace(/\|/g, '\\|')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}
