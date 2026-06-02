/**
 * COMP-RESUME S3 — environment fingerprinting + drift classification.
 *
 * captureFingerprint() produces an EnvFingerprint (contracts/checkpoint.schema.json
 * $defs/EnvFingerprint): a deterministic snapshot of the environment that
 * records what exists and never interprets it (no pass/fail verdicts).
 *
 * classify() is a pure function comparing two fingerprints to decide whether
 * the environment is unchanged ('clean'), moved forward cleanly ('advanced'),
 * or drifted in a way that needs reconciliation ('diverged').
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { head, branch, porcelain, dirtyHash } from './git.js';

// Phase artifacts whose presence is part of the build signature. Order is the
// canonical phase order: design → blueprint → plan.
const PHASE_ARTIFACT_FILES = {
  design: 'design.md',
  blueprint: 'blueprint.md',
  plan: 'plan.md',
};

/**
 * Resolve a phase artifact to its absolute path if it exists under featureDir,
 * else null.
 */
function artifactPath(featureDir, fileName) {
  if (!featureDir) return null;
  const p = join(featureDir, fileName);
  return existsSync(p) ? p : null;
}

/**
 * Read the `_seq` of the last VALID JSON line of <composeDir>/build-stream.jsonl.
 * NOTE: the build stream is written to `.compose/build-stream.jsonl` (composeDir),
 * NOT `.compose/data/` — see lib/build-stream-writer.js:28 (`join(composeDir, ...)`).
 *
 * Crash tolerance (Codex impl review #2): a crash can leave a torn final line, so
 * we scan BACKWARD from the end and return the _seq of the first line that parses
 * with a numeric _seq — rather than giving up if only the very last line is
 * corrupt. Returns null when the file is absent, empty, or has no parseable _seq.
 */
function lastBuildStreamSeq(composeDir) {
  if (!composeDir) return null;
  const file = join(composeDir, 'build-stream.jsonl');
  if (!existsSync(file)) return null;
  let content;
  try {
    content = readFileSync(file, 'utf-8').trimEnd();
  } catch {
    return null;
  }
  if (!content) return null;
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj._seq === 'number') return obj._seq;
      // a valid line without a numeric _seq → keep scanning backward
    } catch {
      // torn / malformed line (e.g. interrupted final write) → keep scanning
    }
  }
  return null;
}

/**
 * Capture a deterministic snapshot of the environment.
 *
 * @param {string} cwd  Repo / working directory to fingerprint.
 * @param {object} [opts]
 * @param {string} [opts.featureDir]  Dir holding phase artifacts (design/blueprint/plan).
 * @param {string|null} [opts.flowId]  Stratum flow id, passed through.
 * @param {string|null} [opts.composeDir]  `.compose` dir for build-stream lookup. Defaults to dirname(dataDir).
 * @param {string|null} [opts.dataDir]  `.compose/data` dir; used only to derive composeDir when composeDir is absent.
 * @returns {object} EnvFingerprint
 */
export function captureFingerprint(cwd, { featureDir, flowId = null, composeDir = null, dataDir = null } = {}) {
  const streamDir = composeDir ?? (dataDir ? dirname(dataDir) : null);
  const status = porcelain(cwd); // '' clean, null no-repo, non-empty dirty
  return {
    capturedAt: new Date().toISOString(),
    git: {
      head: head(cwd),
      branch: branch(cwd),
      dirty: typeof status === 'string' && status.length > 0,
      dirtyHash: dirtyHash(cwd),
    },
    phaseArtifacts: {
      design: artifactPath(featureDir, PHASE_ARTIFACT_FILES.design),
      blueprint: artifactPath(featureDir, PHASE_ARTIFACT_FILES.blueprint),
      plan: artifactPath(featureDir, PHASE_ARTIFACT_FILES.plan),
      implementFiles: [],
      contracts: [],
    },
    testRef: null,
    buildStreamSeq: lastBuildStreamSeq(streamDir),
    flowId,
  };
}

/**
 * Names of phase artifacts that are present (non-null) in a fingerprint's
 * phaseArtifacts. Used to detect artifact removal between captures.
 */
function presentArtifacts(fp) {
  const pa = fp.phaseArtifacts ?? {};
  return Object.keys(PHASE_ARTIFACT_FILES).filter((k) => pa[k] != null);
}

/**
 * Pure drift classifier.
 *
 * @param {object|null} prev  Prior fingerprint (null if none).
 * @param {object} curr  Live fingerprint.
 * @returns {'clean'|'advanced'|'diverged'}
 *
 * Rules:
 *  - !prev → 'clean' (nothing to drift from).
 *  - same head AND same dirtyHash → 'clean'.
 *  - else if clean tree AND head moved AND no prior artifact was removed → 'advanced'.
 *  - else → 'diverged'.
 */
export function classify(prev, curr) {
  if (!prev) return 'clean';

  const p = prev.git ?? {};
  const c = curr.git ?? {};

  if (p.head === c.head && p.dirtyHash === c.dirtyHash) return 'clean';

  if (c.dirty === false && c.head !== p.head) {
    // Every artifact that existed in prev must still exist in curr.
    const prevPresent = presentArtifacts(prev);
    const currPresent = new Set(presentArtifacts(curr));
    const allRetained = prevPresent.every((name) => currPresent.has(name));
    if (allRetained) return 'advanced';
  }

  return 'diverged';
}
