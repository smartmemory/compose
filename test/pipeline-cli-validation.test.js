import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { validateSpec } from '@smartmemory/stratum/dist/ir/validate.js'
import { pipelineDisable, pipelineEnable, pipelineSet } from '../lib/pipeline-cli.js'

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'pipeline-validation-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  mkdirSync(join(cwd, 'pipelines'))
  const path = join(cwd, 'pipelines/new.stratum.yaml')
  copyFileSync(new URL('../pipelines/new.stratum.yaml', import.meta.url), path)
  return { cwd, path }
}

function valid(path) {
  const spec = parse(readFileSync(path, 'utf8'))
  const result = validateSpec(spec)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  return spec
}

const answers = [
  ['Human (gate prompt)', () => {}],
  ['Codex (automated review)', cwd => pipelineSet(cwd, 'review_gate', ['--mode', 'review'], 'new.stratum.yaml')],
  ['Skip review', cwd => pipelineDisable(cwd, ['review_gate'], 'new.stratum.yaml')],
]
for (const [answer, apply] of answers) {
  test(`${answer} validates against installed Stratum`, t => {
    const { cwd, path } = fixture(t)
    const before = readFileSync(path, 'utf8')
    apply(cwd)
    const spec = valid(path)
    const step = spec.flows.new.steps.find(step => step.id === 'review_gate')
    assert.deepEqual(step.after, ['brainstorm'])
    if (answer === 'Human (gate prompt)') assert.equal(readFileSync(path, 'utf8'), before)
    if (answer === 'Skip review') {
      assert.equal(step.when, 'false')
      assert.ok(step.gate)
      pipelineEnable(cwd, ['review_gate'], 'new.stratum.yaml')
      assert.equal(valid(path).flows.new.steps[2].when, undefined)
    }
    if (answer === 'Codex (automated review)') {
      assert.equal(step.run, 'review_gate_review')
      assert.deepEqual(step.with, { task: '${brainstorm.output.summary}' })
      const review = spec.flows.review_gate_review.steps[0]
      assert.equal(review.agent, 'codex')
      assert.deepEqual(review.ensure, [{ expr: 'result.clean == true' }])
      assert.equal(review.attempts, 5)
    }
    console.log(`${answer}: VALID`)
  })
}

test('review, agent, and gate conversions preserve scheduling and validate', t => {
  const { cwd, path } = fixture(t)
  for (const mode of ['review', 'review', 'agent', 'gate', 'agent', 'review']) {
    pipelineSet(cwd, 'review_gate', ['--mode', mode], 'new.stratum.yaml')
    assert.deepEqual(valid(path).flows.new.steps[2].after, ['brainstorm'])
  }
  pipelineSet(cwd, 'review_gate', ['--agent', 'claude', '--retries', '3'], 'new.stratum.yaml')
  const review = valid(path).flows.review_gate_review.steps[0]
  assert.equal(review.agent, 'claude')
  assert.equal(review.attempts, 3)
  pipelineDisable(cwd, ['review_gate'], 'new.stratum.yaml')
  pipelineSet(cwd, 'review_gate', ['--mode', 'gate'], 'new.stratum.yaml')
  assert.equal(valid(path).flows.new.steps[2].when, 'false')
})

test('invalid generated output is reported and never written, even with a swallowing caller', t => {
  const { cwd, path } = fixture(t)
  const before = readFileSync(path, 'utf8')
  const errors = []
  t.mock.method(console, 'error', message => errors.push(message))
  assert.throws(() => pipelineSet(cwd, 'review_gate', ['--mode', 'review', '--retries', '0'], 'new.stratum.yaml'), /Refusing to write invalid pipeline/)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.match(errors[0], /attempts/)
  try {
    pipelineSet(cwd, 'review_gate', ['--mode', 'review', '--retries', '0'], 'new.stratum.yaml')
  } catch { /* same tolerance as the questionnaire */ }
  assert.equal(errors.length, 2)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('disable refuses invalid input without changing disk', t => {
  const { cwd, path } = fixture(t)
  const spec = valid(path)
  spec.flows.new.steps[0].out = 'MissingContract'
  writeFileSync(path, stringify(spec))
  const before = readFileSync(path, 'utf8')
  const errors = []
  t.mock.method(console, 'error', message => errors.push(message))
  assert.throws(() => pipelineDisable(cwd, ['review_gate'], 'new.stratum.yaml'), /CONTRACT_UNKNOWN_REF/)
  assert.equal(readFileSync(path, 'utf8'), before)
  assert.equal(errors.length, 1)
})

test('missing spec and missing step remain tolerable without validation diagnostics or writes', t => {
  const { cwd, path } = fixture(t)
  const before = readFileSync(path, 'utf8')
  const errors = []
  t.mock.method(console, 'error', message => errors.push(message))
  for (const apply of [
    () => pipelineSet(cwd, 'review_gate', ['--mode', 'review'], 'missing.stratum.yaml'),
    () => pipelineDisable(cwd, ['review_gate'], 'missing.stratum.yaml'),
    () => pipelineSet(cwd, 'absent', ['--mode', 'review'], 'new.stratum.yaml'),
    () => pipelineDisable(cwd, ['absent'], 'new.stratum.yaml'),
  ]) assert.throws(apply, /No pipeline found|not found in pipeline/)
  assert.deepEqual(errors, [])
  assert.equal(readFileSync(path, 'utf8'), before)
})
