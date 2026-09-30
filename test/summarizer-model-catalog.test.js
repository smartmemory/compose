import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tier } from './helpers/model-catalog.js';

test('summarizer reads the catalog fast tier and preserves env/explicit overrides', t => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-summarizer-model-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'claude'), `#!${process.execPath}
    const fs=require('node:fs');fs.writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));
    console.log(JSON.stringify({summary:'controlled output'}));`, { mode: 0o755 });
  for (const [override, explicit, expected] of [
    ['', null, tier('claude', 'fast').model],
    ['fixture-env', null, 'fixture-env'],
    ['fixture-env', 'fixture-explicit', 'fixture-explicit'],
  ]) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import {summarize} from './server/summarizer.js';
      console.log(JSON.stringify(await summarize('test', {projectRoot:${JSON.stringify(dir)},
        ${explicit ? `model:${JSON.stringify(explicit)}` : ''}})));`], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SUMMARIZER_MODEL: override },
    });
    assert.deepEqual(JSON.parse(output), { summary: 'controlled output' });
    const argv = JSON.parse(readFileSync(join(dir, 'argv.json')));
    assert.equal(argv[argv.indexOf('--model') + 1], expected);
  }
});
