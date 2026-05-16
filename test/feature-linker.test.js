/**
 * feature-linker.test.js — coverage for the linker exports of
 * lib/feature-writer.js (COMP-MCP-ARTIFACT-LINKER T3).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  addRoadmapEntry,
  linkArtifact,
  linkFeatures,
  getFeatureArtifacts,
  getFeatureLinks,
} from '../lib/feature-writer.js';
import { readFeature } from '../lib/feature-json.js';
import { readEvents } from '../lib/feature-events.js';

function freshCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'feature-linker-'));
  mkdirSync(join(cwd, 'docs', 'features'), { recursive: true });
  return cwd;
}

async function seed(cwd, code, phase = 'P') {
  await addRoadmapEntry(cwd, { code, description: code, phase });
}

function touch(cwd, relPath, content = 'x') {
  const abs = join(cwd, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// linkArtifact
// ---------------------------------------------------------------------------

describe('linkArtifact', () => {
  test('links a non-canonical artifact and stores in feature.json', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'LA-1');
    touch(cwd, 'docs/features/LA-1/snapshot.md', 'snap');

    const r = await linkArtifact(cwd, {
      feature_code: 'LA-1',
      artifact_type: 'snapshot',
      path: 'docs/features/LA-1/snapshot.md',
    });
    assert.equal(r.feature_code, 'LA-1');
    assert.equal(r.artifact_type, 'snapshot');
    assert.equal(r.path, 'docs/features/LA-1/snapshot.md');

    const f = readFeature(cwd, 'LA-1');
    assert.deepEqual(f.artifacts, [{ type: 'snapshot', path: 'docs/features/LA-1/snapshot.md' }]);
  });

  test('rejects canonical artifact paths inside the feature folder', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'LC-1');
    touch(cwd, 'docs/features/LC-1/design.md', '# design');

    await assert.rejects(
      () => linkArtifact(cwd, {
        feature_code: 'LC-1',
        artifact_type: 'design',
        path: 'docs/features/LC-1/design.md',
      }),
      /canonical artifact/
    );

    // But a file named design.md OUTSIDE the feature folder is allowed.
    touch(cwd, 'docs/random/design.md', '# elsewhere');
    const r = await linkArtifact(cwd, {
      feature_code: 'LC-1',
      artifact_type: 'reference',
      path: 'docs/random/design.md',
    });
    assert.equal(r.path, 'docs/random/design.md');
  });

  test('rejects non-existent path', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'NE-1');
    await assert.rejects(
      () => linkArtifact(cwd, {
        feature_code: 'NE-1',
        artifact_type: 'snapshot',
        path: 'docs/features/NE-1/missing.md',
      }),
      /does not exist/
    );
  });

  test('rejects symlinks that escape cwd', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'SYM-1');
    // Create a symlink inside the repo pointing at /etc/passwd.
    const linkPath = join(cwd, 'docs/features/SYM-1/leak');
    mkdirSync(join(linkPath, '..'), { recursive: true });
    try {
      symlinkSync('/etc/passwd', linkPath);
    } catch {
      // Skip on platforms where symlinks need elevated perms.
      return;
    }
    await assert.rejects(
      () => linkArtifact(cwd, {
        feature_code: 'SYM-1', artifact_type: 'leak', path: 'docs/features/SYM-1/leak',
      }),
      /symlinks outside cwd/
    );
  });

  test('rejects directory paths (must point at a file)', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'DIR-1');
    // The feature folder itself exists as a directory.
    await assert.rejects(
      () => linkArtifact(cwd, {
        feature_code: 'DIR-1', artifact_type: 'folder',
        path: 'docs/features/DIR-1',
      }),
      /must point at a file/
    );
  });

  test('rejects path with .. or absolute or tilde', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'BP-1');
    touch(cwd, 'docs/features/BP-1/snap.md');

    await assert.rejects(
      () => linkArtifact(cwd, { feature_code: 'BP-1', artifact_type: 's', path: '/etc/passwd' }),
      /repo-relative/
    );
    await assert.rejects(
      () => linkArtifact(cwd, { feature_code: 'BP-1', artifact_type: 's', path: '~/secret' }),
      /repo-relative/
    );
    await assert.rejects(
      () => linkArtifact(cwd, { feature_code: 'BP-1', artifact_type: 's', path: 'docs/../../../etc/passwd' }),
      /\.\./
    );
  });

  test('dedups on (type, path) — second call is noop', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'DD-1');
    touch(cwd, 'docs/features/DD-1/snap.md');

    const r1 = await linkArtifact(cwd, {
      feature_code: 'DD-1', artifact_type: 'snapshot', path: 'docs/features/DD-1/snap.md',
    });
    const r2 = await linkArtifact(cwd, {
      feature_code: 'DD-1', artifact_type: 'snapshot', path: 'docs/features/DD-1/snap.md',
    });
    assert.equal(r1.noop, undefined);
    assert.equal(r2.noop, true);

    const f = readFeature(cwd, 'DD-1');
    assert.equal(f.artifacts.length, 1);

    // Only one event despite two writer calls.
    const evs = readEvents(cwd, { tool: 'link_artifact', code: 'DD-1' });
    assert.equal(evs.length, 1);
  });

  test('force overwrites the existing entry and re-emits an event', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'FF-1');
    touch(cwd, 'docs/features/FF-1/snap.md');

    await linkArtifact(cwd, {
      feature_code: 'FF-1', artifact_type: 'snapshot', path: 'docs/features/FF-1/snap.md',
    });
    await linkArtifact(cwd, {
      feature_code: 'FF-1', artifact_type: 'snapshot', path: 'docs/features/FF-1/snap.md',
      status: 'superseded', force: true,
    });

    const f = readFeature(cwd, 'FF-1');
    assert.equal(f.artifacts.length, 1);
    assert.equal(f.artifacts[0].status, 'superseded');

    const evs = readEvents(cwd, { tool: 'link_artifact', code: 'FF-1' });
    assert.equal(evs.length, 2);
    assert.equal(evs[1].forced, true);
  });

  test('idempotency key replays without mutating', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'IK-1');
    touch(cwd, 'docs/features/IK-1/snap.md');

    const r1 = await linkArtifact(cwd, {
      feature_code: 'IK-1', artifact_type: 'snapshot', path: 'docs/features/IK-1/snap.md',
      idempotency_key: 'k1',
    });
    const r2 = await linkArtifact(cwd, {
      feature_code: 'IK-1', artifact_type: 'snapshot', path: 'docs/features/IK-1/snap.md',
      idempotency_key: 'k1',
    });
    assert.deepEqual(r1, r2);
    const evs = readEvents(cwd, { tool: 'link_artifact', code: 'IK-1' });
    assert.equal(evs.length, 1);
  });

  test('rejects missing feature', async () => {
    const cwd = freshCwd();
    touch(cwd, 'docs/orphan/file.md');
    await assert.rejects(
      () => linkArtifact(cwd, {
        feature_code: 'GHOST-1', artifact_type: 's', path: 'docs/orphan/file.md',
      }),
      /not found/
    );
  });

  test('persists optional status field', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'ST-1');
    touch(cwd, 'docs/features/ST-1/snap.md');
    await linkArtifact(cwd, {
      feature_code: 'ST-1', artifact_type: 'snapshot', path: 'docs/features/ST-1/snap.md',
      status: 'historical',
    });
    const f = readFeature(cwd, 'ST-1');
    assert.equal(f.artifacts[0].status, 'historical');
  });
});

// ---------------------------------------------------------------------------
// linkFeatures
// ---------------------------------------------------------------------------

describe('linkFeatures', () => {
  test('creates a directional link on the source feature', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'LF-1');
    await seed(cwd, 'LF-2');
    const r = await linkFeatures(cwd, {
      from_code: 'LF-1', to_code: 'LF-2', kind: 'surfaced_by',
    });
    assert.equal(r.from_code, 'LF-1');
    assert.equal(r.to_code, 'LF-2');
    assert.equal(r.kind, 'surfaced_by');

    const f1 = readFeature(cwd, 'LF-1');
    assert.deepEqual(f1.links, [{ kind: 'surfaced_by', to_code: 'LF-2' }]);

    // Target feature is not mirrored.
    const f2 = readFeature(cwd, 'LF-2');
    assert.equal(f2.links, undefined);
  });

  test('to_code does not need to exist yet', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'LP-1');
    const r = await linkFeatures(cwd, {
      from_code: 'LP-1', to_code: 'NOT-YET-FILED-1', kind: 'follow_up',
    });
    assert.equal(r.to_code, 'NOT-YET-FILED-1');
  });

  test('rejects unknown kind', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'BK-1');
    await assert.rejects(
      () => linkFeatures(cwd, { from_code: 'BK-1', to_code: 'OTHER-1', kind: 'made_up' }),
      /invalid link kind/
    );
  });

  test('rejects self-link', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'SL-1');
    await assert.rejects(
      () => linkFeatures(cwd, { from_code: 'SL-1', to_code: 'SL-1', kind: 'related' }),
      /cannot link a feature to itself/
    );
  });

  test('dedups on (kind, to_code)', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'D-1');
    await seed(cwd, 'D-2');
    const r1 = await linkFeatures(cwd, { from_code: 'D-1', to_code: 'D-2', kind: 'related' });
    const r2 = await linkFeatures(cwd, { from_code: 'D-1', to_code: 'D-2', kind: 'related' });
    assert.equal(r1.noop, undefined);
    assert.equal(r2.noop, true);
    const f = readFeature(cwd, 'D-1');
    assert.equal(f.links.length, 1);
  });

  test('different kinds to same target are separate', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'M-1');
    await seed(cwd, 'M-2');
    await linkFeatures(cwd, { from_code: 'M-1', to_code: 'M-2', kind: 'depends_on' });
    await linkFeatures(cwd, { from_code: 'M-1', to_code: 'M-2', kind: 'related' });
    const f = readFeature(cwd, 'M-1');
    assert.equal(f.links.length, 2);
  });

  test('rejects missing source feature', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => linkFeatures(cwd, { from_code: 'GHOST-1', to_code: 'OTHER-1', kind: 'related' }),
      /not found/
    );
  });
});

// ---------------------------------------------------------------------------
// getFeatureArtifacts
// ---------------------------------------------------------------------------

describe('getFeatureArtifacts', () => {
  test('returns linked artifacts with current existence stamp', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'GA-1');
    touch(cwd, 'docs/features/GA-1/snap.md');
    touch(cwd, 'docs/orphan/note.md');
    await linkArtifact(cwd, { feature_code: 'GA-1', artifact_type: 'snapshot', path: 'docs/features/GA-1/snap.md' });
    await linkArtifact(cwd, { feature_code: 'GA-1', artifact_type: 'finding', path: 'docs/orphan/note.md' });

    const r = await getFeatureArtifacts(cwd, { feature_code: 'GA-1' });
    assert.equal(r.feature_code, 'GA-1');
    assert.equal(r.linked.length, 2);
    assert.ok(r.linked.every(l => l.exists === true));
    assert.ok(r.canonical !== undefined, 'canonical key present (may be null or assessment)');

    // Now delete one and re-check.
    rmSync(join(cwd, 'docs/orphan/note.md'));
    const r2 = await getFeatureArtifacts(cwd, { feature_code: 'GA-1' });
    const finding = r2.linked.find(l => l.type === 'finding');
    assert.equal(finding.exists, false);
  });

  test('returns canonical assessment when feature folder has design.md', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'CA-1');
    // Write a design.md so ArtifactManager has something to assess.
    touch(cwd, 'docs/features/CA-1/design.md',
      '# Design\n## Problem\nA problem.\n## Goal\nA goal that is meaningfully long enough to satisfy the assessor without being overly verbose, and that exists. Multiple sentences here so the word count threshold is met. ' .repeat(15));
    const r = await getFeatureArtifacts(cwd, { feature_code: 'CA-1' });
    assert.ok(r.canonical, 'canonical should be present');
    assert.ok(r.canonical.artifacts || r.canonical.error, 'canonical has assessment or error shape');
  });

  test('returns empty linked array when no artifacts linked', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'GE-1');
    const r = await getFeatureArtifacts(cwd, { feature_code: 'GE-1' });
    assert.deepEqual(r.linked, []);
  });

  test('rejects missing feature', async () => {
    const cwd = freshCwd();
    await assert.rejects(
      () => getFeatureArtifacts(cwd, { feature_code: 'GHOST-1' }),
      /not found/
    );
  });
});

// ---------------------------------------------------------------------------
// getFeatureLinks
// ---------------------------------------------------------------------------

describe('getFeatureLinks', () => {
  test('returns outgoing and incoming by default', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'GL-A');
    await seed(cwd, 'GL-B');
    await seed(cwd, 'GL-C');
    await linkFeatures(cwd, { from_code: 'GL-A', to_code: 'GL-B', kind: 'depends_on' });
    await linkFeatures(cwd, { from_code: 'GL-C', to_code: 'GL-A', kind: 'surfaced_by' });

    const r = await getFeatureLinks(cwd, { feature_code: 'GL-A' });
    assert.equal(r.outgoing.length, 1);
    assert.deepEqual(r.outgoing[0], { kind: 'depends_on', to_code: 'GL-B', note: undefined });
    assert.equal(r.incoming.length, 1);
    assert.deepEqual(r.incoming[0], { kind: 'surfaced_by', from_code: 'GL-C', note: undefined });
  });

  test('direction filter', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'DR-A');
    await seed(cwd, 'DR-B');
    await linkFeatures(cwd, { from_code: 'DR-A', to_code: 'DR-B', kind: 'related' });
    await linkFeatures(cwd, { from_code: 'DR-B', to_code: 'DR-A', kind: 'related' });

    const out = await getFeatureLinks(cwd, { feature_code: 'DR-A', direction: 'outgoing' });
    assert.equal(out.outgoing.length, 1);
    assert.equal(out.incoming, undefined);

    const inc = await getFeatureLinks(cwd, { feature_code: 'DR-A', direction: 'incoming' });
    assert.equal(inc.incoming.length, 1);
    assert.equal(inc.outgoing, undefined);
  });

  test('kind filter applied to both directions', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'KF-A');
    await seed(cwd, 'KF-B');
    await seed(cwd, 'KF-C');
    await linkFeatures(cwd, { from_code: 'KF-A', to_code: 'KF-B', kind: 'depends_on' });
    await linkFeatures(cwd, { from_code: 'KF-A', to_code: 'KF-C', kind: 'related' });
    await linkFeatures(cwd, { from_code: 'KF-B', to_code: 'KF-A', kind: 'depends_on' });

    const r = await getFeatureLinks(cwd, { feature_code: 'KF-A', kind: 'depends_on' });
    assert.equal(r.outgoing.length, 1);
    assert.equal(r.outgoing[0].to_code, 'KF-B');
    assert.equal(r.incoming.length, 1);
    assert.equal(r.incoming[0].from_code, 'KF-B');
  });

  test('returns empty arrays when no links exist', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'EM-1');
    const r = await getFeatureLinks(cwd, { feature_code: 'EM-1' });
    assert.deepEqual(r.outgoing, []);
    assert.deepEqual(r.incoming, []);
  });

  test('rejects invalid direction with a clear error', async () => {
    const cwd = freshCwd();
    await seed(cwd, 'BD-1');
    await assert.rejects(
      () => getFeatureLinks(cwd, { feature_code: 'BD-1', direction: 'sideways' }),
      /invalid direction/
    );
  });
});
