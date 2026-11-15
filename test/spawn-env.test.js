import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSpawnEnv } from '../server/spawn-env.js';

test('cleanSpawnEnv strips CLAUDECODE, keeps CLAUDE_CONFIG_DIR, applies extras', () => {
  const env = cleanSpawnEnv({ COMPOSE_TARGET: '/r', NO_COLOR: '1' }, { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/cfg', PATH: '/bin' });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/cfg', PATH: '/bin', COMPOSE_TARGET: '/r', NO_COLOR: '1' });
});
