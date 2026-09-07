/**
 * COMP-MCP-ENFORCE Slice 3 — kill `force` at the MCP tool boundary. When
 * capabilities.guard is on, a caller-supplied force:true on set_feature_status /
 * add_roadmap_entry is rejected, FULL STOP. Guard off → legacy behavior (force
 * passes through untouched).
 *
 * AMENDED 2026-09-07: there is no override token any more. The three tests that
 * used to pin "a matching token is admitted" now pin the opposite, because the
 * behaviour deliberately changed — see
 * docs/decisions/2026-09-07-override-token-audit.md. The hatch had no user and
 * could not have one (the variable was unset everywhere we ship, and
 * `override_token` was in no tool schema), both statuses it nominally unlocked
 * have first-class doors, and it was never the real protection: anything that can
 * call these tools can write the files directly.
 *
 * These tests still SET the env var, deliberately. That is the strongest form of
 * the assertion: even a caller holding what used to be the key is refused.
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

test('force under guard is refused even holding the old key (the hatch is gone)', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    assert.throws(
      () => assertForceAuthorized({ force: true, override_token: 'secret' }, 'set_feature_status', { guard: true }),
      (e) => e.code === 'FORCE_REQUIRES_OVERRIDE' && /no override token/i.test(e.message),
      'a token matching the server env must NOT admit force any more',
    );
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

test('force under guard with a non-matching token → rejected', () => {
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

test('force under guard with no token configured → rejected', () => {
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

test('terminal status: COMPLETE and KILLED under guard → rejected (lifecycle-owned)', () => {
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

test('terminal status: refused even holding the old key, for BOTH statuses', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = 'secret';
  try {
    for (const status of ['COMPLETE', 'KILLED']) {
      assert.throws(
        () => assertTerminalStatusAuthorized({ status, override_token: 'secret' }, 'set_feature_status', { guard: true }),
        (e) => e.code === 'STATUS_OWNED_BY_LIFECYCLE' && /no override token/i.test(e.message),
        `${status} must stay lifecycle-owned even for a caller holding the retired token`,
      );
    }
  } finally {
    if (prev === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
    else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = prev;
  }
});

test('no environment can re-open the hatch — the token is not read at all', () => {
  const prev = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  try {
    // Every combination that used to matter: set/unset env x matching/absent arg.
    for (const env of ['secret', undefined]) {
      if (env === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
      else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = env;
      for (const args of [{ force: true }, { force: true, override_token: 'secret' }, { force: true, override_token: '' }]) {
        assert.throws(() => assertForceAuthorized(args, 'add_roadmap_entry', { guard: true }),
          `env=${env} args=${JSON.stringify(args)} must be refused`);
      }
    }
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
