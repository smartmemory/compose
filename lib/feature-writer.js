/**
 * feature-writer.js — typed writers for ROADMAP / feature.json mutations.
 *
 * First sub-ticket of COMP-MCP-FEATURE-MGMT (COMP-MCP-ROADMAP-WRITER).
 *
 * Three operations:
 *   addRoadmapEntry(cwd, args)  — register a new feature, regenerate ROADMAP
 *   setFeatureStatus(cwd, args) — flip status with transition policy enforcement
 *   roadmapDiff(cwd, args)      — read the audit log for a window
 *
 * All writes go through feature.json (canonical) + writeRoadmap()
 * (regenerates ROADMAP.md). Mutations append to the feature-events.jsonl
 * audit log. Idempotency keys protect against retries.
 *
 * No HTTP, no transport awareness — pure data + IO so the same writers can
 * be called from MCP tools, the CLI, or future REST routes.
 */

import { existsSync, realpathSync, statSync } from 'fs';
import { resolve, normalize, sep, basename, dirname } from 'path';

import { readEvents } from './feature-events.js';
import { checkOrInsert } from './idempotency.js';
import { loadFeaturesDir } from './project-paths.js';

// providerFor is imported lazily (inside each function) to break the
// module-load-time cycle: factory.js → local-provider.js → feature-writer.js.
// Dynamic import resolves at call time, after all modules have loaded.
async function getProvider(cwd) {
  const { providerFor } = await import('./tracker/factory.js');
  return providerFor(cwd);
}

// ---------------------------------------------------------------------------
// Status / transition policy
// ---------------------------------------------------------------------------

const STATUSES = new Set([
  'PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE',
  'BLOCKED', 'KILLED', 'PARKED', 'SUPERSEDED',
]);

// COMPLETE -> SUPERSEDED is force-only (per design Decision 6); not in the
// normal transitions list. Force flag bypasses the policy and is recorded in
// audit.
const TRANSITIONS = {
  PLANNED:     ['IN_PROGRESS', 'KILLED', 'PARKED'],
  IN_PROGRESS: ['PARTIAL', 'COMPLETE', 'BLOCKED', 'KILLED', 'PARKED'],
  PARTIAL:     ['IN_PROGRESS', 'COMPLETE', 'KILLED'],
  COMPLETE:    [],
  BLOCKED:     ['IN_PROGRESS', 'KILLED', 'PARKED'],
  PARKED:      ['PLANNED', 'KILLED'],
  KILLED:      [],
  SUPERSEDED:  [],
};

