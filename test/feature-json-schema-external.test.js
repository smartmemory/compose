/**
 * feature-json-schema-external.test.js — contract test for the external
 * link variant added to contracts/feature-json.schema.json
 * (COMP-MCP-XREF-SCHEMA #15, task T002).
 *
 * Asserts: schema compiles via the real SchemaValidator (Ajv draft-07,
 * ajv-formats), both link variants validate, malformed externals reject,
 * and a real existing feature.json still validates (no regression).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

import { SchemaValidator } from '../server/schema-validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEATURE_JSON_SCHEMA = resolve(__dirname, '..', 'contracts', 'feature-json.schema.json');

function validator() {
  // Throws if the new if/then/allOf does not compile.
  return new SchemaValidator(FEATURE_JSON_SCHEMA);
}

const ok = (v, links) => v.validateRoot({ code: 'X-1', links });
const link = (extra) => [{ ...extra }];

describe('feature-json schema — compiles', () => {
  test('SchemaValidator constructs (schema compiles, no Ajv error)', () => {
    assert.doesNotThrow(() => validator());
  });
});

describe('feature-json schema — accepts', () => {
  const v = validator();

  test('same-project link (kind+to_code)', () => {
    assert.equal(ok(v, link({ kind: 'depends_on', to_code: 'COMP-X' })).valid, true);
  });

  test('same-project link tolerates extra keys (stays permissive)', () => {
    assert.equal(ok(v, link({ kind: 'depends_on', to_code: 'COMP-X', legacyExtra: 1 })).valid, true);
  });

  test('external github', () => {
    assert.equal(ok(v, link({ kind: 'external', provider: 'github', repo: 'o/n', issue: 7 })).valid, true);
  });

  test('external local', () => {
    assert.equal(ok(v, link({ kind: 'external', provider: 'local', repo: 'compose', to_code: 'COMP-MCP-VALIDATE' })).valid, true);
  });

  test('external url', () => {
    assert.equal(ok(v, link({ kind: 'external', provider: 'url', url: 'https://x.example/a' })).valid, true);
  });

  for (const p of ['jira', 'linear', 'notion', 'obsidian']) {
    test(`external reserved provider ${p} (url-class, requires url)`, () => {
      assert.equal(ok(v, link({ kind: 'external', provider: p, url: `https://x.example/${p}` })).valid, true);
    });
  }
});

describe('feature-json schema — rejects', () => {
  const v = validator();

  test('external github missing issue', () => {
    assert.equal(ok(v, link({ kind: 'external', provider: 'github', repo: 'o/n' })).valid, false);
  });

  test('external missing provider', () => {
    assert.equal(ok(v, link({ kind: 'external', url: 'https://x.example' })).valid, false);
  });

  test('external url with non-uri url', () => {
    assert.equal(ok(v, link({ kind: 'external', provider: 'url', url: 'not a uri' })).valid, false);
  });

  test('reserved provider missing url', () => {
    assert.equal(ok(v, link({ kind: 'external', provider: 'jira' })).valid, false);
  });

  test('same-project link missing kind is rejected (no widening regression)', () => {
    assert.equal(ok(v, link({ to_code: 'COMP-X' })).valid, false);
  });

  test('link missing kind with no to_code is rejected', () => {
    assert.equal(ok(v, link({ note: 'orphan' })).valid, false);
  });
});

describe('feature-json schema — no regression on real feature.json', () => {
  // Regression contract: any feature.json that was valid under the OLD links
  // shape (kind ∈ old enum + to_code present, or no links) MUST still validate
  // under the new schema. Files that were already schema-dirty (link kinds
  // outside even the old enum, e.g. COMP-BMAD) were never valid and are out of
  // scope for this feature — excluded, not asserted, not "fixed" here.
  const OLD_KINDS = new Set(['surfaced_by', 'blocks', 'depends_on', 'follow_up', 'supersedes', 'related']);
  const wasValidUnderOldLinks = (obj) => {
    if (!Array.isArray(obj.links)) return true;
    return obj.links.every(
      (l) => l && OLD_KINDS.has(l.kind) && typeof l.to_code === 'string',
    );
  };

  test('every previously-valid real feature.json still validates (no regression)', () => {
    const v = validator();
    const featuresDir = resolve(__dirname, '..', 'docs', 'features');
    const dirs = readdirSync(featuresDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    let asserted = 0;
    for (const d of dirs) {
      const fp = join(featuresDir, d.name, 'feature.json');
      if (!existsSync(fp)) continue;
      let obj;
      try { obj = JSON.parse(readFileSync(fp, 'utf8')); } catch { continue; }
      if (!wasValidUnderOldLinks(obj)) continue; // pre-existing dirty, not our regression
      const r = v.validateRoot(obj);
      assert.equal(
        r.valid, true,
        `${d.name}/feature.json was valid under old links shape but now fails: ${JSON.stringify(r.errors)}`,
      );
      asserted++;
    }
    assert.ok(asserted > 0, 'expected at least one previously-valid real feature.json to assert against');
  });
});
