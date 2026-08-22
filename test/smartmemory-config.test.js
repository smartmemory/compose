/**
 * smartmemory-config.test.js — COMP-SMARTMEMORY-INGEST T1
 *
 * Tests for lib/smartmemory-config.js: getSmartmemoryConfig, resolveProjectTag,
 * sourcePathFor, resolveStratumPolicyEnv (GOV-COMPOSE-SEAM-1 step 0).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import {
  getSmartmemoryConfig, resolveProjectTag, sourcePathFor, resolveStratumPolicyEnv,
} from '../lib/smartmemory-config.js';

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'smartmemory-config-'));
}

function writeComposeJson(dir, obj) {
  mkdirSync(join(dir, '.compose'), { recursive: true });
  writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify(obj));
}

describe('getSmartmemoryConfig', () => {
  test('absent block → {}', () => {
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'foo' });
      assert.deepEqual(getSmartmemoryConfig(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing compose.json entirely → {}', () => {
    const dir = makeDir();
    try {
      assert.deepEqual(getSmartmemoryConfig(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('present block → verbatim', () => {
    const dir = makeDir();
    try {
      const block = { enabled: true, baseUrl: 'http://localhost:9999', apiKeyEnv: 'SM_KEY', timeoutMs: 5000 };
      writeComposeJson(dir, { workspaceId: 'foo', smartmemory: block });
      assert.deepEqual(getSmartmemoryConfig(dir), block);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed JSON → {}', () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, '.compose'), { recursive: true });
      writeFileSync(join(dir, '.compose', 'compose.json'), '{ not json');
      assert.deepEqual(getSmartmemoryConfig(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getSmartmemoryConfig — non-standard shapes', () => {
  test('smartmemory as a bare primitive (true, not an object) is returned verbatim, not coerced to {}', () => {
    // `cfg.smartmemory ?? {}` only nullish-coalesces — a malformed but
    // *present* non-object value passes through unchanged. Consumers guard
    // with `.enabled === true` / `?.enabled`, which is safe against a
    // primitive (property access auto-boxes to undefined), but the reader
    // itself does not normalize the shape.
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'foo', smartmemory: true });
      assert.equal(getSmartmemoryConfig(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveProjectTag', () => {
  test('valid workspaceId → that id', () => {
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'my-workspace' });
      assert.equal(resolveProjectTag(dir), 'my-workspace');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('absent workspaceId → basename(cwd)', () => {
    const dir = makeDir();
    try {
      assert.equal(resolveProjectTag(dir), basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('invalid workspaceId (uppercase) → basename(cwd)', () => {
    const dir = makeDir();
    try {
      writeComposeJson(dir, { workspaceId: 'NOT-VALID' });
      assert.equal(resolveProjectTag(dir), basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sourcePathFor', () => {
  test('joins project tag + repo-relative path', () => {
    assert.equal(sourcePathFor('regio', 'a/b.md'), 'compose/regio/a/b.md');
  });
});


describe('resolveStratumPolicyEnv (GOV-COMPOSE-SEAM-1 step 0)', () => {
  const KEY_VAR = 'SMARTMEMORY_TEST_KEY_ENV';

  function withKey(value, fn) {
    const prior = process.env[KEY_VAR];
    if (value === undefined) delete process.env[KEY_VAR];
    else process.env[KEY_VAR] = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env[KEY_VAR];
      else process.env[KEY_VAR] = prior;
    }
  }

  const UNSET = Symbol('unset');

  function withDir(block, fn, keyValue = 'sk-test') {
    const dir = makeDir();
    try {
      writeComposeJson(dir, block);
      // `UNSET` sentinel rather than `undefined`: passing `undefined` explicitly
      // still triggers the default parameter, which would leave the key set and
      // make the "key unset" case pass for the wrong reason.
      return withKey(keyValue === UNSET ? undefined : keyValue, () => fn(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const FULL = {
    workspaceId: 'forge',
    smartmemory: {
      enabled: true,
      baseUrl: 'https://api.example.test',
      apiKeyEnv: KEY_VAR,
      workspaceId: 'team_26f0bbe60a4c',
    },
  };

  test('fully configured → the three env vars', () => {
    withDir(FULL, (dir) => {
      assert.deepEqual(resolveStratumPolicyEnv(dir), {
        SMARTMEMORY_API_URL: 'https://api.example.test',
        SMARTMEMORY_API_KEY: 'sk-test',
        SMARTMEMORY_WORKSPACE_ID: 'team_26f0bbe60a4c',
      });
    });
  });

  test('reads smartmemory.workspaceId, NEVER the top-level project slug', () => {
    // The trap this function exists to close: `forge` is a Compose project tag,
    // not a SmartMemory workspace. Sending it scopes every event to a workspace
    // that does not exist, and the API still answers 200.
    withDir(FULL, (dir) => {
      const env = resolveStratumPolicyEnv(dir);
      assert.equal(env.SMARTMEMORY_WORKSPACE_ID, 'team_26f0bbe60a4c');
      assert.notEqual(env.SMARTMEMORY_WORKSPACE_ID, 'forge');
    });
  });

  test('disabled → {} (byte-identical spawn env to before the feature)', () => {
    withDir({ ...FULL, smartmemory: { ...FULL.smartmemory, enabled: false } },
      (dir) => assert.deepEqual(resolveStratumPolicyEnv(dir), {}));
  });

  test('enabled but block absent → {}', () => {
    withDir({ workspaceId: 'forge' }, (dir) => assert.deepEqual(resolveStratumPolicyEnv(dir), {}));
  });

  test('missing compose.json entirely → {}', () => {
    const dir = makeDir();
    try {
      assert.deepEqual(resolveStratumPolicyEnv(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('api key env var unset → {} (all three or nothing)', () => {
    withDir(FULL, (dir) => assert.deepEqual(resolveStratumPolicyEnv(dir), {}), UNSET);
  });

  test('missing smartmemory.workspaceId → {} rather than a partial env', () => {
    // A partial env is worse than none: it produces events addressed to nowhere.
    const { workspaceId, ...noWs } = FULL.smartmemory;
    withDir({ ...FULL, smartmemory: noWs },
      (dir) => assert.deepEqual(resolveStratumPolicyEnv(dir), {}));
  });

  test('missing baseUrl → {}', () => {
    const { baseUrl, ...noUrl } = FULL.smartmemory;
    withDir({ ...FULL, smartmemory: noUrl },
      (dir) => assert.deepEqual(resolveStratumPolicyEnv(dir), {}));
  });

  test('blank/whitespace values are treated as absent', () => {
    withDir({ ...FULL, smartmemory: { ...FULL.smartmemory, baseUrl: '   ' } },
      (dir) => assert.deepEqual(resolveStratumPolicyEnv(dir), {}));
    withDir({ ...FULL, smartmemory: { ...FULL.smartmemory, workspaceId: '' } },
      (dir) => assert.deepEqual(resolveStratumPolicyEnv(dir), {}));
  });

  test('malformed compose.json → {}, never throws', () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, '.compose'), { recursive: true });
      writeFileSync(join(dir, '.compose', 'compose.json'), '{ not json');
      assert.deepEqual(resolveStratumPolicyEnv(dir), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
