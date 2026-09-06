import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireDirLock, DirLockTimeout } from '../lib/dir-lock.js';

test('acquireDirLock honours a caller timeout while another holder is live', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dir-lock-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lockPath = join(root, 'guard-descriptors');
  const release = await acquireDirLock(lockPath);
  t.after(release);

  const started = Date.now();
  await assert.rejects(
    acquireDirLock(lockPath, { timeoutMs: 100 }),
    (error) => error instanceof DirLockTimeout && error.code === 'DIR_LOCK_TIMEOUT',
  );
  assert.ok(Date.now() - started >= 90, 'did not wait for the requested budget');
  assert.ok(Date.now() - started < 500, 'did not use the requested budget');
  assert.equal(existsSync(lockPath), true);
});
