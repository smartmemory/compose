/** Temporary baseline recorder. Host: RESEND_API_KEY= STRIPE_API_KEY= node test/helpers/record-model-route-baselines.mjs
 * Always executes the frozen source revision in a disposable archive; never captures changed production code.
 * Raw prompts/inputs are retained. Only non-JSON runtime callbacks/signals are omitted from call options.
 */
import { registerHooks } from 'node:module';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
const revision = 'ed8e333d17046a327e90d058334d28d00c785fe8';
if (process.env.ROUTE_BASELINE_TRACE) {
  globalThis.__routeBaseline = value => appendFileSync(process.env.ROUTE_BASELINE_TRACE, JSON.stringify(value, (key, value) =>
    typeof value === 'function' || key === 'signal' ? undefined : value) + '\n');
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith('.js') || !loaded.source) return loaded;
    let source = String(loaded.source);
    if (url.endsWith('/lib/stratum-mcp-client.js')) source = source.replace(
      'async plan(spec, flow, inputs, opts = {}) {',
      'async plan(spec, flow, inputs, opts = {}) { globalThis.__routeBaseline({kind:"plan",spec,flow,input:inputs,opts});');
    if (url.endsWith('/test/build-team-fable-astra.test.js')) source = source.replace(
      'inference.push({ provider, prompt, opts });',
      'globalThis.__routeBaseline({kind:"call",provider,prompt,opts}); inference.push({ provider, prompt, opts });');
    if (url.endsWith('/test/helpers/build-wave-golden-fixture.js')) source = source.replace(
      "capture({ kind: 'call', provider, prompt, opts });",
      "globalThis.__routeBaseline({kind:'call',provider,prompt,opts}); capture({ kind: 'call', provider, prompt, opts });");
    return { ...loaded, source };
  } });
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const tempRoot = mkdtempSync(join(tmpdir(), 'route-baseline-source-'));
  const dir = join(tempRoot, 'compose');
  mkdirSync(dir, { recursive: true });
  try {
    const archive = execFileSync('git', ['archive', revision], { cwd: root, maxBuffer: 100 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: archive });
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    symlinkSync(resolve(root, '../stratum'), join(tempRoot, 'stratum'));
    copyFileSync(fileURLToPath(import.meta.url), join(dir, 'test/helpers/record-model-route-baselines.mjs'));
    const { TS_MCP_BIN, TS_CLI_BIN } = await import('./stratum-test-bin.js');
    const cases = [
      ['bundled-build', 'test/build-team-fable-astra.test.js', 'off real preset wave'],
      ['carry', 'test/integration/build-wave-golden.test.js', 'two carried waves'],
      ['gsd-input', 'test/gsd-stuck-resume-golden.test.js', 'same-file edit loop|skips completed T01'],
    ];
    for (const [name, test, pattern] of cases) {
      const destination = join(root, `test/fixtures/model-route-off-${name}-v0.5.1.json`);
      if (existsSync(destination) && JSON.parse(readFileSync(destination, 'utf8')).captured === true) {
        console.log(`${name}: retained frozen fixture (not recaptured)`); continue;
      }
      const trace = join(dir, `${name}.jsonl`);
      writeFileSync(trace, '');
      const run = spawnSync(process.execPath, ['--import', './test/helpers/record-model-route-baselines.mjs', '--test',
        '--test-timeout=300000', `--test-name-pattern=${pattern}`, test], { cwd: dir, encoding: 'utf8', timeout: 330000,
        maxBuffer: 20 * 1024 * 1024, env: { ...process.env, RESEND_API_KEY: '', STRIPE_API_KEY: '', STRATUM_STATE_ROOT: join(dir, `.stratum-state-${name}`),
          COMPOSE_STRATUM_TS_MCP_BIN: TS_MCP_BIN, COMPOSE_STRATUM_TS_CLI_BIN: TS_CLI_BIN, ROUTE_BASELINE_TRACE: trace } });
      const events = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const output = run.stdout + run.stderr;
      const expectedBundledOracleMismatch = name === 'bundled-build' && run.status === 1 &&
        events.filter(e => e.kind === 'plan').length === 1 && events.filter(e => e.kind === 'call').length === 5 &&
        /operator: 'deepStrictEqual'/.test(output) && /build-team-fable-astra\.test\.js:167:12/.test(output);
      const captured = (run.status === 0 || expectedBundledOracleMismatch) && events.some(e => e.kind === 'plan') &&
        (name === 'gsd-input' ? events.filter(e => e.kind === 'plan').length === 2 :
          ['claude', 'codex'].every(p => events.some(e => e.kind === 'call' && e.provider === p)));
      let profileDigest = null;
      if (captured && name !== 'gsd-input') {
        const probe = name === 'carry'
          ? "import {PROFILES as p,WAVE_GOLDEN_SPEC as s} from './test/helpers/build-wave-golden-fixture.js';"
          : "import {readFileSync} from 'node:fs'; const p=JSON.parse(readFileSync('presets/team-fable-astra.profiles.json')); const s=readFileSync('presets/team-fable-astra.stratum.yaml','utf8');";
        profileDigest = execFileSync(process.execPath, ['--input-type=module', '-e', probe +
          "import {preflightPipelineProfiles} from './lib/pipeline-profiles.js'; console.log(preflightPipelineProfiles(p,s).profilesDigest);"], { cwd: dir, encoding: 'utf8' }).trim();
      }
      const fixture = { sourceRevision: revision, captured, harness: test, command: 'RESEND_API_KEY= STRIPE_API_KEY= node test/helpers/record-model-route-baselines.mjs',
        ...(captured ? { profileDigest, events } : { reason: 'Real-engine capture did not complete; no expected bytes fabricated.', exitCode: run.status,
          diagnostics: output.slice(-14000) }) };
      mkdirSync(join(root, 'test/fixtures'), { recursive: true });
      writeFileSync(join(root, `test/fixtures/model-route-off-${name}-v0.5.1.json`), JSON.stringify(fixture, null, 2) + '\n');
      console.log(`${name}: captured=${captured}, exit=${run.status}\n${captured ? '' : output.slice(-2500)}`);
    }
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
}
