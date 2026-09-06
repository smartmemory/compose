/**
 * test/fluid-ideabox-dialect.test.js — COMP-IDEABOX-MIGRATE-DIALECT.
 *
 * The migration gate exists to stop the first `ideabox add` in an upgraded
 * project from replacing that project's whole ideabox with the one idea just
 * typed. It was doing the opposite of its job: it recognised only the NEW
 * dialect, so it protected the files that were never at risk and waved through
 * every file that was.
 *
 * The fixture is a REAL flat-dialect ideabox (forge-top's, 18 ideas), retained
 * under docs/bugs/. Following this suite's existing rule: a synthetic fixture
 * would pass while a real document lost content — which is exactly what
 * happened here, since the pre-existing migration test runs against compose's
 * own already-converted ideabox and therefore never saw the bug.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseIdeabox } from '../lib/ideabox.js';
import { LocalFluidProvider } from '../lib/fluid/local-provider.js';
import { ensureIdeaboxMigrated, IdeaboxMigrationConflict } from '../lib/fluid/ideabox-migrate.js';
import { ideaboxContext, addIdea } from '../lib/fluid/ideabox-ops.js';

const FLAT = readFileSync(
  new URL('../docs/bugs/COMP-IDEABOX-MIGRATE-DIALECT/repro/flat-dialect-fixture.md', import.meta.url),
  'utf8',
);
const NESTED = readFileSync(new URL('../docs/product/ideabox.md', import.meta.url), 'utf8');

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ideabox-dialect-'));
  mkdirSync(join(root, 'docs', 'product'), { recursive: true });
  mkdirSync(join(root, '.compose'), { recursive: true });
  writeFileSync(join(root, '.compose', 'compose.json'), JSON.stringify({ workspaceId: 'dialecttest' }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ideaboxPath = () => join(root, 'docs', 'product', 'ideabox.md');
const writeIdeabox = (md) => writeFileSync(ideaboxPath(), md);
const freshProvider = () => new LocalFluidProvider().init(root);

describe('COMP-IDEABOX-MIGRATE-DIALECT — the legacy flat dialect', () => {
  it('parses flat-dialect ideas instead of silently returning none', () => {
    const parsed = parseIdeabox(FLAT);
    assert.equal(parsed.ideas.length, 18, 'every ### IDEA- heading must be read as an idea');
    const ids = parsed.ideas.map((i) => i.id);
    assert.ok(ids.includes('IDEA-1'), 'IDEA-1 must survive the parse');
    assert.ok(ids.includes('IDEA-18'), 'IDEA-18 must survive the parse');
  });

  it('carries flat-dialect field lines through the parse', () => {
    const parsed = parseIdeabox(FLAT);
    const idea2 = parsed.ideas.find((i) => i.id === 'IDEA-2');
    assert.ok(idea2, 'IDEA-2 present');
    assert.equal(idea2.status, 'NEW');
    assert.ok(idea2.title.length > 0, 'title captured');
    assert.ok(idea2.description.length > 0, 'the **Idea:** body is not dropped');
  });

  it('does NOT change how a new-dialect ideabox parses', () => {
    const parsed = parseIdeabox(NESTED);
    assert.equal(parsed.ideas.length, 32, 'the nested dialect still yields its 32 ideas');
    assert.ok(parsed.clusters.length >= 7, 'umbrellas still captured');
    assert.ok(parsed.ideas.every((i) => i.cluster), 'nested ideas keep their umbrella');
  });

  it('migrates a flat-dialect ideabox into an empty store', async () => {
    writeIdeabox(FLAT);
    const provider = await freshProvider();
    const res = await ensureIdeaboxMigrated(provider, ideaboxPath());
    assert.equal(res.migrated, true, 'the upgrade path must actually fire');
    // `imported` carries clusters as well as ideas (import-ideabox.js:101), so
    // assert on the two populations rather than one total that hides both.
    assert.equal((await provider.listRecords({ kind: 'idea' })).length, 18, 'every idea imported');
    assert.equal(
      (await provider.listRecords({ kind: 'cluster' })).length, 10,
      'each legacy topic heading became an umbrella',
    );
    assert.equal(res.imported.length, 28, 'and both populations are reported');
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — an unreadable ideabox must refuse, never proceed', () => {
  it('refuses when a file carrying IDEA- tokens parses to zero ideas', async () => {
    // A dialect neither parser understands. The point is that "I could not read
    // this" must never be reported as "there was nothing to read".
    writeIdeabox('# Ideas\n\n* IDEA-1: something valuable\n* IDEA-2: also valuable\n');
    const provider = await freshProvider();
    await assert.rejects(
      () => ensureIdeaboxMigrated(provider, ideaboxPath()),
      (err) => err instanceof IdeaboxMigrationConflict || err?.code === 'IDEABOX_UNREADABLE',
      'an unrecognised non-empty ideabox must stop the command',
    );
  });

  it('still proceeds silently for a genuinely empty ideabox', async () => {
    writeIdeabox('# Ideabox\n\n## Ideas\n\n## Killed Ideas\n');
    const provider = await freshProvider();
    const res = await ensureIdeaboxMigrated(provider, ideaboxPath());
    assert.equal(res.migrated, false);
    assert.equal(res.imported.length, 0);
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — the clobber regression', () => {
  it('a first add against a flat-dialect ideabox does not destroy it', async () => {
    writeIdeabox(FLAT);
    const ctx = await ideaboxContext(root);
    await addIdea(ctx, { title: 'CANARY — typed by an upgrading user' });

    const after = parseIdeabox(readFileSync(ideaboxPath(), 'utf8'));
    assert.equal(after.ideas.length, 19, 'the 18 originals survive alongside the new one');
    assert.ok(
      after.ideas.some((i) => i.title.startsWith('CANARY')),
      'the new idea was saved',
    );
    assert.equal(
      after.ideas.filter((i) => i.id === 'IDEA-1').length, 1,
      'the new idea must not reuse IDEA-1',
    );
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — migration must be lossless', () => {
  // `import-ideabox.js` already carries a comment saying a dropped field is
  // "deleted from the user's file on upgrade, silently, with no way back". It
  // then fixed `effort` and `impact` and left the general case: any
  // hand-authored field the parser did not recognise lands in `_extraLines`
  // and was dropped on the floor. The retained fixture has one — IDEA-16's
  // `**Triage (2026-07-24):**` paragraph — so the upgrade path this bug is
  // about was ALSO quietly lossy for the very file that motivated it.
  it('carries hand-authored custom fields through import and back out', async () => {
    writeIdeabox(FLAT);
    const provider = await freshProvider();
    const res = await ensureIdeaboxMigrated(provider, ideaboxPath());
    assert.equal(res.migrated, true);

    const records = await provider.listRecords({ kind: 'idea' });
    const idea16 = records.find((r) => r.handle === 'IDEA-16');
    assert.ok(idea16, 'IDEA-16 imported');
    assert.ok(
      (idea16.extra_fields ?? []).some((l) => l.includes('Triage (2026-07-24)')),
      'the custom Triage field survives the import',
    );

    const { writeIdeaboxProjection } = await import('../lib/fluid/render-ideabox.js');
    await writeIdeaboxProjection(provider, ideaboxPath());
    assert.ok(
      readFileSync(ideaboxPath(), 'utf8').includes('Triage (2026-07-24)'),
      'and is written back out, not deleted from the user file on upgrade',
    );
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — the guard must not fail the way the parser fails', () => {
  // Codex review, finding 2. The first guard required a ` — ` separator to
  // recognise a declaration — the same punctuation the PARSER requires. So a
  // heading neither could read declared nothing and parsed to nothing, the two
  // agreed the file was empty, and the guard permitted the write it existed to
  // stop. A detector that fails in the same direction as the thing it checks is
  // not a check.
  it('refuses a heading the parser cannot read even without the dash separator', async () => {
    writeIdeabox('## Some topic\n\n### IDEA-1 A valuable idea with no dash\n');
    const provider = await freshProvider();
    await assert.rejects(() => ensureIdeaboxMigrated(provider, ideaboxPath()),
      (e) => e.code === 'IDEABOX_UNREADABLE');
  });

  it('refuses an indented idea heading rather than reading it as absent', async () => {
    writeIdeabox('## Some topic\n\n  ### IDEA-1 — Indented and invisible\n');
    const provider = await freshProvider();
    await assert.rejects(() => ensureIdeaboxMigrated(provider, ideaboxPath()),
      (e) => e.code === 'IDEABOX_UNREADABLE');
  });

  // Codex review, finding 2 (second half). The half-converted document.
  it('refuses a file declaring the same id in both dialects', async () => {
    writeIdeabox([
      '# Ideabox', '', '## Ideas', '', '### Unclustered', '',
      '#### IDEA-1 — Converted, thin', '**Status:** NEW | **Priority:** —', '',
      '## Leftovers', '', '### IDEA-1 — Original, with much more detail', '**Status:** NEW',
    ].join('\n'));
    const provider = await freshProvider();
    await assert.rejects(() => ensureIdeaboxMigrated(provider, ideaboxPath()),
      (e) => e.code === 'IDEABOX_UNREADABLE',
      'the richer duplicate must not be silently dropped');
  });

  // Codex review, finding 5.
  it('does not let a topic named "Ideas for Later" disable the legacy dialect', () => {
    const parsed = parseIdeabox('# Box\n\n## Ideas for Later\n\n### IDEA-1 — Still readable\n');
    assert.equal(parsed.ideas.length, 1, 'a prefix match must not switch dialects');
  });

  it('ignores a fenced example when choosing the dialect', () => {
    const parsed = parseIdeabox(
      '# Box\n\n```markdown\n## Ideas\n#### IDEA-99 — an example\n```\n\n## Real topic\n\n### IDEA-1 — Real\n',
    );
    assert.equal(parsed.ideas.length, 1);
    assert.equal(parsed.ideas[0].id, 'IDEA-1', 'the example must not be imported as an idea');
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — the upgrade must not eat the document around the ideas', () => {
  // Codex review, finding 4. Legacy mode starts inside the ideas section, so
  // the ordinary preamble collector never ran and the document's own title and
  // introduction were dropped by the first render after migration. Its ten
  // topic headings, meanwhile, piled up at the top detached from their ideas.
  it('keeps the document title and introduction', () => {
    const parsed = parseIdeabox(FLAT);
    const preamble = parsed.preamble ?? '';
    const text = Array.isArray(preamble) ? preamble.join('\n') : preamble;
    assert.ok(text.includes('Forge Ideabox'), 'the document title survives the parse');
  });

  it('preserves the author grouping by mapping topic headings to clusters', () => {
    const parsed = parseIdeabox(FLAT);
    assert.ok(parsed.clusters.length >= 8, `topic headings become clusters (got ${parsed.clusters.length})`);
    const idea1 = parsed.ideas.find((i) => i.id === 'IDEA-1');
    assert.equal(idea1.cluster, 'Compose Lifecycle Variants', 'an idea keeps the topic it was filed under');
  });

  // The projection-side counterpart of this — keeping the project's own title
  // through the render — is deferred as FU-4: it needs the preamble to become
  // canon, because reading it from the destination breaks `render` as a repair
  // path (test/fluid-cutover.test.js:636).

  it('is a fixed point: rendering twice changes nothing', async () => {
    // The projection must be a fixed point of the serializer, or every write
    // reorders the file. The preamble carry-forward reads the file it is about
    // to replace, which is exactly the kind of change that can break this.
    writeIdeabox(FLAT);
    const provider = await freshProvider();
    await ensureIdeaboxMigrated(provider, ideaboxPath());
    const { writeIdeaboxProjection } = await import('../lib/fluid/render-ideabox.js');
    await writeIdeaboxProjection(provider, ideaboxPath());
    const once = readFileSync(ideaboxPath(), 'utf8');
    await writeIdeaboxProjection(provider, ideaboxPath());
    assert.equal(readFileSync(ideaboxPath(), 'utf8'), once, 'a second render is byte-identical');
  });

  it('round-trips a migrated legacy document without losing its ideas', async () => {
    writeIdeabox(FLAT);
    const provider = await freshProvider();
    await ensureIdeaboxMigrated(provider, ideaboxPath());
    const { writeIdeaboxProjection } = await import('../lib/fluid/render-ideabox.js');
    await writeIdeaboxProjection(provider, ideaboxPath());
    const after = parseIdeabox(readFileSync(ideaboxPath(), 'utf8'));
    assert.equal(after.ideas.length, 18, 'all 18 ideas survive the migration and the render');
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — the hybrid dialect (H3 ideas under a modern wrapper)', () => {
  // A third vintage found by surveying every ideabox on this machine: the
  // modern `## Ideas` wrapper, but ideas AND umbrellas both written at H3.
  // Modern mode read every `### IDEA-N` as an umbrella named after an idea, so
  // the document parsed to zero ideas and — before the guard — was destroyed.
  const HYBRID = [
    '# Box', '', '## Ideas', '',
    '### Scale & Responsiveness', '',
    '### IDEA-1 — Background jobs', '**Status:** NEW | **Priority:** P1', '',
    '### IDEA-2 — Virtualized lists', '**Status:** NEW | **Priority:** —', '',
    '### Review Queue', '',
    '### IDEA-3 — Filtering knobs', '**Status:** NEW | **Priority:** —',
  ].join('\n');

  it('reads H3 ideas without mistaking them for umbrellas', () => {
    const parsed = parseIdeabox(HYBRID);
    assert.equal(parsed.ideas.length, 3);
    assert.deepEqual(parsed.ideas.map((i) => i.id), ['IDEA-1', 'IDEA-2', 'IDEA-3']);
  });

  it('still reads the real umbrellas at the same level', () => {
    const parsed = parseIdeabox(HYBRID);
    const names = parsed.clusters.map((c) => c.name);
    assert.ok(names.includes('Scale & Responsiveness'), 'a non-idea H3 is still an umbrella');
    assert.ok(!names.some((n) => n.startsWith('IDEA-')), 'no umbrella is named after an idea');
    assert.equal(parsed.ideas.find((i) => i.id === 'IDEA-3').cluster, 'Review Queue');
  });

  it('migrates a hybrid ideabox rather than refusing it', async () => {
    writeIdeabox(HYBRID);
    const provider = await freshProvider();
    const res = await ensureIdeaboxMigrated(provider, ideaboxPath());
    assert.equal(res.migrated, true);
    assert.equal((await provider.listRecords({ kind: 'idea' })).length, 3);
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — a hand edit between mutation and projection', () => {
  // Moving the guard into `writeIdeaboxProjection` raised the question of
  // whether a mutation could now write its record and THEN have its projection
  // refused, reporting a successful write as a failure. It cannot: every
  // mutating op runs the gate BEFORE it writes (`ideabox-ops.js`, invariant 1),
  // so an unreadable file stops the command with nothing written and no partial
  // state. Pinned because the reasoning is not obvious from either call site,
  // and because a future refactor that writes before projecting would break it
  // silently.
  it('refuses cleanly, writing no record at all', async () => {
    writeIdeabox('# Ideabox\n\n## Ideas\n\n## Killed Ideas\n');
    const ctx = await ideaboxContext(root);
    await addIdea(ctx, { title: 'First' });

    // A hand edit the parser cannot read.
    writeIdeabox('## Salvage\n\n### IDEA-9 Hand typed with no dash\n');

    let err = null;
    try { await addIdea(ctx, { title: 'Second' }); } catch (e) { err = e; }
    assert.equal(err?.code, 'IDEABOX_UNREADABLE', 'the unreadable file stops the command');

    const provider = await freshProvider();
    const handles = (await provider.listRecords({ kind: 'idea' })).map((r) => r.handle);
    assert.deepEqual(handles, ['IDEA-1'], 'the refused mutation left no record behind');
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — round-2 defects, all introduced by the round-1 fixes', () => {
  // Codex round 2, finding A. Fenced blocks were skipped when CHOOSING the
  // dialect and when counting declarations, but not by the parse loop itself.
  // So a fenced example was imported as a real idea — and worse, it satisfied
  // the readability guard on behalf of a genuine entry with the same id that
  // the parser could not read, letting the destructive write through.
  it('does not import an idea out of a fenced example', () => {
    const parsed = parseIdeabox([
      '# Box', '', '## Ideas', '', '### Unclustered', '',
      '```markdown', '#### IDEA-1 — Only an example in the docs', '```', '',
    ].join('\n'));
    assert.equal(parsed.ideas.length, 0, 'an example is documentation, not an idea');
  });

  it('a fenced example cannot vouch for an unreadable real entry with the same id', async () => {
    writeIdeabox([
      '# Box', '', '## Ideas', '', '### Unclustered', '',
      '```markdown', '#### IDEA-1 — Example showing the format', '```', '',
      '## Real ideas', '', '### IDEA-1 A real one the parser cannot read',
    ].join('\n'));
    const provider = await freshProvider();
    await assert.rejects(() => ensureIdeaboxMigrated(provider, ideaboxPath()),
      (e) => e.code === 'IDEABOX_UNREADABLE');
  });

  // Codex round 2, finding B. The new legacy `## Topic` → cluster branch set the
  // cluster but never cleared `inKilledSection`, so every idea under a topic
  // heading that happened to follow `## Killed Ideas` was imported as killed.
  it('a legacy topic after Killed Ideas does not bury live ideas as killed', () => {
    const parsed = parseIdeabox([
      '# Box', '', '## Killed Ideas', '', '### IDEA-1 — Genuinely dead',
      '**Status:** KILLED', '',
      '## Fresh thinking', '', '### IDEA-2 — Very much alive', '**Status:** NEW',
    ].join('\n'));
    assert.deepEqual(parsed.killed.map((i) => i.id), ['IDEA-1'], 'only the killed one is killed');
    assert.deepEqual(parsed.ideas.map((i) => i.id), ['IDEA-2'], 'the live one stays live');
  });

  // Codex round 2, finding C. `serializeKilledIdea` puts unrecognised fields
  // AFTER `**Killed:**`; the live serializer puts them BEFORE `**Maps to:**`.
  // The projection emitted the live order for both, so a killed idea carrying a
  // custom field reordered the file on every write and the projection stopped
  // being a fixed point of the serializer.
  it('keeps the fixed point for a KILLED idea carrying a custom field', async () => {
    writeIdeabox([
      '# Box', '', '## Ideas', '', '## Killed Ideas', '',
      '#### IDEA-1 — Dead but annotated',
      '**Status:** KILLED',
      '**Idea:** the body',
      '**Killed:** 2026-01-01 — no longer needed',
      '**Rationale (long form):** a hand-authored field the parser does not know',
    ].join('\n'));
    const provider = await freshProvider();
    await ensureIdeaboxMigrated(provider, ideaboxPath());
    const { writeIdeaboxProjection } = await import('../lib/fluid/render-ideabox.js');
    await writeIdeaboxProjection(provider, ideaboxPath());
    const projection = readFileSync(ideaboxPath(), 'utf8');
    assert.ok(projection.includes('Rationale (long form)'), 'the custom field survived at all');

    // The real fixed point, and the one the cutover rests on. Rendering twice
    // from an unchanged store is identical by construction and proves nothing —
    // the property is that the SERIALIZER reproduces the projection, so the
    // fields have to sit where the serializer puts them.
    const { serializeIdeabox } = await import('../lib/ideabox.js');
    const reparsed = parseIdeabox(projection);
    const reserialized = serializeIdeabox({
      ideas: reparsed.ideas,
      killed: reparsed.killed,
      clusters: reparsed.clusters,
      preamble: reparsed.preamble,
    });
    assert.equal(reserialized, projection, 'serialize(parse(projection)) must be the identity');
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — round-2 defect D: a cluster may legitimately be named after an idea', () => {
  // Codex round 2. `compose ideabox` will create a cluster called
  // `IDEA-9 — Cache research`. Reading every H3 that starts with an id as an
  // idea meant the tool could not round-trip its OWN output: the add succeeded,
  // and the next command refused because the guard saw a declared id with no
  // record behind it. A document containing any `#### IDEA-` heading has been
  // written by the tools and is modern, so its H3s are umbrellas whatever they
  // are called.
  it('reads an idea-named umbrella as an umbrella in a modern document', () => {
    const parsed = parseIdeabox([
      '# Box', '', '## Ideas', '',
      '### IDEA-9 — Cache research', '',
      '#### IDEA-1 — A real idea', '**Status:** NEW | **Priority:** —',
    ].join('\n'));
    assert.deepEqual(parsed.ideas.map((i) => i.id), ['IDEA-1'], 'only the H4 is an idea');
    assert.ok(
      parsed.clusters.some((c) => c.name === 'IDEA-9 — Cache research'),
      'the idea-named umbrella stays an umbrella',
    );
  });

  it('still reads the hybrid dialect, which has no H4 ideas at all', () => {
    const parsed = parseIdeabox([
      '# Box', '', '## Ideas', '', '### Real umbrella', '',
      '### IDEA-1 — A hybrid idea', '**Status:** NEW',
    ].join('\n'));
    assert.deepEqual(parsed.ideas.map((i) => i.id), ['IDEA-1']);
    assert.ok(parsed.clusters.some((c) => c.name === 'Real umbrella'));
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — round-2 defect E: a typed field must not be carried as an opaque one', () => {
  // Codex round 2. The legacy parser does not know `**Promoted to:**`, so it
  // lands in `_extraLines`. Carrying that verbatim put it beyond the reach of
  // `promoteIdea`, which filters stale `promoted_to` links before adding the
  // new one — so a later promotion rendered BOTH the old target and the current
  // one, with nothing to say which was true.
  const WITH_PROMOTION = [
    '## Shipped work', '',
    '### IDEA-1 — Already promoted once',
    '**Status:** PROMOTED',
    '**Idea:** the body',
    '**Promoted to:** OLD-TARGET-1',
  ].join('\n');

  it('imports a hand-written promotion as a typed link, not an extra', async () => {
    writeIdeabox(WITH_PROMOTION);
    const provider = await freshProvider();
    await ensureIdeaboxMigrated(provider, ideaboxPath());
    const [idea] = await provider.listRecords({ kind: 'idea' });
    assert.equal(idea.links.find((l) => l.type === 'promoted_to')?.target, 'OLD-TARGET-1');
    assert.ok(
      !(idea.extra_fields ?? []).some((l) => l.includes('Promoted to')),
      'and is not ALSO carried as an unrecognised field',
    );
  });

  it('renders exactly one promotion target after a re-promotion', async () => {
    writeIdeabox(WITH_PROMOTION);
    const ctx = await ideaboxContext(root);
    await ensureIdeaboxMigrated(ctx.provider, ctx.ideaboxPath);
    const { promoteIdea } = await import('../lib/fluid/ideabox-ops.js');
    await promoteIdea(ctx, 'IDEA-1', 'NEW-TARGET-2');

    const text = readFileSync(ideaboxPath(), 'utf8');
    const targets = [...text.matchAll(/\*\*Promoted to:\*\*/g)];
    assert.equal(targets.length, 1, 'one promotion line, not the stale one alongside the current');
    assert.ok(text.includes('NEW-TARGET-2'), 'and it is the current target');
    assert.ok(!text.includes('OLD-TARGET-1'), 'the superseded target is gone');
  });
});

