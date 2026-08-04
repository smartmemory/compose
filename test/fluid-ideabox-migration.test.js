/**
 * test/fluid-ideabox-migration.test.js — COMP-PLAN-IDEA-UNIFY S2 gate.
 *
 * This file is the migration's safety gate. It runs against the REAL
 * `docs/product/ideabox.md`, not a fixture, because the risk being defended
 * against is specific to the real document: it carries hand-authored umbrella
 * themes, bare-word tags, a custom convention bullet and a free-form status
 * token, and a projection that cannot reproduce them would clobber them on the
 * first regeneration — the failure `roadmap generate` already has.
 *
 * A synthetic fixture would pass while the real file lost content.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseIdeabox } from '../lib/ideabox.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { importIdeabox } from '../lib/fluid/import-ideabox.js';
import { renderIdeaboxFrom, renderIdeabox } from '../lib/fluid/render-ideabox.js';

const REAL_PATH = new URL('../docs/product/ideabox.md', import.meta.url);
const REAL = readFileSync(REAL_PATH, 'utf8');
const SOURCE = parseIdeabox(REAL);

let root;

async function freshProvider() {
  return new LocalFluidProvider().init(root);
}

/** Import the real ideabox into a clean provider. */
async function imported() {
  const p = await freshProvider();
  const result = await importIdeabox(p, { markdown: REAL });
  return { p, result };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fluid-migrate-'));
  mkdirSync(join(root, '.compose', 'data'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ideabox migration — nothing is lost', () => {
  it('imports every idea in the real document', async () => {
    const { p } = await imported();
    const records = await p.listRecords({ kind: 'idea' });
    assert.equal(records.length, SOURCE.ideas.length + SOURCE.killed.length);
  });

  it('preserves every IDEA-N handle verbatim, never reallocating', async () => {
    // Handles are external citations — IDEA-20 is quoted in the substrate
    // ruling. Renumbering during migration would invalidate every reference in
    // docs, commits and conversation, silently.
    const { p } = await imported();
    const got = new Set((await p.listRecords({ kind: 'idea' })).map((r) => r.handle));
    for (const idea of [...SOURCE.ideas, ...SOURCE.killed]) {
      assert.ok(got.has(idea.id), `${idea.id} did not survive the import`);
    }
  });

  it('preserves title, description, tags, source and priority for every idea', async () => {
    const { p } = await imported();
    for (const idea of SOURCE.ideas) {
      const rec = await p.getRecord(idea.id);
      assert.equal(rec.title, idea.title, `${idea.id} title`);
      assert.equal(rec.body, idea.description ?? '', `${idea.id} description`);
      assert.deepEqual(rec.tags, idea.tags ?? [], `${idea.id} tags`);
      assert.equal(rec.source, idea.source || null, `${idea.id} source`);
      const expectedPriority = /^P[012]$/.test(idea.priority) ? idea.priority : null;
      assert.equal(rec.priority, expectedPriority, `${idea.id} priority`);
    }
  });

  it('preserves every umbrella Theme paragraph verbatim', async () => {
    // The reason `cluster` is a record kind rather than a string label.
    const { p } = await imported();
    const clusters = await p.listRecords({ kind: 'cluster' });
    const themed = SOURCE.clusters.filter((c) => c.theme);
    assert.ok(themed.length >= 5, 'source themes missing — the parser regressed');

    for (const src of themed) {
      const rec = clusters.find((c) => c.title === src.name);
      assert.ok(rec, `cluster "${src.name}" was not imported`);
      assert.equal(rec.body, src.theme, `theme prose for "${src.name}" was altered`);
    }
  });

  it('assigns every idea to the cluster it was under, by handle', async () => {
    const { p } = await imported();
    const clusters = await p.listRecords({ kind: 'cluster' });
    const nameOf = new Map(clusters.map((c) => [c.handle, c.title]));

    for (const idea of SOURCE.ideas.filter((i) => i.cluster)) {
      const rec = await p.getRecord(idea.id);
      assert.equal(nameOf.get(rec.cluster), idea.cluster, `${idea.id} cluster`);
    }
  });

  it('keeps cluster ordering', async () => {
    const { p } = await imported();
    const clusters = await p.listRecords({ kind: 'cluster' });
    const ordered = [...clusters].sort((a, b) => a.cluster_order - b.cluster_order);
    assert.deepEqual(ordered.map((c) => c.title), SOURCE.clusters.map((c) => c.name));
  });

  it('keeps a free-form status token the canonical enum cannot hold', async () => {
    // IDEA-20's status is `RE-AIMED (2026-07-21)`. A closed enum would flatten
    // it to NEW and the label would be gone from the rendered file.
    const withLabel = SOURCE.ideas.filter((i) => !['NEW', 'DISCUSSING', 'PROMOTED', 'KILLED'].includes(i.status));
    assert.ok(withLabel.length > 0, 'expected at least one free-form status in the real file');

    const { p } = await imported();
    for (const idea of withLabel) {
      const rec = await p.getRecord(idea.id);
      assert.equal(rec.status_label, idea.status, `${idea.id} lost its status label`);
    }
  });

  it('stamps every imported record as imported, permanently', async () => {
    const { p } = await imported();
    for (const rec of await p.listRecords()) {
      assert.equal(rec.provenance.origin, 'import:ideabox', `${rec.handle} provenance`);
    }
  });
});

describe('ideabox migration — the projection', () => {
  it('renders every idea and every theme back into the markdown', async () => {
    const { p } = await imported();
    const out = await renderIdeaboxFrom(p);

    for (const idea of SOURCE.ideas) {
      assert.ok(out.includes(`#### ${idea.id} — ${idea.title}`), `${idea.id} heading missing`);
      if (idea.description) assert.ok(out.includes(idea.description), `${idea.id} description missing`);
      for (const tag of idea.tags) {
        assert.ok(new RegExp(`\\*\\*Tags:\\*\\*[^\\n]*\\b${tag.replace(/[#-]/g, '\\$&')}`).test(out),
          `${idea.id} tag ${tag} missing`);
      }
    }
    for (const cluster of SOURCE.clusters) {
      assert.ok(out.includes(`### ${cluster.name}`), `cluster ${cluster.name} missing`);
      if (cluster.theme) assert.ok(out.includes(`**Theme:** ${cluster.theme}`), `theme for ${cluster.name} missing`);
    }
  });

  it('survives a full markdown → records → markdown → records cycle without drift', async () => {
    // The real fidelity question: does the projection parse back to the same
    // ideas? If it does not, the second regeneration loses what the first kept.
    const { p } = await imported();
    const out = await renderIdeaboxFrom(p);
    const reparsed = parseIdeabox(out);

    assert.equal(reparsed.ideas.length, SOURCE.ideas.length);
    for (const idea of SOURCE.ideas) {
      const back = reparsed.ideas.find((i) => i.id === idea.id);
      assert.ok(back, `${idea.id} vanished through the projection`);
      assert.equal(back.title, idea.title);
      assert.equal(back.description, idea.description);
      assert.deepEqual(back.tags, idea.tags);
      assert.equal(back.cluster, idea.cluster);
    }
    for (const cluster of SOURCE.clusters.filter((c) => c.theme)) {
      const back = reparsed.clusters.find((c) => c.name === cluster.name);
      assert.equal(back.theme, cluster.theme, `theme drifted for ${cluster.name}`);
    }
  });

  it('is deterministic — rendering twice gives identical bytes', async () => {
    // Otherwise the file churns in git on every unrelated write.
    const { p } = await imported();
    assert.equal(await renderIdeaboxFrom(p), await renderIdeaboxFrom(p));
  });

  it('renders from records alone, never consulting the existing markdown', async () => {
    // Reading the old file to decide what to write is what turns a projection
    // back into a second source.
    const out = renderIdeabox({
      ideas: [{
        handle: 'IDEA-1', kind: 'idea', title: 'only record', body: '', status: 'new',
        priority: null, cluster: null, tags: [], links: [], discussion: [],
      }],
      clusters: [],
    });
    assert.ok(out.includes('#### IDEA-1 — only record'));
    // Nothing from the real document leaked in.
    assert.ok(!out.includes('Umbrella A'));
  });

  it('marks the output as generated', async () => {
    const { p } = await imported();
    assert.match(await renderIdeaboxFrom(p), /GENERATED FILE — DO NOT EDIT/);
  });
});

describe('ideabox migration — import-once', () => {
  it('is idempotent: a re-run imports nothing and duplicates nothing', async () => {
    const { p, result } = await imported();
    assert.ok(result.imported.length > 0);

    const again = await importIdeabox(p, { markdown: REAL });
    assert.equal(again.imported.length, 0, 're-import created records');
    assert.ok(again.alreadyImported);

    const records = await p.listRecords({ kind: 'idea' });
    assert.equal(records.length, SOURCE.ideas.length + SOURCE.killed.length);
  });

  it('does not overwrite an edit made after the import', async () => {
    // Re-running the migration must not act as a reverse sync from markdown —
    // that is the two-way bridge this epic exists to eliminate.
    const { p } = await imported();
    await p.updateRecord('IDEA-1', { title: 'edited through the tools' });

    await importIdeabox(p, { markdown: REAL });

    assert.equal((await p.getRecord('IDEA-1')).title, 'edited through the tools');
  });

  it('reports a plan without writing when dryRun is set', async () => {
    const p = await freshProvider();
    const plan = await importIdeabox(p, { markdown: REAL, dryRun: true });
    assert.ok(plan.imported.length > 0);
    assert.equal((await p.listRecords()).length, 0, 'dry run wrote records');
  });
});
