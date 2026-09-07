/**
 * COMP-MCP-ENFORCE Slice 3 — kill `force` at the MCP tool boundary. When
 * capabilities.guard is on, a caller-supplied force:true on set_feature_status /
 * add_roadmap_entry is rejected unless it carries a valid out-of-band override
 * token (STRATUM_GUARD_OVERRIDE_TOKEN) — the single authorized deviation. Guard
 * off → legacy behavior (force passes through untouched).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { assertForceAuthorized, assertTerminalStatusAuthorized } = await import(`${REPO_ROOT}/server/compose-mcp-tools.js`);

test('force without guard → allowed (legacy behavior)', () => {
  assert.doesNotThrow(() => assertForceAuthorized({ force: true }, 'set_feature_status', { guard: false }));
});

test('no force → always allowed regardless of guard', () => {
  assert.doesNotThrow(() => assertForceAuthorized({ force: false }, 'set_feature_status', { guard: true }));
  assert.doesNotThrow(() => assertForceAuthorized({}, 'set_feature_status', { guard: true }));
});

test('force under guard without override token → rejected', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    assert.throws(
      () => assertForceAuthorized({ force: true }, 'set_feature_status', { guard: true }),
      /override_token|FORCE_REQUIRES_OVERRIDE|force is disabled/i,
    );
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

test('force under guard with a matching override token → allowed', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    assert.doesNotThrow(() =>
      assertForceAuthorized({ force: true, override_token: 'secret' }, 'set_feature_status', { guard: true }));
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

test('force under guard with a WRONG override token → rejected', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    assert.throws(() =>
      assertForceAuthorized({ force: true, override_token: 'nope' }, 'set_feature_status', { guard: true }));
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

test('force under guard when no override token is configured in env → rejected (cannot mint)', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  try {
    assert.throws(() =>
      assertForceAuthorized({ force: true, override_token: 'anything' }, 'set_feature_status', { guard: true }));
  } finally {
    if (prev !== undefined) process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

// --- terminal-status (COMPLETE/KILLED) lifecycle-ownership gate ---

test('terminal status: non-terminal statuses are never gated', () => {
  for (const status of ['PLANNED', 'IN_PROGRESS', 'PARTIAL', 'BLOCKED', 'PARKED', 'SUPERSEDED']) {
    assert.doesNotThrow(() => assertTerminalStatusAuthorized({ status }, 'set_feature_status', { guard: true }));
  }
});

test('terminal status: COMPLETE/KILLED allowed when guard off (legacy)', () => {
  assert.doesNotThrow(() => assertTerminalStatusAuthorized({ status: 'COMPLETE' }, 'set_feature_status', { guard: false }));
  assert.doesNotThrow(() => assertTerminalStatusAuthorized({ status: 'KILLED' }, 'add_roadmap_entry', { guard: false }));
});

test('terminal status: COMPLETE under guard without override → rejected (lifecycle-owned)', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    assert.throws(
      () => assertTerminalStatusAuthorized({ status: 'COMPLETE' }, 'set_feature_status', { guard: true }),
      /STATUS_OWNED_BY_LIFECYCLE|lifecycle-owned/i,
    );
    assert.throws(
      () => assertTerminalStatusAuthorized({ status: 'KILLED' }, 'add_roadmap_entry', { guard: true }),
      /STATUS_OWNED_BY_LIFECYCLE|lifecycle-owned/i,
    );
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

test('terminal status: COMPLETE under guard WITH valid override → allowed', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    assert.doesNotThrow(() =>
      assertTerminalStatusAuthorized({ status: 'COMPLETE', override_token: 'secret' }, 'set_feature_status', { guard: true }));
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

/**
 * AUDIT 2026-09-07. The gate's error text used to tell the caller the token was
 * "not agent-mintable". That is the same sentence stratum retired as false when
 * it removed the identical env-var token (@3647b4c): there, a CLI caller set both
 * sides of the comparison. Here the check is real at CALL time (the token is a
 * tool argument compared against the SERVER's environment) but not at LAUNCH
 * time — `.mcp.json` carries that environment and is writable by anything that
 * can write the repo.
 *
 * The wrong sentence is the liability, not the mechanism: it is what a later
 * session quotes when deciding how much this gate is worth. This test pins the
 * corrected claim so the comfortable one cannot come back.
 */
test('the refusal does not claim the token is un-mintable (audited 2026-09-07)', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    for (const [fn, args] of [
      [assertForceAuthorized, { force: true }],
      [assertTerminalStatusAuthorized, { status: 'KILLED' }],
    ]) {
      let msg = '';
      try { fn(args, 'set_feature_status', { guard: true }); } catch (e) { msg = e.message; }
      assert.ok(msg, 'the gate still refuses');
      assert.doesNotMatch(msg, /not agent-mintable|cannot be minted|un-?forgeable/i,
        `the refusal asserts a property nobody has demonstrated: ${msg}`);
    }
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});
