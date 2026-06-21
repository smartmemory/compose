// lib/lifecycle-modes.js
//
// COMP-ROADMAP-MODES — the mode-keyed lifecycle registry (keystone).
//
// Compose's lifecycle data (phase graph, skippable/terminal sets, the
// completion edge, per-phase artifacts, edge evidence, phase ordering, and the
// runner's per-mode behavioral switches) was hard-coded to the BUILD graph and
// scattered across server/lifecycle-guard.js, server/artifact-manager.js, and
// lib/build.js. This module lifts that data into a single source of truth keyed
// by lifecycle mode (`build | fix | plan`), so a third lifecycle (`plan`) is a
// data add, not a code fork, and so integration ports can later be pluggable.
//
// INVARIANT: the `build` entry reproduces the legacy hard-coded data VERBATIM —
// `build` behavior must stay byte-identical. test/lifecycle-modes.test.js pins
// the build entry against the legacy exports.
//
// Pure data + accessors. No imports from server/ (lib is the lower layer; the
// runner and server consume THIS, never the reverse). Loaders/functions stay in
// their owning modules, keyed here by a string the consumer interprets.
//
// See docs/features/COMP-ROADMAP-MODES/{design,blueprint,plan}.md.

/**
 * @typedef {Object} ModeRunnerConfig
 * @property {'features'|'docs/bugs'|'docs/plans'} artifactRoot  token the runner maps to a dir
 * @property {boolean} runsTriage         whether the runner runs feature triage
 * @property {boolean} tracksFeatureJson  whether the runner writes feature.json lifecycle status
 * @property {'feature'|'bug'|'plan'} descriptionLoader  which description loader the runner uses
 * @property {'feature'|'bug'|'plan'} planInputs          which Stratum plan-input shape to build
 * @property {string} defaultTemplate     default Stratum template name for the mode
 */

