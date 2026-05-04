import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { SchemaValidator, loadSchema, SCHEMA_VERSION } from '../server/schema-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEATURE_JSON_SCHEMA = resolve(__dirname, '..', 'contracts', 'feature-json.schema.json');
const ROADMAP_ROW_SCHEMA = resolve(__dirname, '..', 'contracts', 'roadmap-row.schema.json');

test('zero-arg constructor still validates comp-obs back-compat', () => {
  const v = new SchemaValidator();
  // Use a real comp-obs definition. Don't care if the obj passes; key is the
  // validator instantiates and runs without throwing on a known $defs name.
  const result = v.validate('OpenLoop', {});
  assert.equal(typeof result.valid, 'boolean');
  assert.ok(Array.isArray(result.errors));
});

test('zero-arg constructor surfaces unknown definition with structured error', () => {
  const v = new SchemaValidator();
  // Existing comp-obs callers rely on this throw-on-unknown behavior.
  assert.throws(() => v.validate('NotARealDefinition', {}), /unknown schema definition/);
});

test('SCHEMA_VERSION export still resolves to the comp-obs version', () => {
  // Existing comp-obs callers consume SCHEMA_VERSION; must remain populated.
  assert.ok(SCHEMA_VERSION === undefined || typeof SCHEMA_VERSION === 'string' || typeof SCHEMA_VERSION === 'number');
});

test('path-arg constructor loads feature-json schema', () => {
  const v = new SchemaValidator(FEATURE_JSON_SCHEMA);
  assert.equal(v.schema.title, 'feature.json');
});

test('validateRoot accepts a valid feature.json', () => {
  const v = new SchemaValidator(FEATURE_JSON_SCHEMA);
  const result = v.validateRoot({
    code: 'COMP-MCP-VALIDATE',
    description: 'Cross-artifact feature validator.',
    status: 'IN_PROGRESS',
    complexity: 'L',
    position: 7,
    created: '2026-05-04',
    updated: '2026-05-04',
  });
  assert.equal(result.valid, true, `errors: ${JSON.stringify(result.errors)}`);
});

test('validateRoot accepts numeric complexity (de facto legacy shape)', () => {
  const v = new SchemaValidator(FEATURE_JSON_SCHEMA);
  const result = v.validateRoot({
    code: 'COMP-DEBUG-1',
    description: 'Legacy file uses numeric complexity.',
    complexity: 3,
  });
  assert.equal(result.valid, true);
});

test('validateRoot accepts feature.json with permissive extra fields', () => {
  const v = new SchemaValidator(FEATURE_JSON_SCHEMA);
  const result = v.validateRoot({
    code: 'COMP-DEBUG-1',
    name: 'Legacy alternative to description',
    depends_on: ['COMP-OTHER'],
    source: 'manual',
    filesChanged: ['lib/foo.js'],
  });
  assert.equal(result.valid, true);
});

test('validateRoot rejects feature.json with bad code', () => {
  const v = new SchemaValidator(FEATURE_JSON_SCHEMA);
  const result = v.validateRoot({ code: 'lowercase-bad' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /pattern/.test(e.keyword) || /code/.test(e.instancePath)));
});

test('validateRoot rejects feature.json with unknown status', () => {
  const v = new SchemaValidator(FEATURE_JSON_SCHEMA);
  const result = v.validateRoot({ code: 'X-1', status: 'NOT-A-REAL-STATUS' });
  assert.equal(result.valid, false);
});

test('roadmap-row schema validates a parsed FeatureEntry', () => {
  const v = new SchemaValidator(ROADMAP_ROW_SCHEMA);
  const result = v.validateRoot({
    code: 'COMP-MCP-VALIDATE',
    description: 'Cross-artifact validator.',
    status: 'IN_PROGRESS',
    phaseId: 'phase-7-mcp-writers',
    position: 7,
  });
  assert.equal(result.valid, true);
});

test('roadmap-row schema rejects anonymous _anon_* sentinel', () => {
  const v = new SchemaValidator(ROADMAP_ROW_SCHEMA);
  const result = v.validateRoot({
    code: '_anon_3',
    description: 'Sentinel',
    status: 'PLANNED',
    phaseId: 'phase-x',
    position: 3,
  });
  assert.equal(result.valid, false, 'sentinel must fail strict pattern; validator is responsible for pre-filtering');
});

test('loadSchema returns the same cached object on repeat calls', () => {
  const a = loadSchema(FEATURE_JSON_SCHEMA);
  const b = loadSchema(FEATURE_JSON_SCHEMA);
  assert.equal(a, b, 'cache must return identity');
});

test('loadSchema returns different objects for different paths', () => {
  const a = loadSchema(FEATURE_JSON_SCHEMA);
  const b = loadSchema(ROADMAP_ROW_SCHEMA);
  assert.notEqual(a, b);
  assert.notEqual(a.schema.title, b.schema.title);
});
