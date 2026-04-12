import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CrossLayerAudit, loadDebugConfig } from '../lib/cross-layer-audit.js';

const TMP = join(import.meta.dirname, '.tmp-audit-test');

describe('loadDebugConfig', () => {
  beforeEach(() => { mkdirSync(join(TMP, '.compose'), { recursive: true }); });
  afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

  it('returns defaults when no compose.json', () => {
    const config = loadDebugConfig(TMP);
    assert.deepEqual(config.cross_layer_repos, []);
    assert.ok(config.cross_layer_extensions.length > 0);
  });

  it('reads cross_layer_repos from compose.json', () => {
    writeFileSync(join(TMP, '.compose', 'compose.json'), JSON.stringify({
      debug_discipline: { cross_layer_repos: ['../other-repo'] },
    }));
    const config = loadDebugConfig(TMP);
    assert.deepEqual(config.cross_layer_repos, ['../other-repo']);
  });
});

describe('CrossLayerAudit', () => {
  it('detects scope_hint cross-layer from structured field', () => {
    const audit = new CrossLayerAudit({ cross_layer_repos: [], cross_layer_extensions: [] });
    const result = audit.shouldExpand({ scope_hint: 'cross-layer', root_cause: 'provider switch' });
    assert.equal(result.expand, true);
    assert.equal(result.trigger, 'scope_hint');
  });

  it('skips when scope_hint is single', () => {
    const audit = new CrossLayerAudit({ cross_layer_repos: [], cross_layer_extensions: [] });
    const result = audit.shouldExpand({ scope_hint: 'single', root_cause: 'typo' });
    assert.equal(result.expand, false);
  });

  it('falls back to keyword detection when scope_hint is unknown', () => {
    const audit = new CrossLayerAudit({ cross_layer_repos: [], cross_layer_extensions: [] });
    const result = audit.shouldExpand({ scope_hint: 'unknown', root_cause: 'switching from openai to groq' });
    assert.equal(result.expand, true);
    assert.equal(result.trigger, 'keyword:openai');
  });

  it('falls back to keyword detection when scope_hint is absent', () => {
    const audit = new CrossLayerAudit({ cross_layer_repos: [], cross_layer_extensions: [] });
    const result = audit.shouldExpand({ root_cause: 'renamed VITE_API_URL config key' });
    assert.equal(result.expand, true);
    assert.ok(result.trigger.includes('VITE_'));
  });

  it('returns no expansion for single-layer changes without keywords', () => {
    const audit = new CrossLayerAudit({ cross_layer_repos: [], cross_layer_extensions: [] });
    const result = audit.shouldExpand({ root_cause: 'off-by-one in loop counter' });
    assert.equal(result.expand, false);
  });
});
