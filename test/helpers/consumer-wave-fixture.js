import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { profilesDigest } from '../../lib/pipeline-profiles.js';
import { ConsumerFanoutArtifacts } from '../../lib/consumer-fanout.js';

export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
export function consumerWaveFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'compose-consumer-wave-'));
  const cwd = join(root, 'repo');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(cwd);
  const write = (file, content, target = cwd) => {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), content);
  };
  write('owned.txt', 'base\n');
  write('other.txt', 'other\n');
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.name', 'Consumer Wave Test']);
  git(cwd, ['config', 'user.email', 'wave@example.test']);
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-qm', 'baseline']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runId = 'wave-test';
  const options = { runId, targetCwd: cwd, artifactRoot, revisionDigest: 'rev', specDigest: 'spec' };
  const artifacts = new ConsumerFanoutArtifacts(options);
  const descriptor = (item = { id: 'T1', files_owned: ['owned.txt'], depends_on: [] }, extra = {}) => ({
    id: 'execute/0', step: 'execute', itemIndex: 0, generation: 1, stage: 0, attempt: 1,
    dispatchToken: 'dispatch-1', revisionDigest: 'rev', contractDigest: 'contract',
    isolation: 'worktree', epoch: 0, item, ...extra,
  });
  const audit = (d, status = 'succeeded', extra = {}) => ({ status: 'running', events: [],
    steps: { execute: { epoch: d.epoch, fanout: { items: [{ generation: d.generation, status,
      ...(status === 'succeeded' ? { acceptedDispatchToken: d.dispatchToken } : { dispatchToken: d.dispatchToken }) }] } }, ...extra } });
  const binding = d => ({ item: d.item, itemDigest: profilesDigest(d.item), epoch: d.epoch, sourceProvenance: 'descriptor.item' });
  return { binding, cwd, artifactRoot, options, artifacts, descriptor, audit, write, base: git(cwd, ['rev-parse', 'HEAD']),
    ref: 'refs/heads/compose/wave/wave-test' };
}
