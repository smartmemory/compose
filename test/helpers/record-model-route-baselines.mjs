/** Temporary baseline recorder. Host: ROUTE_BASELINE_REVISION=<commit> ROUTE_BASELINE_LABEL=sol61-high ROUTE_BASELINE_WORKTREE=1 RESEND_API_KEY= STRIPE_API_KEY= node test/helpers/record-model-route-baselines.mjs
 * Without those env vars, uses revision ed8e333d17046a327e90d058334d28d00c785fe8 and label v0.5.1.
 * Executes the selected source revision in a disposable archive. WORKTREE=1 overlays the
 * current tier map and its integration assertion, allowing a new baseline before a commit.
 * Raw prompts/inputs are retained. Only non-JSON runtime callbacks/signals are omitted from call options.
 */
import { registerHooks } from 'node:module';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdtempSync, symlinkSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const revision = process.env.ROUTE_BASELINE_REVISION || 'ed8e333d17046a327e90d058334d28d00c785fe8';
const label = process.env.ROUTE_BASELINE_LABEL || 'v0.5.1';
const worktreeOverlay = process.env.ROUTE_BASELINE_WORKTREE === '1';
const replaceAnchor = (source, anchor, replacement, url) => {
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Route baseline trace expected one anchor in ${url}, found ${count}: ${anchor}`);
  return source.replace(anchor, replacement);
};
if (process.env.ROUTE_BASELINE_TRACE) {
  globalThis.__routeBaseline = value => appendFileSync(process.env.ROUTE_BASELINE_TRACE, JSON.stringify(value, (key, value) =>
    typeof value === 'function' || key === 'signal' ? undefined : value) + '\n');
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith('.js') || !loaded.source) return loaded;
    let source = String(loaded.source);
    if (url.endsWith('/lib/stratum-mcp-client.js')) source = replaceAnchor(source,
      'async plan(spec, flow, inputs, opts = {}) {',
      'async plan(spec, flow, inputs, opts = {}) { globalThis.__routeBaseline({kind:"plan",spec,flow,input:inputs,opts});', url);
    if (url.endsWith('/test/build-team-fable-astra.test.js')) {
      source = replaceAnchor(source,
        'inference.push({ provider, prompt, opts });',
        'globalThis.__routeBaseline({kind:"call",provider,prompt,opts}); inference.push({ provider, prompt, opts });', url);
      // The archived harness may require the very fixture this run is recording.
      // Remove only frozen-oracle reads/checks from the trace copy; all other assertions still run.
      if (process.env.ROUTE_BASELINE_CASE === 'bundled-build' &&
          revision !== 'ed8e333d17046a327e90d058334d28d00c785fe8') {
        for (const anchor of [
          "const frozen = frozenRoutingBaseline('bundled-build');",
          "assert.equal(corePreflight(profiles, spec, {}, { mode: 'off' }).profilesDigest, frozen.profileDigest);",
          'assert.deepEqual(plan.input, frozen.events[0].input);',
          'assert.equal(plan.flow, frozen.events[0].flow);',
          'assert.deepEqual(plan.opts, { ...frozen.events[0].opts, workspaceRoot: f.workspace });',
          'assertShadowGoldenInput(plan.input, frozen.events[0].input);',
          'assert.deepEqual(normalizedGoldenCalls(events), normalizedGoldenCalls(frozen.events));',
        ]) source = replaceAnchor(source, anchor, '', url);
      }
    }
    if (url.endsWith('/test/helpers/build-wave-golden-fixture.js')) source = replaceAnchor(source,
      "capture({ kind: 'call', provider, prompt, opts });",
      "globalThis.__routeBaseline({kind:'call',provider,prompt,opts}); capture({ kind: 'call', provider, prompt, opts });", url);
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
    const overlayPaths = ['server/model-tiers.js', 'test/integration/build-wave-golden.test.js'];
    const sourceOverlaySha256 = worktreeOverlay ? Object.fromEntries(overlayPaths.map(path => [path,
      createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])) : null;
    if (worktreeOverlay) for (const path of overlayPaths) copyFileSync(join(root, path), join(dir, path));
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
      const destination = join(root, `test/fixtures/model-route-off-${name}-${label}.json`);
      if (existsSync(destination) && JSON.parse(readFileSync(destination, 'utf8')).captured === true) {
        console.log(`${name}: retained frozen fixture (not recaptured)`); continue;
      }
      const trace = join(dir, `${name}.jsonl`);
      writeFileSync(trace, '');
      const run = spawnSync(process.execPath, ['--import', './test/helpers/record-model-route-baselines.mjs', '--test',
        '--test-timeout=300000', `--test-name-pattern=${pattern}`, test], { cwd: dir, encoding: 'utf8', timeout: 330000,
        maxBuffer: 20 * 1024 * 1024, env: { ...process.env, RESEND_API_KEY: '', STRIPE_API_KEY: '', STRATUM_STATE_ROOT: join(dir, `.stratum-state-${name}`),
          COMPOSE_STRATUM_TS_MCP_BIN: TS_MCP_BIN, COMPOSE_STRATUM_TS_CLI_BIN: TS_CLI_BIN,
          ROUTE_BASELINE_TRACE: trace, ROUTE_BASELINE_CASE: name } });
      const events = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const output = run.stdout + run.stderr;
      const plans = events.filter(e => e.kind === 'plan');
      const calls = events.filter(e => e.kind === 'call');
      const bothProviders = ['claude', 'codex'].every(p => calls.some(e => e.provider === p));
      const captured = run.status === 0 && (name === 'bundled-build'
        ? plans.length === 1 && calls.length === 5 && bothProviders
        : name === 'gsd-input' ? plans.length === 2 : plans.length > 0 && bothProviders);
      let profileDigest = null;
      if (captured && name !== 'gsd-input') {
        const probe = name === 'carry'
          ? "import {PROFILES as p,WAVE_GOLDEN_SPEC as s} from './test/helpers/build-wave-golden-fixture.js';"
          : "import {readFileSync} from 'node:fs'; const p=JSON.parse(readFileSync('presets/team-fable-astra.profiles.json')); const s=readFileSync('presets/team-fable-astra.stratum.yaml','utf8');";
        profileDigest = execFileSync(process.execPath, ['--input-type=module', '-e', probe +
          "import {preflightPipelineProfiles} from './lib/pipeline-profiles.js'; console.log(preflightPipelineProfiles(p,s).profilesDigest);"], { cwd: dir, encoding: 'utf8' }).trim();
      }
      const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
      const command = [
        ...(process.env.ROUTE_BASELINE_REVISION ? [`ROUTE_BASELINE_REVISION=${shellQuote(process.env.ROUTE_BASELINE_REVISION)}`] : []),
        ...(process.env.ROUTE_BASELINE_LABEL ? [`ROUTE_BASELINE_LABEL=${shellQuote(process.env.ROUTE_BASELINE_LABEL)}`] : []),
        ...(worktreeOverlay ? ['ROUTE_BASELINE_WORKTREE=1'] : []),
        'RESEND_API_KEY=', 'STRIPE_API_KEY=', 'node test/helpers/record-model-route-baselines.mjs',
      ].join(' ');
      const fixture = { sourceRevision: revision, ...(worktreeOverlay ? { sourceOverlaySha256 } : {}),
        ...(process.env.ROUTE_BASELINE_LABEL ? { label } : {}), captured, harness: test,
        command,
        ...(captured ? { profileDigest, events } : { reason: 'Real-engine capture did not complete; no expected bytes fabricated.', exitCode: run.status,
          diagnostics: output.slice(-14000) }) };
      mkdirSync(join(root, 'test/fixtures'), { recursive: true });
      writeFileSync(destination, JSON.stringify(fixture, null, 2) + '\n');
      console.log(`${name}: captured=${captured}, exit=${run.status}\n${captured ? '' : output.slice(-2500)}`);
    }
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
}
