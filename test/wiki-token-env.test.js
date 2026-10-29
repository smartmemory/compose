// The wiki owner token's path from the sealed file to the API server only (COMPOSE-COCKPIT-WIKI-TOKEN-1). Synthetic token only.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { wikiChildEnv } from '../server/wiki-routes.js';

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'cockpit.sh');
const NAME = 'COMPOSE_WIKI_OWNER_TOKEN';
const SYNTH = 'synthetic-token-0123456789abcdef0123456789abcdef';

describe('wikiChildEnv: which supervised child sees the token', () => {
  const env = { PATH: '/bin', [NAME]: SYNTH, COMPOSE_HOST: '127.0.0.1' };
  // name, process, tokenEnv, token present in the child's env
  const ROWS = [
    ['api-server keeps it', 'api-server', NAME, true],
    ['vite never gets it', 'vite', NAME, false],
    ['agent-server (spawns claude -p) never gets it', 'agent-server', NAME, false],
    ['no wiki config: nothing to strip', 'vite', null, true],
  ];
  it('is table-driven and leaves the rest of the env alone', () => {
    for (const [name, proc, tokenEnv, present] of ROWS) {
      const out = wikiChildEnv(proc, env, tokenEnv);
      assert.equal(out[NAME] === SYNTH, present, name);
      assert.equal(out.PATH, '/bin', `${name}: PATH`);
      assert.equal(out.COMPOSE_HOST, '127.0.0.1', `${name}: COMPOSE_HOST`);
    }
    assert.equal(env[NAME], SYNTH, 'the input env is not mutated');
  });
});

describe('cockpit.sh load_wiki_token', () => {
  it('loads from the sealed file only when the var is unset, never from a VITE_ name', () => {
    const root = mkdtempSync(join(tmpdir(), 'wiki-token-env-'));
    try {
      const proj = (tokenEnv) => {
        const dir = join(root, tokenEnv);
        mkdirSync(join(dir, '.compose'), { recursive: true });
        writeFileSync(join(dir, '.compose', 'compose.json'), JSON.stringify({ wiki: { enabled: true, tokenEnv } }));
        return dir;
      };
      const sealed = join(root, 'sealed');
      mkdirSync(sealed);
      writeFileSync(join(sealed, 'wiki-owner-token'), `${SYNTH}\n`, { mode: 0o600 });
      const empty = join(root, 'empty');
      mkdirSync(empty);
      // name, env var the config names, sealed dir, preset value, expected value, expected stdout note
      const ROWS = [
        ['unset: read from the sealed file', NAME, sealed, undefined, SYNTH, ''],
        ['already set: not overridden', NAME, sealed, 'from-the-environment', 'from-the-environment', ''],
        ['sealed file missing: starts anyway, names the var, no value', NAME, empty, undefined, '<unset>', NAME],
        ['VITE_ name: refused by the validator, nothing loaded', 'VITE_WIKI_OWNER_TOKEN', sealed, undefined, '<unset>', ''],
      ];
      for (const [name, tokenEnv, dir, preset, want, note] of ROWS) {
        const env = { PATH: process.env.PATH, HOME: root, COMPOSE_TARGET: proj(tokenEnv), WIKI_SEALED_DIR: dir };
        if (preset !== undefined) env[tokenEnv] = preset;
        const r = spawnSync('bash', ['-c', `source "${SCRIPT}"; load_wiki_token; printf '|%s' "\${${tokenEnv}:-<unset>}"`], { env, encoding: 'utf8' });
        assert.equal(r.status, 0, `${name}: exit (${r.stderr})`);
        const [said, got] = r.stdout.split('|');
        assert.equal(got, want, `${name}: value`);
        if (note) assert.ok(said.includes(note), `${name}: names the var`);
        assert.ok(!said.includes(SYNTH), `${name}: the message never carries the value`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
