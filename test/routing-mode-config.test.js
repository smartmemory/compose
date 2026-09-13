/**
 * COMP-MODEL-ROUTE — where the routing mode comes from.
 *
 * Shadow observation writes the corpus that S2's hindsight report and Q3's repair-floor
 * ruling both depend on. Before this, the ONLY shipped config setting `_routing` was
 * presets/team-fable-astra.profiles.json and there was no CLI flag, so an ordinary
 * `compose build` recorded nothing and `.compose/routing/ledger.jsonl` was never written
 * outside tests. The project setting is what makes an ordinary build accumulate evidence.
 *
 * Precedence: --route-mode flag > compose.json#routing.mode > preset `_routing.mode` > 'off'.
 *
 * `routingOptionsFor` is the single resolver both Build and GSD call, so pinning it here
 * pins both entry points.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { routingOptionsFor } from '../lib/build.js';

const PRESET_SHADOW = { _routing: { mode: 'shadow' } };

describe('routing mode precedence', () => {
  test('defaults to off when nothing configures it', () => {
    assert.equal(routingOptionsFor({}, {}, {}).mode, 'off');
    assert.equal(routingOptionsFor().mode, 'off', 'a bare call must still default off');
  });

  test('the project setting turns an ORDINARY build into a recorder', () => {
    // The whole point of the slice: no preset, no flag, still shadow.
    assert.equal(routingOptionsFor({}, {}, { routing: { mode: 'shadow' } }).mode, 'shadow');
  });

  test('the preset still works when the project says nothing', () => {
    assert.equal(routingOptionsFor(PRESET_SHADOW, {}, {}).mode, 'shadow');
  });

  test('the project setting outranks the preset', () => {
    assert.equal(routingOptionsFor(PRESET_SHADOW, {}, { routing: { mode: 'off' } }).mode, 'off');
  });

  test('the flag outranks the project setting in both directions', () => {
    assert.equal(
      routingOptionsFor({}, { route_mode: 'off' }, { routing: { mode: 'shadow' } }).mode, 'off',
      'the documented escape hatch: --route-mode=off must beat a shadow project setting',
    );
    assert.equal(
      routingOptionsFor({}, { route_mode: 'shadow' }, { routing: { mode: 'off' } }).mode, 'shadow',
    );
  });

  test('a config without a routing block is not a configuration', () => {
    // An absent key must fall through to the preset, not be read as an explicit off.
    assert.equal(routingOptionsFor(PRESET_SHADOW, {}, { capabilities: { stratum: true } }).mode, 'shadow');
    assert.equal(routingOptionsFor(PRESET_SHADOW, {}, { routing: {} }).mode, 'shadow');
  });

  test('a bogus project mode is refused by name, not silently ignored', () => {
    // Silently falling back would leave the user believing they were recording.
    assert.throws(
      () => routingOptionsFor({}, {}, { routing: { mode: 'active' } }),
      /compose\.json routing\.mode must be "off" or "shadow".*active/s,
    );
    assert.throws(() => routingOptionsFor({}, {}, { routing: { mode: true } }), /must be "off" or "shadow"/);
  });

  test('shadow carries no trials, exploration or feedback', () => {
    // assertRoutingSlice refuses anything past static shadow; the resolver must not
    // quietly enable a later slice's policy through the new config path.
    const opts = routingOptionsFor({}, {}, { routing: { mode: 'shadow' } });
    assert.deepEqual(opts.route_trials, []);
    assert.equal(opts.route_explore, 0);
    assert.equal(opts.calibration_feedback, false);
  });
});

// ---------------------------------------------------------------------------
// End to end. Precedence is arithmetic; this is the claim that matters — an
// ORDINARY build, with no preset and no flag, actually writes ledger rows because
// of the project setting alone. A resolver test would pass while the corpus stayed
// empty, which is the exact state this slice exists to end.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFixture } from './helpers/routing-runtime-fixture.js';

/** Configure the fixture workspace's compose.json, then take the mode ONLY from there. */
const configured = (mode) => ({
  mode: 'off',                       // the fixture's own opts-level default, deliberately off
  setup: ({ cwd }) => writeFileSync(
    join(cwd, '.compose/compose.json'),
    JSON.stringify({ version: 2, routing: { mode } }),
  ),
});

test('an ordinary build records a corpus from the project setting alone', async t => {
  const f = await runtimeFixture(t, configured('shadow'));
  await f.run({ route_mode: undefined });   // no flag: the setting is the only source
  const rows = f.rows();
  assert.ok(rows.length > 0, 'the project setting must produce ledger rows on an ordinary build');
  assert.equal(rows[0].cost.usd, 0.12, 'the row carries the real dispatch cost, not a placeholder');
  assert.ok(f.journal().routing, 'the routing journal must exist, not just a ledger line');
});

test('and records nothing when the project setting says off', async t => {
  const f = await runtimeFixture(t, configured('off'));
  await f.run({ route_mode: undefined });
  assert.deepEqual(f.rows(), [], 'off must stay byte-silent — no ledger, no partial rows');
  // POSITIVE CONTROL. Without this, a silent ledger is indistinguishable from a build that
  // never dispatched at all, and this case would keep passing if routing died entirely.
  assert.equal(f.calls.length, 1, 'the build must still have dispatched — off silences recording, not work');
});

test('GSD reads the same project setting as Build', async t => {
  // routingOptionsFor is shared, but GSD reads compose.json at its own call site
  // (lib/gsd.js), so the Build cases do not cover it. Wired-but-unexercised is
  // exactly how a dead path ships.
  const f = await runtimeFixture(t, { gsd: true, ...configured('shadow') });
  await f.run({ route_mode: undefined });
  assert.ok(f.rows().length > 0, 'a GSD run must record from the project setting alone');
});

test('GSD honours an off project setting too', async t => {
  const f = await runtimeFixture(t, { gsd: true, ...configured('off') });
  await f.run({ route_mode: undefined });
  assert.deepEqual(f.rows(), [], 'off must silence GSD recording as well');
  assert.equal(f.calls.length, 1, 'and the GSD run must still have dispatched');
});

test('the flag still overrides a shadow project setting for one run', async t => {
  // The escape hatch the failure message promises, exercised through a real build.
  const f = await runtimeFixture(t, configured('shadow'));
  await f.run({ route_mode: 'off' });
  assert.deepEqual(f.rows(), [], '--route-mode=off must silence a shadow-configured project');
});
