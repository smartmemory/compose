/**
 * test/completion-write-allowlist.test.js — COMP-COMPLETION-GATE AC-19.
 *
 * Makes design §1.3 ("every path that can mint a COMPLETE feature") a PROPERTY
 * instead of a claim. A repo-wide scan of lib/, server/ and bin/ finds every
 * line that writes a COMPLETE / complete status or calls the policy-free
 * `persistFeatureRaw` primitive, and asserts each one is either the gate or an
 * entry on the allowlist below, justified in place.
 *
 * The invariant is ALLOWLIST-SHAPED, not absolute (design Decision 7):
 * `persistFeatureRaw` stays public and policy-free because it is the primitive
 * the gate writes through, so "no other module can write COMPLETE" cannot be
 * enforced in code. What CAN be enforced is that no NEW write appears without
 * someone adding it here with a reason — which is exactly the review step that
 * was missing when two independent sweeps found nine, then fourteen paths.
 *
 * Two-sided: every hit needs an entry, and every entry needs a hit (so the list
 * cannot rot into a pile of stale exemptions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['lib', 'server', 'bin'];

// A line is a completion write when it matches any of these. Comment lines are
// skipped (a description of a write is not a write).
const WRITE_PATTERNS = [
  /persistFeatureRaw\(/,
  /status:\s*['"]COMPLETE['"]/,
  /status:\s*['"]complete['"]/,
  /\.status\s*=\s*['"]complete['"]/,
  /\.status\s*=\s*['"]COMPLETE['"]/,
  /updateItemStatus\([^)]*['"]complete['"]/,
  /status:\s*entry\.status/, // migrate-roadmap's dynamic status (path 13)
  // Generic sinks that can carry a caller-supplied status (Codex r1 #7): the
  // raw feature.json writer and the PATCH pass-through into the store.
  /\bwriteFeature\(/,
  /store\.updateItem\(req\.params\.id,\s*req\.body\)/,
];

/**
 * { file, match, why } — `match` is tested against the hit LINE. One entry may
 * cover several hits in the same file (e.g. iteration-loop status writes).
 */
