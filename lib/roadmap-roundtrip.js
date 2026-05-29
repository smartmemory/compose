/**
 * roadmap-roundtrip.js — prove ROADMAP.md is a deterministic fixed point of
 * feature.json. Pure: no filesystem, no event/stderr side effects.
 *
 * COMP-ROADMAP-RT.
 */

import { generateRoadmapFromBase } from './roadmap-gen.js';
import { parseRoadmap } from './roadmap-parser.js';
import { isFeatureCode } from './feature-code.js';

export const MAX_REGEN_PASSES = 3;

/**
 * @typedef {{ kind: string, phaseId?: string, code?: string, detail?: string }} Diff
 * @typedef {{ fixedPoint: boolean, lossless: boolean, canonical: string, passes: number, diffs: Diff[] }} RoundtripResult
 */

/**
 * @param {string} baseText  Existing ROADMAP.md content ('' for a fresh file)
 * @param {Array}  features  feature.json feature objects
 * @param {object} [opts]    { now, maxPasses, projectName, projectDescription }
 * @returns {RoundtripResult}
 */
export function checkRoundtrip(baseText, features, opts = {}) {
  const maxPasses = opts.maxPasses ?? MAX_REGEN_PASSES;
  // Pure: never pass cwd (so no drift I/O); suppressDrift belt-and-suspenders.
  const genOpts = { ...opts, cwd: undefined, suppressDrift: true };
  const diffs = [];

  // --- Fixed point: iterate gen until output stabilizes. ---
  // Each pass regenerates from the previous output; convergence = next === canonical.
  // On non-convergence within maxPasses, emit exactly one FIXED_POINT_DIVERGENCE
  // diff comparing the last two distinct passes. canonical is always the last pass.
  let canonical = generateRoadmapFromBase(baseText, features, genOpts);
  let passes = 1;
  let fixedPoint = false;
  while (passes < maxPasses) {
    const next = generateRoadmapFromBase(canonical, features, genOpts);
    passes++;
    if (next === canonical) { fixedPoint = true; break; }
    const prev = canonical;
    canonical = next;
    if (passes === maxPasses) {
      diffs.push({ kind: 'FIXED_POINT_DIVERGENCE', detail: firstDiffLine(prev, canonical) });
    }
  }

  // --- Losslessness: parse canonical, aggregate by code, exclude anon. ---
  const parsed = parseRoadmap(canonical);
  const byCode = new Map();
  for (const e of parsed) {
    if (e.code.startsWith('_anon_') || !isFeatureCode(e.code)) continue;
    const arr = byCode.get(e.code) ?? [];
    arr.push(e);
    byCode.set(e.code, arr);
  }

  const featureCodes = new Set();
  for (const f of features) {
    featureCodes.add(f.code);
    const group = byCode.get(f.code);
    if (!group || group.length === 0) {
      diffs.push({ kind: 'LOSSLESS_MISSING', code: f.code, phaseId: f.phase });
      continue;
    }
    const hasItems = Array.isArray(f.items) && f.items.length > 0;
    if (hasItems) {
      const want = f.items.map(i => up(i.status ?? f.status)).sort();
      const got = group.map(e => up(e.status)).sort();
      if (want.length !== got.length || want.some((s, i) => s !== got[i])) {
        diffs.push({ kind: 'LOSSLESS_CHANGED', code: f.code, phaseId: f.phase,
          detail: `items: want [${want}] got [${got}]` });
      }
    } else {
      const e = group[0];
      if (up(e.status) !== up(f.status)) {
        diffs.push({ kind: 'LOSSLESS_CHANGED', code: f.code, phaseId: f.phase,
          detail: `status: want ${up(f.status)} got ${up(e.status)}` });
      }
      if (f.phase && e.phaseId && e.phaseId !== f.phase) {
        diffs.push({ kind: 'LOSSLESS_CHANGED', code: f.code, phaseId: f.phase,
          detail: `phase: want ${f.phase} got ${e.phaseId}` });
      }
    }
  }
  for (const code of byCode.keys()) {
    if (!featureCodes.has(code)) diffs.push({ kind: 'LOSSLESS_EXTRA', code });
  }

  const lossless = !diffs.some(d => d.kind.startsWith('LOSSLESS_'));
  return { fixedPoint, lossless, canonical, passes, diffs };
}

function up(s) { return String(s ?? '').toUpperCase().trim(); }

/** First differing line between two texts, for FIXED_POINT_DIVERGENCE.detail. */
function firstDiffLine(a, b) {
  const al = a.split('\n'), bl = b.split('\n');
  const n = Math.max(al.length, bl.length);
  for (let i = 0; i < n; i++) {
    // The ?? '' padding means any length difference surfaces as a line mismatch,
    // so the loop always returns when a !== b (the only caller's precondition).
    if (al[i] !== bl[i]) return `line ${i + 1}: "${al[i] ?? ''}" → "${bl[i] ?? ''}"`;
  }
  return '';
}