const COMPLEXITIES = new Set(['S', 'M', 'L', 'XL']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { FEATURE_CODE_RE_STRICT as FEATURE_CODE_RE } from './feature-code.js';

function validateCode(code) {
  if (typeof code !== 'string' || !FEATURE_CODE_RE.test(code)) {
    throw new Error(`feature-writer: invalid feature code "${code}" — must match ${FEATURE_CODE_RE}`);
  }
}

function maybeIdempotent(args, fn) {
  if (args.idempotency_key) {
    return checkOrInsert(args.cwd, args.idempotency_key, fn).then(({ result }) => result);
  }
  return Promise.resolve().then(fn);
}

// ---------------------------------------------------------------------------
// addRoadmapEntry
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.description
 * @param {string} args.phase
 * @param {string} [args.complexity]
 * @param {string} [args.status]
 * @param {number} [args.position]
 * @param {string} [args.parent]
 * @param {string[]} [args.tags]
 * @param {string} [args.idempotency_key]
 */
export async function addRoadmapEntry(cwd, args) {
  validateCode(args.code);
  if (!args.description) throw new Error('feature-writer: description is required');
  if (!args.phase) throw new Error('feature-writer: phase is required');
  if (args.complexity && !COMPLEXITIES.has(args.complexity)) {
    throw new Error(`feature-writer: invalid complexity "${args.complexity}"`);
  }
  const status = args.status ?? 'PLANNED';
  if (!STATUSES.has(status)) {
    throw new Error(`feature-writer: invalid status "${status}"`);
  }

  return maybeIdempotent({ ...args, cwd }, async () => {
    const provider = await getProvider(cwd);

    const existing = await provider.getFeature(args.code);
    if (existing) {
      throw new Error(`feature-writer: feature "${args.code}" already exists`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const feature = {
      code: args.code,
      description: args.description,
      status,
      phase: args.phase,
      created: today,
      updated: today,
    };
    if (args.complexity) feature.complexity = args.complexity;
    feature.position = args.position !== undefined
      ? args.position
      : await nextPositionInPhase(provider, args.phase);
    if (args.parent) feature.parent = args.parent;
    if (args.tags && args.tags.length) feature.tags = args.tags;

    // Use createFeature (not putFeature) for the initial write of a brand-new
    // feature: the not-found check above has already confirmed it doesn't exist,
    // and createFeature carries the correct semantics for remote providers
    // (e.g. GitHubProvider creates a new issue rather than patching an existing one).
    await provider.createFeature(args.code, feature);
    let roadmapPath;
    try {
      roadmapPath = await provider.renderRoadmap();
    } catch (err) {
      throw partialWriteError(
        `add_roadmap_entry: feature.json for "${args.code}" was written but ROADMAP.md regeneration failed. ` +
        `Recover with \`compose roadmap generate\`.`,
        err,
      );
    }

    await safeAppendEvent(cwd, {
      tool: 'add_roadmap_entry',
      code: args.code,
      to: status,
      phase: args.phase,
      idempotency_key: args.idempotency_key,
    });

    return {
      code: args.code,
      phase: args.phase,
      position: feature.position,
      roadmap_path: roadmapPath,
    };
  });
}

// Default position for a new feature: max existing position in the same
// phase, plus 1. Falls back to 1 when the phase is empty.
async function nextPositionInPhase(provider, phase) {
  const all = await provider.listFeatures();
  const peers = all.filter(f => f.phase === phase);
  if (peers.length === 0) return 1;
  const maxPos = peers.reduce((m, f) => {
    const p = typeof f.position === 'number' ? f.position : 0;
    return p > m ? p : m;
  }, 0);
  return maxPos + 1;
}

// Wrap a mid-flight failure (feature.json committed, ROADMAP.md regen
// failed) in a typed envelope so MCP callers can distinguish committed vs
// uncommitted state. The wrapper at server/compose-mcp.js serializes
// err.cause as `Caused by [CODE]: message`, so the underlying writeRoadmap
// error stays observable across the MCP boundary.
function partialWriteError(message, cause) {
  const err = new Error(message);
  err.code = 'ROADMAP_PARTIAL_WRITE';
  if (cause) err.cause = cause;
  return err;
}

// Audit-log writes are best-effort: a failed append must NOT roll back a
// committed mutation (per design Decision 2 and docs/mcp.md). Log a warning
// and continue.
//
// Routes through provider.appendEvent so GitHubProvider can post
// <!--compose-event--> comments + mirror Projects v2. LocalFileProvider
// delegates to feature-events.js#appendEvent producing byte-identical output.
async function safeAppendEvent(cwd, event) {
  try {
    const provider = await getProvider(cwd);
    await provider.appendEvent(event.code, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[feature-writer] audit append failed for ${event.tool} ${event.code ?? ''}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// setFeatureStatus
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.status
 * @param {string} [args.reason]
 * @param {string} [args.commit_sha]
 * @param {boolean} [args.force]
 * @param {string} [args.idempotency_key]
 */
export async function setFeatureStatus(cwd, args) {
  validateCode(args.code);
  if (!STATUSES.has(args.status)) {
    throw new Error(`feature-writer: invalid status "${args.status}" — must be one of ${[...STATUSES].join(', ')}`);
  }

  return maybeIdempotent({ ...args, cwd }, async () => {
    const provider = await getProvider(cwd);

    const feature = await provider.getFeature(args.code);
    if (!feature) {
      throw new Error(`feature-writer: feature "${args.code}" not found`);
    }

    const from = feature.status;
    const to = args.status;

    if (from === to) {
      return { code: args.code, from, to, ts: new Date().toISOString(), noop: true };
    }

    const allowed = TRANSITIONS[from] ?? [];
    if (!allowed.includes(to) && !args.force) {
      throw new Error(
        `feature-writer: invalid transition for ${args.code}: ${from} → ${to}. ` +
        `Allowed from ${from}: [${allowed.join(', ') || 'none'}]. ` +
        `Pass force: true to override.`
      );
    }

    // Build the updated feature object. We use persistFeatureRaw (not putFeature)
    // because putFeature rejects status deltas by contract. Transition policy
    // enforcement has already happened above — this is the raw persistence step.
    const updated = { ...feature, status: to };
    if (args.commit_sha) updated.commit_sha = args.commit_sha;
    await provider.persistFeatureRaw(args.code, updated);
    try {
      await provider.renderRoadmap();
    } catch (err) {
      throw partialWriteError(
        `set_feature_status: feature.json for "${args.code}" was updated (${from} → ${to}) but ROADMAP.md regeneration failed. ` +
        `Recover with \`compose roadmap generate\`.`,
        err,
      );
    }

    const event = {
      tool: 'set_feature_status',
      code: args.code,
      from,
      to,
      idempotency_key: args.idempotency_key,
    };
    if (args.reason) event.reason = args.reason;
    if (args.commit_sha) event.commit_sha = args.commit_sha;
    if (args.force && !allowed.includes(to)) event.forced = true;
    await safeAppendEvent(cwd, event);

    return { code: args.code, from, to, ts: new Date().toISOString() };
  });
}

// ---------------------------------------------------------------------------
// roadmapDiff
// ---------------------------------------------------------------------------

/**
 * @param {string} cwd
 * @param {object} [args]
 * @param {string|number|Date} [args.since='24h']
 * @param {string} [args.feature_code]
 * @param {string} [args.tool]
 */
export function roadmapDiff(cwd, args = {}) {
  const since = args.since ?? '24h';
  const rawEvents = readEvents(cwd, {
    since,
    code: args.feature_code,
    tool: args.tool,
  });

  // Filter out internal reconciliation events that aren't user-driven mutations.
  // `roadmap_drift` events fire when a curated phase override diverges from
  // the auto-rollup; they're observability output, not roadmap changes.
  const events = rawEvents.filter(e => e.tool !== 'roadmap_drift');

  const added = [];
  const status_changed = [];
  for (const e of events) {
    if (e.tool === 'add_roadmap_entry' && e.code) {
      added.push(e.code);
    }
    if (e.tool === 'set_feature_status' && e.code && e.from !== e.to) {
      status_changed.push({ code: e.code, from: e.from, to: e.to });
    }
  }

  return { events, added, status_changed };
}

// ---------------------------------------------------------------------------
// Linker — COMP-MCP-ARTIFACT-LINKER
// ---------------------------------------------------------------------------

const LINK_KINDS = new Set([
  'surfaced_by', 'blocks', 'depends_on',
  'follow_up', 'supersedes', 'related',
]);

const CANONICAL_ARTIFACT_NAMES = new Set([
  'design.md', 'prd.md', 'architecture.md',
  'blueprint.md', 'plan.md', 'report.md',
]);

function validateRepoPath(cwd, path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('feature-writer: path must be a non-empty string');
  }
  if (path.startsWith('/') || path.startsWith('~')) {
    throw new Error(`feature-writer: path must be repo-relative, got "${path}"`);
  }
  const normalized = normalize(path);
  if (normalized.split(sep).includes('..')) {
    throw new Error(`feature-writer: path must not contain ".." after normalization, got "${path}"`);
  }
  const realCwd = realpathSync(cwd);
  const resolved = resolve(realCwd, normalized);
  if (!resolved.startsWith(realCwd + sep) && resolved !== realCwd) {
    throw new Error(`feature-writer: path "${path}" resolves outside cwd`);
  }
  if (!existsSync(resolved)) {
    throw new Error(`feature-writer: path "${path}" does not exist`);
  }
  // Resolve symlinks AFTER existence check and verify the real target also
  // lives under cwd. This blocks repo-internal symlinks that escape (e.g.
  // docs/features/FOO/leak -> /etc/passwd). Mirrors the symlink hardening
  // in server/artifact-manager.js.
  const realResolved = realpathSync(resolved);
  if (!realResolved.startsWith(realCwd + sep) && realResolved !== realCwd) {
    throw new Error(`feature-writer: path "${path}" symlinks outside cwd`);
  }
  if (!statSync(realResolved).isFile()) {
    throw new Error(`feature-writer: path "${path}" must point at a file (got directory or other)`);
  }
  return normalized;
}

function rejectCanonicalArtifact(featuresDir, featureCode, normalizedPath) {
  // Reject paths like <featuresDir>/<CODE>/design.md, prd.md, etc.
  const file = basename(normalizedPath);
  if (!CANONICAL_ARTIFACT_NAMES.has(file)) return;
  // The canonical files live under the feature folder. If this path points
  // inside the feature's own folder, refuse — those are auto-discovered.
  const parent = dirname(normalizedPath);
  if (parent.endsWith(`${featuresDir}/${featureCode}`)) {
    throw new Error(
      `feature-writer: "${file}" inside the feature folder is a canonical artifact; ` +
      `it is auto-discovered by assess_feature_artifacts and should not be linked explicitly.`
    );
  }
}

/**
 * Register a non-canonical artifact (snapshot, journal, finding, etc.) on a
 * feature. Canonical artifacts (design.md, plan.md, ...) are auto-discovered
 * by ArtifactManager and rejected here.
 *
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.feature_code
 * @param {string} args.artifact_type
 * @param {string} args.path - repo-relative
 * @param {string} [args.status]
 * @param {boolean} [args.force]
 * @param {string} [args.idempotency_key]
 */
export async function linkArtifact(cwd, args) {
  validateCode(args.feature_code);
  if (!args.artifact_type || typeof args.artifact_type !== 'string') {
    throw new Error('feature-writer: artifact_type is required (non-empty string)');
  }
  const normalizedPath = validateRepoPath(cwd, args.path);
  const featuresDir = loadFeaturesDir(cwd);
  rejectCanonicalArtifact(featuresDir, args.feature_code, normalizedPath);

  return maybeIdempotent({ ...args, cwd }, async () => {
    const provider = await getProvider(cwd);

    const feature = await provider.getFeature(args.feature_code);
    if (!feature) {
      throw new Error(`feature-writer: feature "${args.feature_code}" not found`);
    }

    const artifacts = Array.isArray(feature.artifacts) ? [...feature.artifacts] : [];
    const matchIdx = artifacts.findIndex(
      a => a.type === args.artifact_type && a.path === normalizedPath
    );

    if (matchIdx !== -1 && !args.force) {
      return {
        feature_code: args.feature_code,
        artifact_type: args.artifact_type,
        path: normalizedPath,
        noop: true,
      };
    }

    const entry = { type: args.artifact_type, path: normalizedPath };
    if (args.status) entry.status = args.status;

    if (matchIdx !== -1) artifacts[matchIdx] = entry;
    else artifacts.push(entry);

    await provider.putFeature(args.feature_code, { ...feature, artifacts });

    await safeAppendEvent(cwd, {
      tool: 'link_artifact',
      code: args.feature_code,
      artifact_type: args.artifact_type,
      path: normalizedPath,
      forced: matchIdx !== -1 ? true : undefined,
      idempotency_key: args.idempotency_key,
    });

    return {
      feature_code: args.feature_code,
      artifact_type: args.artifact_type,
      path: normalizedPath,
    };
  });
}

/**
 * Register a typed cross-feature link.
 *
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.from_code
 * @param {string} args.to_code
 * @param {string} args.kind - one of LINK_KINDS
 * @param {string} [args.note]
 * @param {boolean} [args.force]
 * @param {string} [args.idempotency_key]
 */
export async function linkFeatures(cwd, args) {
  validateCode(args.from_code);

  // COMP-MCP-XREF-SCHEMA #15: external cross-project references. These do NOT
  // resolve through same-project `to_code` semantics, so the validateCode /
  // self-link / LINK_KINDS guards below are skipped for kind:"external".
  if (args.kind === 'external') {
    return linkFeatureExternal(cwd, args);
  }

  validateCode(args.to_code);
  if (args.from_code === args.to_code) {
    throw new Error(`feature-writer: cannot link a feature to itself ("${args.from_code}")`);
  }
  if (!LINK_KINDS.has(args.kind)) {
    throw new Error(
      `feature-writer: invalid link kind "${args.kind}". ` +
      `Allowed: ${[...LINK_KINDS].join(', ')}`
    );
  }

  return maybeIdempotent({ ...args, cwd }, async () => {
    const provider = await getProvider(cwd);

    const feature = await provider.getFeature(args.from_code);
    if (!feature) {
      throw new Error(`feature-writer: feature "${args.from_code}" not found`);
    }

    const links = Array.isArray(feature.links) ? [...feature.links] : [];
    const matchIdx = links.findIndex(
      l => l.kind === args.kind && l.to_code === args.to_code
    );

    if (matchIdx !== -1 && !args.force) {
      return { from_code: args.from_code, to_code: args.to_code, kind: args.kind, noop: true };
    }

    const entry = { kind: args.kind, to_code: args.to_code };
    if (args.note) entry.note = args.note;

    if (matchIdx !== -1) links[matchIdx] = entry;
    else links.push(entry);

    await provider.putFeature(args.from_code, { ...feature, links });

    await safeAppendEvent(cwd, {
      tool: 'link_features',
      code: args.from_code,
      to_code: args.to_code,
      kind: args.kind,
      note: args.note,
      forced: matchIdx !== -1 ? true : undefined,
      idempotency_key: args.idempotency_key,
    });

    return { from_code: args.from_code, to_code: args.to_code, kind: args.kind };
  });
}

const XREF_PROVIDERS = new Set(['github', 'local', 'url', 'jira', 'linear', 'notion', 'obsidian']);
const XREF_URL_CLASS = new Set(['url', 'jira', 'linear', 'notion', 'obsidian']);
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//;
// Carrier equivalence: the feature.json-link carrier must reject exactly what
// the inline citation grammar (lib/xref-citation.js) rejects at parse time, so
// a stored link can never carry a value #16's resolver would mishandle.
const XREF_GITHUB_EXPECT = new Set(['open', 'closed']);
const XREF_LOCAL_EXPECT = new Set([
  'PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE',
  'SUPERSEDED', 'PARKED', 'BLOCKED', 'KILLED',
]);
// No `#` in either half — the citation grammar uses `#` to delimit the issue
// (gh_target = owner/name#issue), so a repo token containing `#` is not
// representable in the inline carrier. Keep both carriers equivalent.
const XREF_GH_REPO_RE = /^[^\s/#]+\/[^\s/#]+$/;
const XREF_LOCAL_REPO_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate the external link variant in-code (the schema enforces the same
 * shape on disk; this gives a clear error at the call site). Mirrors
 * contracts/feature-json.schema.json links external branch.
 */
function validateExternalArgs(args) {
  const p = args.provider;
  if (!p || !XREF_PROVIDERS.has(p)) {
    throw new Error(
      `feature-writer: external link requires provider ∈ {${[...XREF_PROVIDERS].join(', ')}}, got "${p}"`,
    );
  }
  if (p === 'github') {
    if (!args.repo || !Number.isInteger(args.issue) || args.issue < 1) {
      throw new Error('feature-writer: external github link requires repo + integer issue ≥ 1');
    }
    if (!XREF_GH_REPO_RE.test(args.repo)) {
      throw new Error(`feature-writer: external github repo "${args.repo}" must be "owner/name"`);
    }
    if (args.expect != null && !XREF_GITHUB_EXPECT.has(args.expect)) {
      throw new Error(`feature-writer: external github expect must be open|closed, got "${args.expect}"`);
    }
  } else if (p === 'local') {
    if (!args.repo || !args.to_code) {
      throw new Error('feature-writer: external local link requires repo + to_code');
    }
    if (!XREF_LOCAL_REPO_RE.test(args.repo) || args.repo === '.' || args.repo === '..') {
      throw new Error(
        `feature-writer: external local repo "${args.repo}" must be a single sibling directory name `
        + '([A-Za-z0-9._-], no path separators or "."/"..")',
      );
    }
    if (!FEATURE_CODE_RE.test(args.to_code)) {
      throw new Error(
        `feature-writer: external local to_code "${args.to_code}" must match ${FEATURE_CODE_RE}`,
      );
    }
    if (args.expect != null && !XREF_LOCAL_EXPECT.has(args.expect)) {
      throw new Error(
        `feature-writer: external local expect must be one of ${[...XREF_LOCAL_EXPECT].join('|')}, got "${args.expect}"`,
      );
    }
  } else if (XREF_URL_CLASS.has(p)) {
    if (!args.url) {
      throw new Error(`feature-writer: external ${p} link (url-class) requires url`);
    }
    if (!URI_SCHEME_RE.test(args.url)) {
      throw new Error(`feature-writer: url must be a valid URI (got: ${args.url})`);
    }
    // url-class: `expect` is recorded but never resolved (parity with the
    // citation grammar, which also accepts but ignores it) — no validation.
  }
}

/**
 * Store a kind:"external" cross-project reference on the source feature.
 * Idempotency key is (kind=external, provider, repo, issue|to_code|url) so a
 * re-link of the same external pointer is a noop. Read-only with respect to
 * the cited repo/issue — this only writes the citing feature.json.
 */
async function linkFeatureExternal(cwd, args) {
  validateExternalArgs(args);

  return maybeIdempotent({ ...args, cwd }, async () => {
    const provider = await getProvider(cwd);
    const feature = await provider.getFeature(args.from_code);
    if (!feature) {
      throw new Error(`feature-writer: feature "${args.from_code}" not found`);
    }

    const links = Array.isArray(feature.links) ? [...feature.links] : [];
    const targetKey = args.provider === 'github'
      ? String(args.issue)
      : args.provider === 'local'
        ? args.to_code
        : args.url;
    const matchIdx = links.findIndex(
      l => l.kind === 'external'
        && l.provider === args.provider
        && (l.repo ?? null) === (args.repo ?? null)
        && (
          l.provider === 'github' ? String(l.issue) === targetKey
            : l.provider === 'local' ? l.to_code === targetKey
              : l.url === targetKey
        ),
    );

    if (matchIdx !== -1 && !args.force) {
      return {
        from_code: args.from_code, kind: 'external',
        provider: args.provider, noop: true,
      };
    }

    const entry = { kind: 'external', provider: args.provider };
    if (args.repo != null) entry.repo = args.repo;
    if (args.issue != null) entry.issue = args.issue;
    if (args.to_code != null) entry.to_code = args.to_code;
    if (args.url != null) entry.url = args.url;
    if (args.expect != null) entry.expect = args.expect;
    if (args.note) entry.note = args.note;

    if (matchIdx !== -1) links[matchIdx] = entry;
    else links.push(entry);

    await provider.putFeature(args.from_code, { ...feature, links });

    await safeAppendEvent(cwd, {
      tool: 'link_features',
      code: args.from_code,
      kind: 'external',
      provider: args.provider,
      note: args.note,
      forced: matchIdx !== -1 ? true : undefined,
      idempotency_key: args.idempotency_key,
    });

    return { from_code: args.from_code, kind: 'external', provider: args.provider };
  });
}

/**
 * Read both canonical and linked artifacts for a feature in one call.
 *
 * Canonical artifacts (design.md/prd.md/architecture.md/blueprint.md/
 * plan.md/report.md inside the feature folder) come from ArtifactManager
 * via a dynamic import (kept out of the static import graph because lib/
 * is consumed by stdio MCP code paths and we don't want to pay
 * server/-side load costs unless the caller asks).
 *
 * Linked artifacts come from feature.json's artifacts[]; each is stamped
 * with a current existence check.
 *
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.feature_code
 */
export async function getFeatureArtifacts(cwd, args) {
  validateCode(args.feature_code);
  const provider = await getProvider(cwd);
  const feature = await provider.getFeature(args.feature_code);
  if (!feature) {
    throw new Error(`feature-writer: feature "${args.feature_code}" not found`);
  }

  const realCwd = realpathSync(cwd);
  const linked = (feature.artifacts ?? []).map(a => ({
    type: a.type,
    path: a.path,
    status: a.status,
    exists: existsSync(resolve(realCwd, a.path)),
  }));

  let canonical = null;
  try {
    const { ArtifactManager } = await import('../server/artifact-manager.js');
    const featuresDir = loadFeaturesDir(cwd);
    const featureRoot = resolve(realCwd, featuresDir);
    if (existsSync(featureRoot)) {
      const manager = new ArtifactManager(featureRoot);
      canonical = manager.assess(args.feature_code);
    }
  } catch (err) {
    // Don't fail the whole read if ArtifactManager isn't available — surface
    // the issue via canonical: null and a one-line note.
    canonical = { error: err.message };
  }

  return { feature_code: args.feature_code, canonical, linked };
}

/**
 * Read outgoing and/or incoming links for a feature. Outgoing reads from
 * the source feature's links[]; incoming iterates listFeatures and finds
 * entries that target the requested code.
 *
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.feature_code
 * @param {'outgoing'|'incoming'|'both'} [args.direction='both']
 * @param {string} [args.kind]
 */
export async function getFeatureLinks(cwd, args) {
  validateCode(args.feature_code);
  const direction = args.direction ?? 'both';
  if (!['outgoing', 'incoming', 'both'].includes(direction)) {
    throw new Error(
      `feature-writer: invalid direction "${direction}". Allowed: outgoing, incoming, both.`
    );
  }
  const kind = args.kind;

  const provider = await getProvider(cwd);
  const out = { feature_code: args.feature_code };

  if (direction === 'outgoing' || direction === 'both') {
    const feature = await provider.getFeature(args.feature_code);
    if (!feature) {
      throw new Error(`feature-writer: feature "${args.feature_code}" not found`);
    }
    out.outgoing = (feature.links ?? [])
      .filter(l => !kind || l.kind === kind)
      .map((l) => (l.kind === 'external'
        ? {
            kind: l.kind,
            provider: l.provider,
            repo: l.repo,
            issue: l.issue,
            url: l.url,
            to_code: l.to_code,
            expect: l.expect,
            note: l.note,
          }
        : { kind: l.kind, to_code: l.to_code, note: l.note }));
  }

  if (direction === 'incoming' || direction === 'both') {
    const all = await provider.listFeatures();
    const incoming = [];
    for (const f of all) {
      if (f.code === args.feature_code) continue;
      for (const l of (f.links ?? [])) {
        if (l.to_code !== args.feature_code) continue;
        if (kind && l.kind !== kind) continue;
        incoming.push({ kind: l.kind, from_code: f.code, note: l.note });
      }
    }
    out.incoming = incoming;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Exports for tests / introspection
// ---------------------------------------------------------------------------

export const _internals = { TRANSITIONS, STATUSES, COMPLEXITIES, LINK_KINDS };
