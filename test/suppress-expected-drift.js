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

// COMP-TEST-PORT-ISOLATION: pin the whole test run to a guaranteed-dead port so
// "server is DOWN" probes deterministically get ECONNREFUSED regardless of whether
// the dev server is holding :4001.  VisionWriter._serverAvailable() → false →
// falls back to direct file writes into the test's temp dir.  Tests that need a
// LIVE server (compose-mcp-tools-http.test.js) override COMPOSE_PORT themselves
// to their own listen(0) ephemeral port, so they are unaffected.  The same dead
// port (19997) is already used by the COMP-MODEL-AB sandbox harness, making it
// the de-facto convention for "no compose server here".
if (!process.env.COMPOSE_PORT) process.env.COMPOSE_PORT = '19997';

const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) =>
  (typeof chunk === 'string' && chunk.includes('diverges from rollup'))
    ? true
    : _origStderrWrite(chunk, ...rest);