const ALLOWLIST = [
  // ── THE GATE (the authorized COMPLETE writer, design Decision 8) ───────────
  { file: 'lib/completion-gate.js', match: /status: 'COMPLETE'/, why: '§2.3a step 2 — the ONE authorized COMPLETE status write, after the guard applied' },
  { file: 'lib/completion-gate.js', match: /provider\.persistFeatureRaw\(featureCode, updated\)/, why: '§2.3a step 2 — the raw write the gate performs' },

  // ── the write primitive and its non-COMPLETE callers ───────────────────────
  { file: 'lib/tracker/local-provider.js', match: /async persistFeatureRaw\(/, why: 'the primitive itself (Decision 7: stays public, contract "callers must have passed the gate")' },
  { file: 'lib/tracker/provider.js', match: /async persistFeatureRaw\(_code, _obj\)/, why: 'abstract provider interface — not implemented' },
  { file: 'lib/tracker/github-provider.js', match: /async persistFeatureRaw\(/, why: 'provider interface implementation; COMPLETE parity for remote trackers is COMP-COMPLETION-GATE-REMOTE' },
  { file: 'lib/feature-writer.js', match: /provider\.persistFeatureRaw\(args\.code, updated\)/, why: 'setFeatureStatus — COMPLETE is refused above this line unconditionally (AC-9)' },
  { file: 'lib/completion-writer.js', match: /provider\.persistFeatureRaw\(feature_code, \{/, why: 'writes the completions array only, never status (§2.3a step 1; the completing path delegates to the gate)' },
  { file: 'lib/build.js', match: /persistFeatureRaw\(featureCode, \{ \.\.\._feat, status: 'PLANNED' \}\)/, why: 'build start/abort rollbacks to PLANNED — not a completion' },
  { file: 'lib/build.js', match: /persistFeatureRaw\(featureCode, \{ \.\.\._feat, status: 'IN_PROGRESS' \}\)/, why: 'build start → IN_PROGRESS — not a completion' },

  // ── vision-item completion: the seam and the non-governed callers ─────────
  { file: 'lib/vision-writer.js', match: /item\.status = 'complete'/, why: '_directCompleteItem — the §2.3b seam in direct mode, after the predicate passed' },
  { file: 'server/completion-projection.js', match: /status: 'complete'/, why: 'applyVerifiedProjection — the §2.3b seam in-process, after the predicate passed' },
  { file: 'server/vision-routes.js', match: /store\.updateItem\(req\.params\.id, \{ status: 'complete' \}\)/, why: '/lifecycle/complete for tracksFeatureJson:false modes (fix/plan) — COMP-COMPLETION-GATE-MODES' },
  { file: 'lib/build.js', match: /visionWriter\.updateItemStatus\(pendingCompletion\.itemId, 'complete'\)/, why: 'terminalization for bug/plan modes (no feature.json) — COMP-COMPLETION-GATE-MODES; the build-mode branch uses completeItem via the gate' },
  { file: 'lib/new.js', match: /updateItemStatus\(itemId, 'complete'\)/, why: 'the `compose new` kickoff item — build mode but no feature.json; documented, not changed (design §1.3)' },
  { file: 'server/feature-scan.js', match: /feature\.status = 'complete'/, why: 'scanner infers completion from report.md for unmanaged folders — becomes the document-derived tier at seed' },
  { file: 'server/feature-scan.js', match: /status: 'complete',/, why: 'seedCompletionTier — startup projection on canonical status alone, stamped canonical-status-only / document-derived (§2.3b round 5)' },
  { file: 'server/feature-scan.js', match: /updates\.status = 'complete'/, why: 'seed re-sync of a drifted item, same tiering' },

  // ── generic sinks (Codex r1 #7): the raw feature.json writer + the PATCH pass-through
  { file: 'lib/feature-json.js', match: /^export function writeFeature\(/, why: 'the raw feature.json file primitive itself (below persistFeatureRaw; Decision 7 applies one level down)' },
  { file: 'lib/feature-json.js', match: /^writeFeature\(cwd, feature, featuresDir\);/, why: 'updateFeature() — generic Object.assign sink; callers must not pass status (setFeatureStatus/gate own it)' },
  { file: 'lib/tracker/local-provider.js', match: /writeFeature\(this\.cwd, \{ \.\.\.obj, code \}, this\.featuresDir\);/, why: 'createFeature (status validated upstream by addRoadmapEntry — COMPLETE refused at creation, AC-15) and persistFeatureRaw (Decision 7)' },
  { file: 'lib/tracker/local-provider.js', match: /writeFeature\(this\.cwd, \{ \.\.\.obj, code \}, this\.featuresDir, opts\);/, why: 'putFeature — rejects any status delta by contract' },
  { file: 'lib/migrate-roadmap.js', match: /^writeFeature\(cwd, feature, featuresDir\);/, why: 'the AC-17 migration exemption write (logged above it)' },
  { file: 'lib/state-migrations.js', match: /writeFeature\(cwd, feature, featuresDir, \{ validate: false \}\);/, why: 'schema migrations (pure/total migrateFeature) — shape, not status' },
  { file: 'lib/xref-sync.js', match: /writeFeature\(cwd, fj, featuresDir\);/, why: 'xref-sync rewrites link.expect only' },
  { file: 'lib/fluid/ideabox-ops.js', match: /^writeFeature\(ctx\.cwd, \{/, why: 'idea promotion creates a PLANNED feature' },
  { file: 'bin/compose.js', match: /^writeFeature\(cwd, \{/, why: '`compose feature` scaffold creates a PLANNED feature' },
  { file: 'bin/compose.js', match: /^writeFeature\(trCwd, \{/, why: 'triage persists a PLANNED feature' },
  { file: 'server/vision-routes.js', match: /const item = store\.updateItem\(req\.params\.id, req\.body\);/, why: 'PATCH pass-through — guarded above it by the AC-10 refusal for managed build items' },

  // ── migration exemption (path 13, AC-17) ───────────────────────────────────
  { file: 'lib/migrate-roadmap.js', match: /status: entry\.status/, why: 'roadmap migrate transcribes historical COMPLETE rows; named + logged per write, both branches' },

  // ── not feature completions at all (different state machines) ─────────────
  { file: 'lib/build.js', match: /writeActiveBuild\(dataDir, \{ \.\.\.termState, status: 'complete'/, why: 'active-build.json run status, not feature status' },
  { file: 'lib/gsd-supervisor.js', match: /status: 'complete'/, why: 'GSD supervisor verdict object — a return value, not a write' },
  { file: 'lib/judgment-writer.js', match: /status: 'complete'/, why: 'judgment attestation return value' },
  { file: 'server/design-session.js', match: /session\.status = 'complete'/, why: 'design-session state, not feature status' },
  { file: 'server/vision-routes.js', match: /iter\.status = 'complete'/, why: 'iteration-loop state, not item status' },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js') || p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

function isComment(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

function scan() {
  const hits = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (isComment(line)) return;
        if (WRITE_PATTERNS.some((re) => re.test(line))) hits.push({ file: rel, line: i + 1, text: line.trim() });
      });
    }
  }
  return hits;
}

test('AC-19: every COMPLETE/complete status write is the gate or an allowlisted, justified callsite', () => {
  const hits = scan();
  assert.ok(hits.length > 0, 'the scan must find the gate at minimum');

  const unlisted = hits.filter((h) => !ALLOWLIST.some((a) => a.file === h.file && a.match.test(h.text)));
  assert.deepEqual(
    unlisted.map((h) => `${h.file}:${h.line}  ${h.text}`),
    [],
    'NEW completion write(s) with no allowlist entry. Either route through the gate or add an entry here WITH a reason.',
  );
});

test('AC-19: no stale allowlist entries — every entry still matches a live callsite', () => {
  const hits = scan();
  const stale = ALLOWLIST.filter((a) => !hits.some((h) => h.file === a.file && a.match.test(h.text)));
  assert.deepEqual(stale.map((a) => `${a.file} ${a.match}`), [], 'remove entries whose callsite is gone');
});

test('AC-19: the allowlist contains exactly one COMPLETE status write on feature.json, and it is the gate', () => {
  const hits = scan().filter((h) => /status: 'COMPLETE'/.test(h.text));
  assert.deepEqual(hits.map((h) => h.file), ['lib/completion-gate.js']);
});