/** The mode registry. Keys are canonical modes; `build` data is verbatim-legacy. */
export const LIFECYCLE_MODES = {
  // -------------------------------------------------------------------------
  // BUILD — verbatim from server/lifecycle-guard.js (BASE_TRANSITIONS/SKIPPABLE/
  // TERMINAL) + server/artifact-manager.js (PHASE_ARTIFACTS) + the runner's
  // current feature behavior. MUST stay byte-identical.
  // -------------------------------------------------------------------------
  build: {
    transitions: {
      explore_design: ['prd', 'architecture', 'blueprint'],
      prd: ['architecture', 'blueprint'],
      architecture: ['blueprint'],
      blueprint: ['verification'],
      verification: ['plan', 'blueprint'],
      plan: ['execute'],
      execute: ['report', 'docs'],
      report: ['docs'],
      docs: ['ship'],
      ship: [],
    },
    skippable: ['prd', 'architecture', 'report'],
    terminal: ['complete', 'killed'],
    genesis: 'explore_design',
    completablePhase: 'ship', // the phase that → complete (was hard-coded by name)
    phaseArtifacts: ['design.md', 'prd.md', 'architecture.md', 'blueprint.md', 'plan.md', 'report.md'],
    edgeEvidence: {
      'explore_design->blueprint': 'design.md',
      'blueprint->verification': 'blueprint.md',
      'plan->execute': 'plan.md',
    },
    phaseOrder: ['explore_design', 'prd', 'architecture', 'blueprint', 'verification', 'plan', 'execute', 'report', 'docs', 'ship'],
    runner: {
      artifactRoot: 'features',
      runsTriage: true,
      tracksFeatureJson: true,
      descriptionLoader: 'feature',
      planInputs: 'feature',
      defaultTemplate: 'build',
    },
  },

  // -------------------------------------------------------------------------
  // FIX — describes today's bug-fix lifecycle. Data parity only: the bug flow
  // registers NO guard today and MODES does not change that, so the graph here
  // is informational (exercised by registry tests, not wired into a live guard).
  // The `runner` block IS load-bearing: it reproduces today's bug runner
  // behavior byte-identically (docs/bugs root, no triage, no feature.json).
  // phaseArtifacts is [] → assess() falls back to the global default set, which
  // is exactly how bug items are assessed today (no change).
  // -------------------------------------------------------------------------
  fix: {
    transitions: {
      reproduce: ['diagnose'],
      diagnose: ['scope_check', 'fix'],
      scope_check: ['fix'],
      fix: ['test'],
      test: ['verify', 'fix'],
      verify: ['retro_check', 'ship'],
      retro_check: ['ship'],
      ship: [],
    },
    skippable: [],
    terminal: ['complete', 'killed'],
    genesis: 'reproduce',
    completablePhase: 'ship',
    phaseArtifacts: [], // empty → assess uses the global default (preserves today's bug behavior)
    edgeEvidence: {},
    phaseOrder: ['reproduce', 'diagnose', 'scope_check', 'fix', 'test', 'verify', 'retro_check', 'ship'],
    runner: {
      artifactRoot: 'docs/bugs',
      runsTriage: false,
      tracksFeatureJson: false,
      descriptionLoader: 'bug',
      planInputs: 'bug',
      defaultTemplate: 'bug-fix',
    },
  },

  // -------------------------------------------------------------------------
  // PLAN — minimal SEED graph. COMP-ROADMAP-PLAN owns the real plan lifecycle
  // (framing → research → ideation → convergence → build-handshake) and the
  // `compose plan` command. MODES ships only the mechanism: a coherent seed so
  // a third mode is proven to be a data add. Not run by any CLI command yet.
  // -------------------------------------------------------------------------
  plan: {
    transitions: {
      explore_design: ['plan'],
      plan: ['ship'],
      ship: [],
    },
    skippable: [],
    terminal: ['complete', 'killed'],
    genesis: 'explore_design',
    completablePhase: 'ship',
    phaseArtifacts: ['design.md', 'plan.md'],
    edgeEvidence: { 'explore_design->plan': 'design.md' },
    phaseOrder: ['explore_design', 'plan', 'ship'],
    runner: {
      artifactRoot: 'docs/plans',
      runsTriage: false,
      tracksFeatureJson: false,
      descriptionLoader: 'plan',
      planInputs: 'plan',
      defaultTemplate: 'new',
    },
  },
};

/** Map any runtime or canonical mode token to a canonical registry key. */
export function resolveMode(raw) {
  switch (raw) {
    case 'bug':
    case 'fix':
      return 'fix';
    case 'plan':
      return 'plan';
    case 'feature':
    case 'build':
    default:
      return 'build'; // undefined / null / unknown → build (legacy default)
  }
}

/** Get the mode entry, normalizing the input. Unknown → build. */
export function getMode(mode) {
  return LIFECYCLE_MODES[resolveMode(mode)];
}

export function genesisOf(mode) {
  return getMode(mode).genesis;
}

export function completablePhaseOf(mode) {
  return getMode(mode).completablePhase;
}

export function transitionsOf(mode) {
  return getMode(mode).transitions;
}

export function skippableOf(mode) {
  return getMode(mode).skippable;
}

export function terminalOf(mode) {
  return getMode(mode).terminal;
}

export function phaseOrderOf(mode) {
  return getMode(mode).phaseOrder;
}

/** Per-edge ("from->to" → artifact filename) evidence map for the mode. */
export function edgeEvidenceOf(mode) {
  return getMode(mode).edgeEvidence;
}

/**
 * The artifact filenames a mode declares. An EMPTY list means "no narrowing" —
 * the artifact manager falls back to the global ARTIFACT_SCHEMAS key set (which
 * is exactly today's behavior for build and bug items). A non-empty list scopes
 * assessment to that subset.
 */
export function artifactsOf(mode) {
  return getMode(mode).phaseArtifacts;
}
