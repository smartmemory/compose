import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepPrompt } from '../lib/step-prompt.js';

const context = { cwd: '/projects/my-app', featureCode: 'AUTH-1' };

test('buildStepPrompt renders a complete TS ready dispatch', () => {
  const prompt = buildStepPrompt({
    step_id: 'generate-schema',
    intent: 'Generate the database schema from the domain model',
    inputs: { model: 'User', format: 'sql' },
    output_fields: { schema: 'string', tableCount: 'number' },
    ensure: ['schema contains CREATE TABLE', 'tableCount > 0'],
  }, context);
  assert.match(prompt, /"generate-schema"/);
  assert.match(prompt, /Generate the database schema/);
  assert.match(prompt, /Working directory: \/projects\/my-app/);
  assert.match(prompt, /Feature: AUTH-1/);
});

test('buildStepPrompt omits optional sections for a minimal TS ready dispatch', () => {
  const prompt = buildStepPrompt({ step_id: 'noop', intent: 'Do nothing' }, context);
  assert.match(prompt, /## Intent/);
  assert.doesNotMatch(prompt, /## Expected Output/);
  assert.doesNotMatch(prompt, /## Postconditions/);
});

test('buildStepPrompt includes TS previousFailure feedback', () => {
  const prompt = buildStepPrompt({
    step_id: 'retry-me',
    intent: 'Fix the artifact',
    previousFailure: { reason: 'file_exists check failed' },
  }, context);
  assert.match(prompt, /Previous Attempt Failed/);
  assert.match(prompt, /file_exists check failed/);
});
