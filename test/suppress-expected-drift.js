// Shared test preload: silence the ONE expected stderr line that many tests trip
// on purpose. Loaded by both suites — the node --test runner (via `--import` in
// the package.json `test` script) and the vitest tracker config (via setupFiles).
//
// Numerous tests create a phase whose heading override (e.g. PLANNED) is then made
// to diverge from the row rollup (IN_PROGRESS) to exercise the writer's override
// PRESERVATION. That makes lib/roadmap-drift.js `emitDrift` write its expected
//   WARN: phase "P1" override "PLANNED" diverges from rollup "IN_PROGRESS". ...
// to stderr (~100x across the suite). Drift DETECTION is covered directly by
// test/roadmap-drift.test.js and test/drift-emit.test.js, which replace
// process.stderr.write themselves to capture-and-assert — so this base-layer
// filter never hides their signal. Drop only that exact line; forward everything
// else untouched so real errors still surface.

const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) =>
  (typeof chunk === 'string' && chunk.includes('diverges from rollup'))
    ? true
    : _origStderrWrite(chunk, ...rest);
