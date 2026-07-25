/**
 * COMP-CANON-OVERRIDE S3 — the guard/override seam.
 *
 * `decideCanonGuard` stays PURE: it classifies, it never consumes. Gate round 1
 * finding 4 established that an injected destructive callback would make the
 * function non-idempotent, so the atomic claim lives in the hook wrapper and
 * the core only reports whether a grant could apply.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideCanonGuard } from '../lib/canon-guard.js';

const ROOT = '/repo';
const base = { toolName: 'Write', cwd: ROOT, projectRoot: ROOT };
const decide = (file) => decideCanonGuard({ ...base, toolInput: { file_path: file } });

describe('decideCanonGuard — override classification', () => {
  test('a judgment path is denied and IS override-eligible', () => {
    const d = decide('/repo/docs/judgment/records/joints/x.json');
    assert.equal(d.deny, true);
    assert.equal(d.overrideEligible, true);
    assert.equal(d.path, 'docs/judgment/records/joints/x.json');
  });

  test('governance state is denied and is NOT override-eligible', () => {
    for (const p of [
      '.compose/canon-overrides.jsonl',
      '.compose/canon-overrides-attest.json',
      '.compose/data/canon-grants/t.json',
    ]) {
      const d = decide(`/repo/${p}`);
      assert.equal(d.deny, true, `${p} must be denied`);
      assert.equal(d.overrideEligible, false, `${p} must not be grantable`);
    }
  });

  test('an unguarded path is allowed and carries no eligibility claim', () => {
    const d = decide('/repo/src/app.js');
    assert.equal(d.deny, false);
    assert.ok(!d.overrideEligible);
  });

  test('is pure — evaluating twice returns an identical verdict', () => {
    const p = '/repo/docs/judgment/records/joints/x.json';
    assert.deepEqual(decide(p), decide(p));
  });

  test('the denial names the real override tool, not "edit the registry"', () => {
    const d = decide('/repo/docs/judgment/records/joints/x.json');
    assert.match(d.reason, /canon_override_grant/);
    assert.doesNotMatch(d.reason, /not yet available/i);
    assert.doesNotMatch(d.reason, /remove the path from/i);
  });

  test('an ungrantable denial does NOT advertise the override', () => {
    const d = decide('/repo/.compose/canon-overrides.jsonl');
    assert.doesNotMatch(d.reason, /canon_override_grant.*to override/is);
    assert.match(d.reason, /cannot be overridden|not override-eligible|ungrantable/i);
  });

  test('the denial is honest about scope — no enforcement language', () => {
    const d = decide('/repo/docs/judgment/records/joints/x.json');
    assert.doesNotMatch(d.reason, /\benforce(d|ment|s)?\b/i);
  });
});
