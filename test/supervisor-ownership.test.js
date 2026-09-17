import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  decideSupervisorOwnership,
  readSupervisorRecord,
  writeSupervisorRecord,
} from '../server/supervisor-ownership.js';

const STARTED_AT = '2026-09-17T10:00:00.000Z';

function record(overrides = {}) {
  return {
    pid: 1234,
    targetRoot: '/projects/alpha',
    startedAt: STARTED_AT,
    ...overrides,
  };
}

describe('supervisor ownership decision', () => {
  test('restarts a live supervisor for the same project', () => {
    assert.deepEqual(decideSupervisorOwnership({
      record: record(),
      currentPid: 5678,
      currentTargetRoot: '/projects/alpha',
      takeover: false,
      processAlive: true,
    }), {
      action: 'restart',
      pid: 1234,
      targetRoot: '/projects/alpha',
    });
  });

  test('refuses a live supervisor owned by a different project', () => {
    assert.deepEqual(decideSupervisorOwnership({
      record: record({ targetRoot: '/projects/beta' }),
      currentPid: 5678,
      currentTargetRoot: '/projects/alpha',
      takeover: false,
      processAlive: true,
    }), {
      action: 'refuse',
      pid: 1234,
      targetRoot: '/projects/beta',
    });
  });

  test('takes over a live supervisor for a different project when explicit', () => {
    assert.deepEqual(decideSupervisorOwnership({
      record: record({ targetRoot: '/projects/beta' }),
      currentPid: 5678,
      currentTargetRoot: '/projects/alpha',
      takeover: true,
      processAlive: true,
    }), {
      action: 'takeover',
      pid: 1234,
      targetRoot: '/projects/beta',
    });
  });

  test('proceeds silently for a stale PID', () => {
    assert.deepEqual(decideSupervisorOwnership({
      record: record(),
      currentPid: 5678,
      currentTargetRoot: '/projects/alpha',
      takeover: false,
      processAlive: false,
    }), { action: 'proceed' });
  });
});

describe('supervisor ownership record', () => {
  test('writes and reads the JSON ownership record', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-supervisor-ownership-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, '.compose-supervisor.pid');
    const expected = record();

    writeSupervisorRecord(file, expected);

    assert.deepEqual(readSupervisorRecord(file), expected);
  });

  test('reads a legacy bare PID and ignores malformed content', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-supervisor-ownership-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, '.compose-supervisor.pid');

    writeFileSync(file, '4321\n');
    assert.deepEqual(readSupervisorRecord(file), {
      pid: 4321,
      targetRoot: null,
      startedAt: null,
      legacy: true,
    });
    assert.deepEqual(decideSupervisorOwnership({
      record: readSupervisorRecord(file),
      currentPid: 5678,
      currentTargetRoot: '/projects/alpha',
      takeover: false,
      processAlive: true,
    }), {
      action: 'restart',
      pid: 4321,
      targetRoot: null,
    });

    writeFileSync(file, 'not a pid or JSON');
    assert.equal(readSupervisorRecord(file), null);
  });
});
