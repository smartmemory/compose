/**
 * COMPOSE-GOLDEN-LEAK-1 (fix2): behavioural probe for the git-writer table in test/git-sandbox-guard.test.js.
 *
 *   node test/helpers/git-writer-probe.js <absolute path of a test file or helper>
 *
 * Run WITHOUT the test preload, with GIT_DIR/GIT_CONFIG pointing at a decoy repo. It loads the target's real import
 * graph (node:test and vitest are stubbed so no test body runs), then performs a bare git write in this same process
 * with no env argument, i.e. exactly how the target's own git calls inherit process.env. If loading the target did
 * not install the scrub, the write lands in the decoy and the guard row fails. Prints one JSON line.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STUB = `const p = new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : p), apply: () => p });
export default p;
export const test = p, describe = p, it = p, suite = p, before = p, after = p, beforeEach = p, afterEach = p,
  beforeAll = p, afterAll = p, mock = p, run = p, expect = p, vi = p, snapshot = p;`;
const HOOKS = `export async function resolve(spec, ctx, next) {
  if (spec === 'node:test' || spec === 'vitest') return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(STUB)}`)}, shortCircuit: true };
  return next(spec, ctx);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`);

const result = { loaded: false, canary: null };
try {
  await import(pathToFileURL(process.argv[2]).href);
  result.loaded = true;
} catch (err) {
  result.loadError = String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ');
}
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'compose-guard-probe-')));
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  git('init', '-q');
  git('config', 'user.name', 'Probe');
  git('config', 'user.email', 'probe@example.test');
  git('commit', '-q', '--allow-empty', '-m', 'probe');
  result.canary = git('log', '-1', '--format=%an');
} catch (err) {
  result.canaryError = String(err?.stderr ?? err?.message ?? err).trim();
} finally { rmSync(dir, { recursive: true, force: true }); }
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
