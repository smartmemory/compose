import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CCSessionFeatureResolver } from '../../server/cc-session-feature-resolver.js';

let tmp;
let sessionsFile;
let featureRoot;

function writeSessions(arr) {
  fs.writeFileSync(sessionsFile, JSON.stringify(arr, null, 2));
}

function mkFeatureSessionFile(featureCode, ccId, ext = '.transcript') {
  const dir = path.join(featureRoot, featureCode, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${ccId}${ext}`);
  fs.writeFileSync(p, '');
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resolver-test-'));
  sessionsFile = path.join(tmp, 'sessions.json');
  featureRoot = path.join(tmp, 'features');
  fs.mkdirSync(featureRoot, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe('CCSessionFeatureResolver', () => {
  it('primary: resolves via transcriptPath basename match', () => {
    writeSessions([{
      featureCode: 'FEAT-A',
      transcriptPath: '/home/ruze/.claude/projects/x/abc-123.jsonl',
    }]);
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    assert.equal(r.resolve('abc-123'), 'FEAT-A');
  });

  it('primary: returns null when transcriptPath is absent on the matching record', () => {
    writeSessions([{ featureCode: 'FEAT-A', transcriptPath: null }]);
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    assert.equal(r.resolve('abc-123'), null);
  });

  it('fallback: returns feature_code when feature-folder probe matches', () => {
    writeSessions([]);
    mkFeatureSessionFile('FEAT-B', 'xyz-999');
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    assert.equal(r.resolve('xyz-999'), 'FEAT-B');
  });

  it('unbound: returns null when neither tier matches; increments unbound_count', () => {
    writeSessions([]);
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    assert.equal(r.resolve('unknown-id'), null);
    assert.equal(r.stats.unbound_count, 1);
    assert.equal(r.resolve('other-unknown'), null);
    assert.equal(r.stats.unbound_count, 2);
  });

  it('primary beats fallback when both point to different features', () => {
    writeSessions([{ featureCode: 'FEAT-A', transcriptPath: '/cc/abc.jsonl' }]);
    mkFeatureSessionFile('FEAT-B', 'abc');
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    assert.equal(r.resolve('abc'), 'FEAT-A');
  });

  it('cache: repeated resolve calls do not re-read sessions.json when mtime is unchanged', () => {
    writeSessions([{ featureCode: 'FEAT-A', transcriptPath: '/cc/abc.jsonl' }]);
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    r.resolve('abc');
    const firstMtime = r._sessionsMtime;
    r.resolve('abc');
    r.resolve('abc');
    assert.equal(r._sessionsMtime, firstMtime);
  });

  it('cache invalidates on sessions.json mtime bump', () => {
    writeSessions([]);
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    assert.equal(r.resolve('abc'), null);
    const newMtime = Date.now() + 5_000;
    writeSessions([{ featureCode: 'FEAT-A', transcriptPath: '/cc/abc.jsonl' }]);
    fs.utimesSync(sessionsFile, new Date(newMtime), new Date(newMtime));
    assert.equal(r.resolve('abc'), 'FEAT-A');
  });

  it('does not double-count unbound entries on repeated lookups of the same id within one sessions.json generation', () => {
    writeSessions([]);
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    r.resolve('abc');
    r.resolve('abc');
    assert.equal(r.stats.unbound_count, 1);
  });

  it('returns null on empty/undefined input', () => {
    writeSessions([]);
    const r = new CCSessionFeatureResolver({ sessionsFile, featureRoot });
    assert.equal(r.resolve(''), null);
    assert.equal(r.resolve(undefined), null);
    assert.equal(r.resolve(null), null);
  });
});
