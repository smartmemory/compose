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

import { existsSync, realpathSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { resolve, normalize, sep, basename, dirname, join } from 'path';

import { readEvents } from './feature-events.js';
import { checkOrInsert } from './idempotency.js';
import { loadFeaturesDir, resolveRoadmapPath } from './project-paths.js';
import { checkRoundtrip } from './roadmap-roundtrip.js';
import { isNarrativeOwned, narrativeOwnedMessage } from './roadmap-config.js';
import { knownFeatureCodes, FeatureWriteValidationError } from './feature-write-guard.js';

// providerFor is imported lazily (inside each function) to break the
// module-load-time cycle: factory.js → local-provider.js → feature-writer.js.
// Dynamic import resolves at call time, after all modules have loaded.
export async function getProvider(cwd) {
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

// COMP-ROADMAP-PLAN: `impact` carries the ideabox/plan estimate vocab onto the
// produced feature.json. Same vocab the ideabox uses (low|medium|high).
const IMPACTS = new Set(['low', 'medium', 'high']);

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
 * @param {object} [args.profile]          COMP-ROADMAP-PLAN: triage build profile
 * @param {string} [args.triageTimestamp]  COMP-ROADMAP-PLAN: triage cache stamp
 * @param {string} [args.plannedBy]        COMP-ROADMAP-PLAN: originating plan session
 * @param {string} [args.impact]           COMP-ROADMAP-PLAN: low | medium | high
 * @param {boolean} [args.force]
 * @param {string} [args.idempotency_key]
 */
export async function addRoadmapEntry(cwd, args) {
  // Narrative-owned workspaces have a hand-authored ROADMAP.md and no typed
  // tracker provider — refuse before writing any feature.json (#39).
  if (isNarrativeOwned(cwd)) {
    throw new Error(narrativeOwnedMessage(cwd));
  }
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
  // COMP-ROADMAP-PLAN: minimal type validation for the plan-handshake fields.
  if (args.profile !== undefined &&
      (typeof args.profile !== 'object' || args.profile === null || Array.isArray(args.profile))) {
    throw new Error('feature-writer: invalid profile (must be an object)');
  }
  if (args.triageTimestamp !== undefined && typeof args.triageTimestamp !== 'string') {
    throw new Error('feature-writer: invalid triageTimestamp (must be a string)');
  }
  if (args.plannedBy !== undefined && typeof args.plannedBy !== 'string') {
    throw new Error('feature-writer: invalid plannedBy (must be a string)');
  }
  if (args.impact !== undefined && !IMPACTS.has(args.impact)) {
    throw new Error(`feature-writer: invalid impact "${args.impact}"`);
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
    // COMP-ROADMAP-PLAN: plan-handshake fields (provider-backed via createFeature
    // below — one write that also regenerates ROADMAP). Triage reads
    // profile + triageTimestamp to no-op re-triage on a plan-produced feature;
    // plannedBy lets `build` ratify (not rewrite) the plan-authored design.
    if (args.profile !== undefined) feature.profile = args.profile;
    if (args.triageTimestamp !== undefined) feature.triageTimestamp = args.triageTimestamp;
    if (args.plannedBy !== undefined) feature.plannedBy = args.plannedBy;
    if (args.impact !== undefined) feature.impact = args.impact;

    let roundtrip = null;
    if (isLocalProvider(provider)) {
      roundtrip = await roundtripGuard(cwd, provider,
        (feats) => [...feats, feature],
        { force: args.force, label: 'add_roadmap_entry' });
    }

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
      roundtrip,
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

// Local-provider discriminator. LocalFileProvider.name() returns 'local';
// GitHubProvider.name() returns 'github' (see lib/tracker/*-provider.js). The
// factory returns the bare local instance for the local case and a Proxy
// wrapping GitHubProvider otherwise — name() resolves correctly through both.
// Test mock providers that don't model the local file tracker won't report
// 'local', so the guard is correctly skipped for them.
export function isLocalProvider(provider) {
  return typeof provider?.name === 'function' && provider.name() === 'local';
}

// Read ROADMAP.md as a regen base only if it's a readable regular file.
// Anything else (absent, directory, unreadable) yields '' so the guard stays a
// pure pre-check and leaves any real write-path I/O fault to renderRoadmap.
function readRoadmapBase(roadmapPath) {
  try {
    if (!existsSync(roadmapPath) || !statSync(roadmapPath).isFile()) return '';
    return readFileSync(roadmapPath, 'utf-8');
  } catch {
    return '';
  }
}

// Pre-commit roundtrip guard (LOCAL providers only — remote providers render
// server-side and are out of scope for COMP-ROADMAP-RT). Runs checkRoundtrip on
// the prospective feature set BEFORE persistence; throws (unless force) when the
// render won't stabilize, so canonical feature.json is never written ahead of a
// broken view. Returns the RoundtripResult on success.
//
// Blocks only on fixed-point divergence (a visibly churning rendered view);
// losslessness is surfaced by the validator (Task 6 / validate_project), not
// blocked here. The full RoundtripResult — including lossless + diffs — is still
// returned for callers to inspect.
async function roundtripGuard(cwd, provider, mutate, { force, label }) {
  const current = await provider.listFeatures();
  const projected = mutate(current.map(f => ({ ...f })));
  const roadmapPath = resolveRoadmapPath(cwd);
  // Read the existing ROADMAP as the regen base, but only when it's a readable
  // regular file. If the path is missing, a directory, or otherwise unreadable,
  // treat the base as empty: the guard must never mask the downstream
  // renderRoadmap partial-write error (which surfaces that I/O fault with the
  // correct ROADMAP_PARTIAL_WRITE envelope after feature.json is committed).
  const baseText = readRoadmapBase(roadmapPath);
  const rt = checkRoundtrip(baseText, projected, { now: '0000-00-00' });
  if (!rt.fixedPoint && !force) {
    const d = rt.diffs.find(x => x.kind === 'FIXED_POINT_DIVERGENCE');
    const err = new Error(
      `${label}: aborted — ROADMAP.md would not be a generation fixed point ` +
      `(${d?.detail ?? 'diverges on regen'}). No changes were written. ` +
      `Pass force: true to commit anyway.`
    );
    err.code = 'ROUNDTRIP_NOT_FIXED_POINT';
    throw err;
  }
  return rt;
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
    // `derived: true` marks a lifecycle-authoritative projection (COMP-MCP-ENFORCE
    // Slice 2, lifecycle-as-truth): the roadmap transition table is not the
    // authority for lifecycle-driven status, so the table check is skipped — but
    // the roundtrip fixed-point guard below still applies (this is NOT `force`).
    if (!allowed.includes(to) && !args.force && !args.derived) {
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

    let roundtrip = null;
    if (isLocalProvider(provider)) {
      roundtrip = await roundtripGuard(cwd, provider,
        (feats) => feats.map(f => f.code === args.code ? updated : f),
        { force: args.force, label: 'set_feature_status' });
    }

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
    if (args.derived && !allowed.includes(to)) event.derived = true;
    await safeAppendEvent(cwd, event);

    // COMP-MCP-VALIDATE-3: project the new status onto vision-state so it stays
    // in sync with the canonical feature.json instead of drifting as an orphan
    // surface. Best-effort — vision-state is a downstream mirror, so its
    // unavailability must never fail the canonical feature.json/ROADMAP write.
    // Runs only on a real transition (the from===to noop returns above);
    // pre-existing drift on an unchanged status is the migration's job.
    // VisionWriter is dual-dispatch (REST when the server is up → the in-memory
    // store stays the single writer authority; atomic file write when down).
    try {
      const { VisionWriter } = await import('./vision-writer.js');
      const { featureStatusToVisionStatus } = await import('./status-projection.js');
      const visStatus = featureStatusToVisionStatus(to);
      if (visStatus) {
        const writer = new VisionWriter(join(cwd, '.compose', 'data'));
        const item = await writer.findFeatureItem(args.code);
        if (item) await writer.updateItemStatus(item.id, visStatus);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[feature-writer] vision-state projection failed for ${args.code}: ${err.message}`);
    }

    return { code: args.code, from, to, ts: new Date().toISOString(), roundtrip };
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

    // Re-issuing an existing link without force is a no-op — it introduces no
    // new state, so it short-circuits BEFORE the dangling guard (otherwise an
    // idempotent retry of a previously-forced forward-ref would wrongly throw).
    if (matchIdx !== -1 && !args.force) {
      return { from_code: args.from_code, to_code: args.to_code, kind: args.kind, noop: true };
    }

    // COMP-MCP-VALIDATE-1: reject a dangling target for genuinely new/updated
    // links. Checked after the source-existence guard (a missing source is the
    // more fundamental error). `force` overrides for intentional forward-refs
    // (link A→B before B is scaffolded).
    const targetMissing = !knownFeatureCodes(cwd).has(args.to_code);
    if (targetMissing && !args.force) {
      throw new FeatureWriteValidationError(
        'DANGLING_LINK_FEATURES_TARGET',
        [`${args.to_code} does not exist in any source (pass force to override)`],
      );
    }

    const entry = { kind: args.kind, to_code: args.to_code };
    if (args.note) entry.note = args.note;

    if (matchIdx !== -1) links[matchIdx] = entry;
    else links.push(entry);

    // allowForwardRefs only matters when the target is missing (force path);
    // when it exists the chokepoint existence re-check passes anyway.
    await provider.putFeature(args.from_code, { ...feature, links }, { allowForwardRefs: targetMissing });

    await safeAppendEvent(cwd, {
      tool: 'link_features',
      code: args.from_code,
      to_code: args.to_code,
      kind: args.kind,
      note: args.note,
      forced: matchIdx !== -1 ? true : undefined,
      forced_dangling: (args.force && targetMissing) ? true : undefined,
      idempotency_key: args.idempotency_key,
    });

    return { from_code: args.from_code, to_code: args.to_code, kind: args.kind };
  });
}

// ---------------------------------------------------------------------------
// rewriteLinks — replace a feature's entire links[] array in one write
// ---------------------------------------------------------------------------

/**
 * Replace `feature.links` wholesale. Unlike linkFeatures (add/upsert-only), this
 * is the removal/repair primitive the reconciler (COMP-MCP-VALIDATE-2) needs:
 * dropping danglings and repairing invalid kinds in a SINGLE write so the
 * whole-array validation in putFeature can't block one fix behind another.
 * The caller computes the corrected array; this persists it through the same
 * VALIDATE-1 guard (delta-aware existence) and audit chokepoint as the other
 * link writers.
 *
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.from_code
 * @param {Array<{kind:string,to_code?:string,note?:string,provider?:string}>} args.links
 * @param {boolean} [args.allowForwardRefs] — permit a known-good forward ref target
 * @param {string} [args.idempotency_key]
 */
export async function rewriteLinks(cwd, args) {
  validateCode(args.from_code);
  if (!Array.isArray(args.links)) {
    throw new Error('feature-writer: rewriteLinks requires args.links to be an array');
  }
  return maybeIdempotent({ ...args, cwd }, async () => {
    const provider = await getProvider(cwd);
    const feature = await provider.getFeature(args.from_code);
    if (!feature) {
      throw new Error(`feature-writer: feature "${args.from_code}" not found`);
    }
    const before = Array.isArray(feature.links) ? feature.links.length : 0;
    await provider.putFeature(
      args.from_code,
      { ...feature, links: args.links },
      { allowForwardRefs: args.allowForwardRefs === true },
    );
    await safeAppendEvent(cwd, {
      tool: 'rewrite_links',
      code: args.from_code,
      before_count: before,
      after_count: args.links.length,
      idempotency_key: args.idempotency_key,
    });
    return { from_code: args.from_code, before_count: before, after_count: args.links.length };
  });
}

// ---------------------------------------------------------------------------
// setRoadmapRowStatus — surgical single-cell ROADMAP status edit
// ---------------------------------------------------------------------------

/**
 * Replace ONLY the Status cell of a feature's ROADMAP.md table row, leaving every
 * other byte of the file untouched. Used by the reconciler to heal a
 * ROADMAP-row↔feature.json status drift when feature.json is already canonical.
 *
 * A full renderRoadmap() is unsafe here: on any ROADMAP that is not already in
 * exact generated form it appends a generated section beside the hand-authored
 * one, producing duplicate conflicting rows (COMP-MCP-VALIDATE-2 finding). This
 * surgical edit mirrors the validator's column-aware row parser
 * (feature-validator.js:139-203): it locates the table by header (Feature/Status
 * columns), finds the data row whose code matches, and rewrites just the status
 * token in that cell — preserving spacing and any emphasis markers.
 *
 * ROADMAP uses the same UPPERCASE status vocabulary as feature.json, so `status`
 * is written verbatim (no projection).
 *
 * @param {string} cwd
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.status — canonical UPPERCASE status (e.g. 'IN_PROGRESS')
 * @param {string} [args.idempotency_key]
 * @returns {Promise<{code:string, changed:boolean, from?:string, to?:string}>}
 */
export async function setRoadmapRowStatus(cwd, args) {
  validateCode(args.code);
  if (!STATUSES.has(args.status)) {
    throw new Error(`feature-writer: invalid status "${args.status}"`);
  }
  return maybeIdempotent({ ...args, cwd }, async () => {
    const roadmapPath = resolveRoadmapPath(cwd);
    let text;
    try { text = readFileSync(roadmapPath, 'utf-8'); }
    catch { return { code: args.code, changed: false }; }

    const lines = text.split('\n');
    let codeIdx = -1, statusIdx = -1, inTable = false, sawSeparator = false;
    // Record the LAST matching row, not the first: the validator builds
    // roadmapByCode = new Map(rows.map(...)) so a later duplicate row wins
    // (feature-validator.js:206). Patching the first occurrence on a ROADMAP with
    // duplicate rows would leave the validator's (last) row mismatched → no
    // convergence. Mirror its last-wins semantics.
    let target = null; // { line, cellPos, from }

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (/^##\s+/.test(rawLine)) { inTable = false; sawSeparator = false; codeIdx = statusIdx = -1; continue; }
      const rowMatch = rawLine.match(/^\|(.+)\|\s*$/);
      if (!rowMatch) { inTable = false; sawSeparator = false; continue; }
      const cols = rowMatch[1].split('|').map((c) => c.trim());
      const lower = cols.map((c) => c.toLowerCase());
      const fCol = lower.findIndex((c) => ['feature', 'code', 'item', 'name'].includes(c));
      const sCol = lower.findIndex((c) => ['status', 'state'].includes(c));
      if (fCol >= 0 && sCol >= 0) { codeIdx = fCol; statusIdx = sCol; inTable = true; sawSeparator = false; continue; }
      if (cols.every((c) => /^[-:]+$/.test(c))) { if (inTable) sawSeparator = true; continue; }
      if (!inTable || !sawSeparator || codeIdx < 0 || statusIdx < 0) continue;
      if (codeIdx >= cols.length || statusIdx >= cols.length) continue;

      const codeRaw = cols[codeIdx].replace(/\*/g, '').replace(/`/g, '').trim();
      if (codeRaw !== args.code) continue;

      // Refuse rows containing an escaped pipe: `\|` splits a logical cell in two,
      // so the header-derived column index can land mid-prose. Skipping such a
      // row avoids the only realistic corruption vector (the validator mis-parses
      // it too — surfaced honestly as an unfixed mismatch rather than mangled).
      if (rawLine.includes('\\|')) continue;

      // inner-cell index → raw-line index: rawLine.split('|') = ['', ...innerCells, '']
      // so innerCells[statusIdx] === rawCells[statusIdx+1]. The validator reads the
      // same header-identified cell, so overwriting it converges — including when
      // the current value is a non-canonical alpha status (e.g. "Done").
      const rawCells = rawLine.split('|');
      const cellPos = statusIdx + 1;
      if (cellPos >= rawCells.length) continue;
      const tok = rawCells[cellPos].match(/[A-Za-z_]+/);
      // Require an alpha status token. An empty / purely-numeric cell is too
      // ambiguous to safely rewrite, so skip it (reported as changed:false).
      if (!tok) continue;
      target = { line: i, cellPos, from: tok[0] };
    }

    if (!target) return { code: args.code, changed: false };
    const fromStatus = target.from;
    if (fromStatus === args.status) return { code: args.code, changed: false, from: fromStatus, to: args.status };
    const rawCells = lines[target.line].split('|');
    rawCells[target.cellPos] = rawCells[target.cellPos].replace(/[A-Za-z_]+/, args.status);
    lines[target.line] = rawCells.join('|');

    const out = lines.join('\n');
    const tmp = `${roadmapPath}.tmp.${process.pid}`;
    try { writeFileSync(tmp, out); renameSync(tmp, roadmapPath); }
    catch (err) { try { unlinkSync(tmp); } catch { /* noop */ } throw err; }

    await safeAppendEvent(cwd, {
      tool: 'set_roadmap_row_status',
      code: args.code,
      from: fromStatus,
      to: args.status,
      idempotency_key: args.idempotency_key,
    });
    return { code: args.code, changed: true, from: fromStatus, to: args.status };
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
    if (args.push != null && typeof args.push !== 'boolean') {
      throw new Error(`feature-writer: external github push must be boolean, got "${args.push}"`);
    }
    if (args.expect_labels != null
        && (!Array.isArray(args.expect_labels)
            || !args.expect_labels.every((l) => typeof l === 'string' && l.length > 0))) {
      throw new Error('feature-writer: external github expect_labels must be an array of non-empty strings');
    }
  } else if (p === 'local') {
    if (args.expect_labels != null) {
      throw new Error('feature-writer: expect_labels is github-only (no labels on a local ref)');
    }
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
    if (args.expect_labels != null) {
      throw new Error('feature-writer: expect_labels is github-only (no labels on a url-class ref)');
    }
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
    if (args.push != null) entry.push = args.push;
    if (args.expect_labels != null) entry.expect_labels = args.expect_labels;
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
