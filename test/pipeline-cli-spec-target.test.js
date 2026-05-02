/**
 * pipeline-cli-spec-target.test.js — verify lib/pipeline-cli.js can target
 * a non-default spec (e.g. new.stratum.yaml) via the trailing specName param.
 *
 * Regression coverage for COMP-NEW-QUESTIONNAIRE-MISMATCH: the questionnaire
 * path in bin/compose.js calls pipelineSet/pipelineDisable against the
 * kickoff spec; before the fix those helpers hardcoded build.stratum.yaml.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';

import { pipelineDisable, pipelineSet } from '../lib/pipeline-cli.js';

function setupCwd(extraSpecs = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'pipeline-cli-spec-'));
  mkdirSync(join(cwd, 'pipelines'), { recursive: true });

  // Minimal build spec so the default-specName path remains valid.
  const buildSpec = {
    version: '0.3',
    workflow: { name: 'build' },
    flows: {
      build: {
        steps: [
          { id: 'execute', agent: 'claude', intent: 'do work', retries: 2 },
        ],
      },
    },
  };
  writeFileSync(
    join(cwd, 'pipelines', 'build.stratum.yaml'),
    stringify(buildSpec, { lineWidth: 120 })
  );

  for (const [name, spec] of Object.entries(extraSpecs)) {
    writeFileSync(join(cwd, 'pipelines', name), stringify(spec, { lineWidth: 120 }));
  }
  return cwd;
}

function readSpec(cwd, specName) {
  return parse(readFileSync(join(cwd, 'pipelines', specName), 'utf-8'));
}

describe('pipeline-cli specName target', () => {
  test('pipelineDisable defaults to build.stratum.yaml', () => {
    const cwd = setupCwd();
    pipelineDisable(cwd, ['execute']);
    const spec = readSpec(cwd, 'build.stratum.yaml');
    assert.equal(spec.flows.build.steps[0].skip_if, 'true');
  });

  test('pipelineDisable targets new.stratum.yaml when specName is passed', () => {
    const newSpec = {
      version: '0.2',
      workflow: { name: 'new' },
      flows: {
        new: {
          steps: [
            { id: 'review_gate', function: 'review_gate' },
            { id: 'roadmap', agent: 'claude', intent: 'roadmap' },
          ],
        },
      },
      functions: { review_gate: { mode: 'gate', timeout: 7200 } },
    };
    const cwd = setupCwd({ 'new.stratum.yaml': newSpec });

    pipelineDisable(cwd, ['review_gate'], 'new.stratum.yaml');

    const result = readSpec(cwd, 'new.stratum.yaml');
    assert.equal(result.flows.new.steps[0].skip_if, 'true', 'review_gate should be disabled in kickoff spec');

    // Build spec must remain untouched.
    const build = readSpec(cwd, 'build.stratum.yaml');
    assert.equal(build.flows.build.steps[0].skip_if, undefined, 'build spec must not be mutated');
  });

  test('pipelineSet --mode review converts kickoff review_gate into a codex sub-flow', () => {
    const newSpec = {
      version: '0.2',
      workflow: { name: 'new' },
      flows: {
        new: {
          steps: [
            { id: 'brainstorm', agent: 'claude', intent: 'brainstorm' },
            { id: 'review_gate', function: 'review_gate', on_approve: 'roadmap' },
            { id: 'roadmap', agent: 'claude', intent: 'roadmap' },
          ],
        },
      },
      functions: { review_gate: { mode: 'gate', timeout: 7200 } },
    };
    const cwd = setupCwd({ 'new.stratum.yaml': newSpec });

    pipelineSet(cwd, 'review_gate', ['--mode', 'review'], 'new.stratum.yaml');

    const result = readSpec(cwd, 'new.stratum.yaml');
    const reviewStep = result.flows.new.steps.find(s => s.id === 'review_gate');
    assert.equal(reviewStep.flow, 'review_gate_review', 'review_gate should now reference a sub-flow');
    assert.equal(result.flows.review_gate_review.steps[0].agent, 'codex', 'sub-flow should run on codex');
  });

  test('pipelineDisable throws on missing spec without crashing the caller', () => {
    const cwd = setupCwd();
    assert.throws(
      () => pipelineDisable(cwd, ['anything'], 'nonexistent.stratum.yaml'),
      /No pipeline found at/
    );
  });
});
