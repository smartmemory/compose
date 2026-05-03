import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wfPath = resolve(__dirname, '..', '.github', 'workflows', 'publish-compose-mcp.yml');
const wfText = readFileSync(wfPath, 'utf8');
const wf = parseYaml(wfText);

test('workflow parses as valid YAML', () => {
  assert.equal(typeof wf, 'object');
  assert.equal(wf.name, 'Publish compose-mcp');
});

test('workflow trigger pattern is compose-mcp-v*', () => {
  // YAML "on" key is parsed as the boolean `true`; tolerate both
  const on = wf.on ?? wf[true];
  assert.deepEqual(on.push.tags, ['compose-mcp-v*']);
});

test('workflow references both required secrets', () => {
  assert.match(wfText, /secrets\.NPM_TOKEN/);
  assert.match(wfText, /secrets\.SMARTMEM_DEV_GITHUB_TOKEN/);
});

test('workflow uses NODE_AUTH_TOKEN auth pattern (not OIDC)', () => {
  assert.match(wfText, /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
  assert.equal(wf.permissions['contents'], 'read');
  assert.ok(!wfText.includes('id-token: write'), 'must not request OIDC token (using NPM_TOKEN auth)');
});

test('workflow has version-match validation step', () => {
  const steps = wf.jobs.publish.steps;
  const hasValidate = steps.some((s) => s.name?.toLowerCase().includes('validate version'));
  assert.ok(hasValidate, 'must include version-match validation step');
});

test('workflow validates nested server.json packages[0].version', () => {
  // Catches the drift case where top-level server.json.version matches but the
  // npm package entry inside packages[0] does not.
  assert.match(wfText, /server\.json\.packages\[0\]/);
  assert.match(wfText, /SRV_PKG_VERSION/);
});

test('workflow runs wrapper tests before publishing (gate)', () => {
  const steps = wf.jobs.publish.steps;
  const stepNames = steps.map((s) => s.name ?? '');
  const testIdx = stepNames.findIndex((n) => n.toLowerCase().includes('run wrapper tests'));
  const npmPublishIdx = stepNames.findIndex((n) => n.toLowerCase() === 'publish to npm');
  assert.ok(testIdx >= 0, 'must include a step that runs wrapper tests');
  assert.ok(npmPublishIdx > testIdx, 'tests must run before npm publish');
});

test('workflow runs npm pack --dry-run before publishing', () => {
  const steps = wf.jobs.publish.steps;
  const stepNames = steps.map((s) => s.name ?? '');
  const packIdx = stepNames.findIndex((n) => n.toLowerCase().includes('npm pack'));
  const npmPublishIdx = stepNames.findIndex((n) => n.toLowerCase() === 'publish to npm');
  assert.ok(packIdx >= 0, 'must include npm pack --dry-run step');
  assert.ok(npmPublishIdx > packIdx, 'pack must run before npm publish');
});

test('workflow has parent dep preflight step', () => {
  assert.match(wfText, /npm view "@smartmemory\/compose/);
});
