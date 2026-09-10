import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseTeamFlag, KNOWN_TEAMS } from '../lib/team-flag.js';

describe('KNOWN_TEAMS', () => {
  it('contains review, research, feature', () => {
    assert.ok(KNOWN_TEAMS.includes('review'));
    assert.ok(KNOWN_TEAMS.includes('research'));
    assert.ok(KNOWN_TEAMS.includes('feature'));
  });
});

// Note: parseTeamFlag receives args AFTER the subcommand is stripped
// (i.e., process.argv minus [node, script, cmd]). So args are like
// ['--team', 'review', 'FEAT-1'], not ['build', '--team', 'review', 'FEAT-1'].

describe('parseTeamFlag', () => {
  it('rewrites --team review to template team-review', () => {
    const result = parseTeamFlag(['--team', 'review', 'FEAT-1']);
    assert.equal(result.template, 'team-review');
    assert.deepEqual(result.args, ['FEAT-1']);
  });

  it('rewrites --team feature to template team-feature', () => {
    const result = parseTeamFlag(['--team', 'feature', 'FEAT-1']);
    assert.equal(result.template, 'team-feature');
  });

  it('returns null template when --team is absent', () => {
    const result = parseTeamFlag(['FEAT-1']);
    assert.equal(result.template, null);
    assert.deepEqual(result.args, ['FEAT-1']);
  });

  it('throws when --team has no value', () => {
    assert.throws(() => parseTeamFlag(['--team']), /requires a team name/);
  });

  it('throws when --team value starts with -', () => {
    assert.throws(() => parseTeamFlag(['--team', '--all']), /requires a team name/);
  });

  it('throws when --team is used with --all (batch)', () => {
    assert.throws(() => parseTeamFlag(['--team', 'review', '--all']), /cannot be used with batch/i);
  });

  it('throws when --team is used with multiple feature codes', () => {
    assert.throws(() => parseTeamFlag(['--team', 'review', 'FEAT-1', 'FEAT-2']), /cannot be used with batch/i);
  });

  it('throws when --team is used with --template', () => {
    assert.throws(() => parseTeamFlag(['--team', 'review', '--template', 'custom']), /cannot be used with --template/i);
  });

  it('throws for unknown team name', () => {
    assert.throws(() => parseTeamFlag(['--team', 'unknown']), /unknown team.*available/i);
  });
});


// Run the real CLI with a loader capture at its runBuild boundary, following the
// CLI loader fixture pattern. No engine or paid agent is started by these tests.
function runTeamCli(t, args) {
  const cwd = mkdtempSync(join(tmpdir(), 'team-cli-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.compose'), { recursive: true });
  mkdirSync(join(cwd, 'pipelines'));
  mkdirSync(join(cwd, 'docs/features/X'), { recursive: true });
  writeFileSync(join(cwd, '.compose/compose.json'), '{"version":2}');
  writeFileSync(join(cwd, 'pipelines/build.stratum.yaml'), 'version: 1');
  writeFileSync(join(cwd, 'docs/features/X/feature.json'), '{"code":"X","status":"PLANNED"}');
  const capture = join(cwd, 'calls.jsonl');
  const loader = join(cwd, 'capture-loader.mjs');
  const binUrl = new URL('../bin/compose.js', import.meta.url);
  writeFileSync(loader, `
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === '../lib/build.js' && context.parentURL === ${JSON.stringify(binUrl.href)}) {
        const source = ${JSON.stringify(`
          import { appendFileSync } from 'node:fs';
          export async function runBuild(featureCode, options) {
            appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ featureCode, options }) + '\\n');
            return { ok: true };
          }
        `)};
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `);
  const result = spawnSync(process.execPath,
    ['--experimental-loader', loader, fileURLToPath(binUrl), 'build', ...args],
    { cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_ENV: 'test' } });
  const calls = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { ...result, calls };
}

describe('build --team CLI value flags', () => {
  for (const ceiling of [['--cost-ceiling-usd', '200'], ['--cost-ceiling-usd=200']]) {
    it(`starts one build with ${ceiling.join(' ')}`, t => {
      const result = runTeamCli(t, ['X', '--team', 'fable-astra', ...ceiling]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(result.calls, [{ featureCode: 'X', options: {
        abort: false, template: 'team-fable-astra', costCeilingUsd: 200,
      } }]);
    });
  }
  it('still refuses two real feature codes', t => {
    const result = runTeamCli(t, ['X', 'Y', '--team', 'fable-astra']);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /--team cannot be used with batch builds/);
    assert.deepEqual(result.calls, []);
  });
});