describe('COMP-IDEABOX-MIGRATE-DIALECT — round-2 follow-ons', () => {
  // Finding 1. The fence SKIP kept the enclosed lines and dropped the markers,
  // so a fenced example inside an idea's body was written back unfenced — and
  // became a real heading that the next render then refused.
  it('keeps a fenced example inside an idea fenced across a round trip', async () => {
    writeIdeabox([
      '# Box', '', '## Ideas', '', '### Unclustered', '',
      '#### IDEA-1 — Documents the format',
      '**Status:** NEW | **Priority:** —',
      '**Idea:** see below',
      '```markdown',
      '#### IDEA-2 — Only an example',
      '```',
    ].join('\n'));
    const provider = await freshProvider();
    await ensureIdeaboxMigrated(provider, ideaboxPath());
    const { writeIdeaboxProjection } = await import('../lib/fluid/render-ideabox.js');
    await writeIdeaboxProjection(provider, ideaboxPath());

    const after = parseIdeabox(readFileSync(ideaboxPath(), 'utf8'));
    assert.equal(after.ideas.length, 1, 'the example did not become a second idea');
    assert.ok(readFileSync(ideaboxPath(), 'utf8').includes('```'), 'the fence markers survived');

    // And the projection is stable, rather than refusing the file it just wrote.
    await writeIdeaboxProjection(provider, ideaboxPath());
    assert.equal(parseIdeabox(readFileSync(ideaboxPath(), 'utf8')).ideas.length, 1);
  });

  // Finding 2. Dialect detection required a complete `## Ideas` heading while
  // the section branches still prefix-matched, so the two disagreed.
  it('does not treat "## Ideas for Later" as the ideas section', () => {
    const parsed = parseIdeabox([
      '# Box', '', '## Ideas for Later', '', '### IDEA-1 — Under a topic', '**Status:** NEW',
    ].join('\n'));
    assert.equal(parsed.ideas.length, 1);
    assert.equal(parsed.ideas[0].cluster, 'Ideas for Later', 'the grouping is not lost');
  });

  it('does not file live ideas as killed under "## Killed Ideas for Later"', () => {
    const parsed = parseIdeabox([
      '# Box', '', '## Killed Ideas for Later', '', '### IDEA-1 — Alive', '**Status:** NEW',
    ].join('\n'));
    assert.deepEqual(parsed.killed, [], 'a topic that merely starts with the words is not that section');
    assert.deepEqual(parsed.ideas.map((i) => i.id), ['IDEA-1']);
  });

  // Finding 3. The parser was taught that an idea-named umbrella is an umbrella,
  // but the guard was still scanning the raw text and refusing on it.
  it('accepts a document whose umbrella is named after an idea', async () => {
    writeIdeabox([
      '# Box', '', '## Ideas', '', '### IDEA-9 — Cache research', '',
      '#### IDEA-1 — A real idea', '**Status:** NEW | **Priority:** —',
    ].join('\n'));
    const provider = await freshProvider();
    const res = await ensureIdeaboxMigrated(provider, ideaboxPath());
    assert.equal(res.migrated, true, 'the tool must be able to read back its own output');
  });

  // Finding 4. A reference to an idea inside another idea's body is not a
  // declaration of it, and counting it as one refused readable documents.
  it('does not treat a reference bullet in a body as a second declaration', async () => {
    writeIdeabox([
      '# Box', '', '## Ideas', '', '### Unclustered', '',
      '#### IDEA-1 — Needs follow-up',
      '**Status:** NEW | **Priority:** —',
      '**Idea:** depends on other work',
      '- IDEA-1 needs research before it can start',
    ].join('\n'));
    const provider = await freshProvider();
    const res = await ensureIdeaboxMigrated(provider, ideaboxPath());
    assert.equal(res.migrated, true, 'a mention is not a declaration');
  });
});
