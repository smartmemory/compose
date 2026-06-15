/**
 * COMP-RTK-INTEROP — lib/rtk.js helper.
 *
 * RTK is a LOSSY command-output compressor invoked as a command-prefix wrapper.
 * The helper's only job: when `rtk` is installed, prefix an LLM-bound command with
 * `rtk `; otherwise return it byte-identical. Detection is memoized per process and
 * can be forced off with COMPOSE_DISABLE_RTK=1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  isRtkAvailable,
  rtkPrefix,
  _setRtkProber,
  _resetRtkCache,
} = await import('../lib/rtk.js')

test('rtkPrefix prepends `rtk ` when rtk is available', () => {
  delete process.env.COMPOSE_DISABLE_RTK
  _setRtkProber(() => true)
  assert.equal(isRtkAvailable(), true)
  assert.equal(rtkPrefix('git diff --no-color HEAD'), 'rtk git diff --no-color HEAD')
})

test('rtkPrefix is byte-identical passthrough when rtk is absent', () => {
  delete process.env.COMPOSE_DISABLE_RTK
  _setRtkProber(() => false)
  assert.equal(isRtkAvailable(), false)
  const cmd = 'git diff --no-color HEAD'
  assert.equal(rtkPrefix(cmd), cmd)
})

test('availability probe is memoized (called at most once per process)', () => {
  delete process.env.COMPOSE_DISABLE_RTK
  let calls = 0
  _setRtkProber(() => { calls++; return true })
  isRtkAvailable()
  isRtkAvailable()
  isRtkAvailable()
  assert.equal(calls, 1)
})

test('COMPOSE_DISABLE_RTK=1 forces unavailable even if rtk is installed', () => {
  process.env.COMPOSE_DISABLE_RTK = '1'
  _resetRtkCache()
  _setRtkProber(() => true) // would say available, but kill-switch wins
  assert.equal(isRtkAvailable(), false)
  assert.equal(rtkPrefix('git diff'), 'git diff')
  delete process.env.COMPOSE_DISABLE_RTK
})

test.after(() => { delete process.env.COMPOSE_DISABLE_RTK })
