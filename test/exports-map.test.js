import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

test('package.json exports map: ./mcp points to server/compose-mcp.js', () => {
  assert.ok(pkg.exports, 'exports field must exist');
  assert.equal(pkg.exports['./mcp'], './server/compose-mcp.js');
});

test('package.json exports map: ./package.json self-export', () => {
  assert.equal(pkg.exports['./package.json'], './package.json');
});

test('package.json exports map: no "." root export (would execute CLI on import)', () => {
  assert.ok(
    !Object.prototype.hasOwnProperty.call(pkg.exports, '.'),
    'exports must not include "." — root import would execute the CLI'
  );
});
