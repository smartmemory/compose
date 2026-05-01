import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import {
  slugify,
  shouldEmitSections,
  parseTaskBlocks,
  extractSectionFiles,
  emitSections,
  appendTrailers,
} from '../lib/sections.js';

function withEnv(value, fn) {
  const prev = process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD;
  if (value === undefined) delete process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD;
  else process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD;
    else process.env.COMPOSE_PLAN_SECTIONS_THRESHOLD = prev;
  }
}

function tmpFeatureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'compose-sections-'));
}

// ----- slugify -----

test('slugify: lowercase + dashes for non-alphanumeric runs', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('Foo  bar__baz'), 'foo-bar-baz');
});

test('slugify: trims leading/trailing dashes', () => {
  assert.equal(slugify('  --hello--  '), 'hello');
});

test('slugify: caps at 40 chars', () => {
  const s = slugify('a'.repeat(80));
  assert.ok(s.length <= 40);
  assert.equal(s, 'a'.repeat(40));
});

test('slugify: stable for same input', () => {
  assert.equal(slugify('Some Title'), slugify('Some Title'));
});

test('slugify: empty/non-string → empty', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

// ----- shouldEmitSections -----

test('shouldEmitSections: true iff taskCount > threshold', () => {
  withEnv(undefined, () => {
    assert.equal(shouldEmitSections(4), false);
    assert.equal(shouldEmitSections(5), false);
    assert.equal(shouldEmitSections(6), true);
  });
});

test('shouldEmitSections: env override', () => {
  withEnv('3', () => {
    assert.equal(shouldEmitSections(3), false);
    assert.equal(shouldEmitSections(4), true);
  });
});

// ----- parseTaskBlocks -----

test('parseTaskBlocks: ## Task headings', () => {
  const md = `# Plan\n\nintro\n\n## Task 1 — Foo\n\nbody1\n\n## Task 2 — Bar\n\nbody2\n`;
  const blocks = parseTaskBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].id, 'T1');
  assert.equal(blocks[0].title, 'Foo');
  assert.equal(blocks[0].headingLevel, 2);
  assert.match(blocks[0].body, /body1/);
  assert.equal(blocks[1].id, 'T2');
  assert.equal(blocks[1].title, 'Bar');
});

test('parseTaskBlocks: ### Task headings', () => {
  const md = `## Tasks\n\n### Task 1 — Alpha\n\nA\n\n### Task 2 — Beta\n\nB\n`;
  const blocks = parseTaskBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].id, 'T1');
  assert.equal(blocks[0].title, 'Alpha');
  assert.equal(blocks[0].headingLevel, 3);
});

test('parseTaskBlocks: no task headings → empty', () => {
  const md = `# Plan\n\nNo task headings here.\n`;
  assert.deepEqual(parseTaskBlocks(md), []);
});

test('parseTaskBlocks: empty/null input → empty array', () => {
  assert.deepEqual(parseTaskBlocks(''), []);
  assert.deepEqual(parseTaskBlocks(null), []);
});

// ----- extractSectionFiles -----

test('extractSectionFiles: dedup file references from checkboxes', () => {
  const body = `Acceptance:\n- [ ] Update \`lib/foo.js\` to do thing\n- [ ] Add tests in \`test/foo.test.js\`\n- [ ] Update \`lib/foo.js\` further\n`;
  const files = extractSectionFiles(body);
  assert.deepEqual(files.sort(), ['lib/foo.js', 'test/foo.test.js'].sort());
});

test('extractSectionFiles: no file references → empty', () => {
  const body = `- [ ] Do a thing\n- [ ] Do another\n`;
  assert.deepEqual(extractSectionFiles(body), []);
});

// ----- emitSections (T3) -----

test('emitSections: 3-task plan, threshold 5 → no folder', () => {
  withEnv(undefined, () => {
    const dir = tmpFeatureDir();
    const md = `## Task 1 — A\n\n- [ ] x\n\n## Task 2 — B\n\n- [ ] y\n\n## Task 3 — C\n\n- [ ] z\n`;
    fs.writeFileSync(path.join(dir, 'plan.md'), md);
    const result = emitSections(dir);
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(fs.existsSync(path.join(dir, 'sections')), false);
  });
});

test('emitSections: 7-task plan → 7 files with sequential numbering', () => {
  withEnv(undefined, () => {
    const dir = tmpFeatureDir();
    const tasks = [];
    for (let i = 1; i <= 7; i++) {
      tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
    }
    fs.writeFileSync(path.join(dir, 'plan.md'), tasks.join('\n'));
    const result = emitSections(dir);
    assert.equal(result.created.length, 7);
    assert.equal(result.skipped.length, 0);
    const sectionsDir = path.join(dir, 'sections');
    const files = fs.readdirSync(sectionsDir).sort();
    assert.equal(files.length, 7);
    assert.match(files[0], /^section-01-title-1\.md$/);
    assert.match(files[6], /^section-07-title-7\.md$/);
    const content = fs.readFileSync(path.join(sectionsDir, files[0]), 'utf8');
    assert.match(content, /\*\*Task ID:\*\* T1/);
    assert.match(content, /file1\.js/);
  });
});

test('emitSections: idempotent — re-emit skips existing files', () => {
  withEnv(undefined, () => {
    const dir = tmpFeatureDir();
    const tasks = [];
    for (let i = 1; i <= 7; i++) {
      tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Item\n`);
    }
    fs.writeFileSync(path.join(dir, 'plan.md'), tasks.join('\n'));
    emitSections(dir);
    const sectionsDir = path.join(dir, 'sections');
    const firstPath = path.join(sectionsDir, fs.readdirSync(sectionsDir)[0]);
    const before = fs.readFileSync(firstPath, 'utf8');
    // Mutate the file
    fs.writeFileSync(firstPath, before + '\nMUTATED');
    const result2 = emitSections(dir);
    assert.equal(result2.created.length, 0);
    assert.equal(result2.skipped.length, 7);
    // File still has our mutation
    const after = fs.readFileSync(firstPath, 'utf8');
    assert.match(after, /MUTATED/);
  });
});

test('emitSections: missing plan.md → no throw, empty result', () => {
  withEnv(undefined, () => {
    const dir = tmpFeatureDir();
    const result = emitSections(dir);
    assert.deepEqual(result, { created: [], skipped: [] });
  });
});

// ----- appendTrailers (T4) -----

function setup7TaskFixture() {
  return withEnv(undefined, () => {
    const dir = tmpFeatureDir();
    const tasks = [];
    for (let i = 1; i <= 7; i++) {
      tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
    }
    fs.writeFileSync(path.join(dir, 'plan.md'), tasks.join('\n'));
    emitSections(dir);
    return dir;
  });
}

test('appendTrailers: first call writes "What Was Built"', () => {
  const dir = setup7TaskFixture();
  appendTrailers({
    featureDir: dir,
    commit: 'abc1234',
    filesChanged: ['file1.js', 'file2.js'],
    diffStat: '2 files changed, 5 insertions(+), 1 deletion(-)',
  });
  const sectionsDir = path.join(dir, 'sections');
  const files = fs.readdirSync(sectionsDir).sort();
  const s1 = fs.readFileSync(path.join(sectionsDir, files[0]), 'utf8');
  assert.match(s1, /## What Was Built\b/);
  assert.ok(!/iteration/.test(s1));
  assert.match(s1, /abc1234/);
  assert.match(s1, /file1\.js/);
});

test('appendTrailers: subsequent calls append iteration N+1', () => {
  const dir = setup7TaskFixture();
  appendTrailers({ featureDir: dir, commit: 'aaa', filesChanged: ['file1.js'], diffStat: 's1' });
  appendTrailers({ featureDir: dir, commit: 'bbb', filesChanged: ['file1.js'], diffStat: 's2' });
  appendTrailers({ featureDir: dir, commit: 'ccc', filesChanged: ['file1.js'], diffStat: 's3' });
  const sectionsDir = path.join(dir, 'sections');
  const s1 = fs.readFileSync(path.join(sectionsDir, fs.readdirSync(sectionsDir)[0]), 'utf8');
  assert.match(s1, /## What Was Built\b/);
  assert.match(s1, /## What Was Built \(iteration 2\)/);
  assert.match(s1, /## What Was Built \(iteration 3\)/);
  assert.match(s1, /aaa/);
  assert.match(s1, /bbb/);
  assert.match(s1, /ccc/);
});

test('appendTrailers: no sections/ folder → no-op (no throw)', () => {
  const dir = tmpFeatureDir();
  // Should not throw
  appendTrailers({ featureDir: dir, commit: 'x', filesChanged: [], diffStat: '' });
  assert.equal(fs.existsSync(path.join(dir, 'sections')), false);
});

test('appendTrailers: declared-but-unchanged surfaced', () => {
  const dir = setup7TaskFixture();
  appendTrailers({
    featureDir: dir,
    commit: 'abc',
    filesChanged: ['file1.js'], // not file2.js
    diffStat: 'stat',
  });
  const sectionsDir = path.join(dir, 'sections');
  const files = fs.readdirSync(sectionsDir).sort();
  // section 2 has file2.js declared but not changed
  const s2 = fs.readFileSync(path.join(sectionsDir, files[1]), 'utf8');
  assert.match(s2, /declared but did not change/);
  assert.match(s2, /file2\.js/);
  // section 1 has file1.js changed
  const s1 = fs.readFileSync(path.join(sectionsDir, files[0]), 'utf8');
  assert.match(s1, /Files this section owns that changed[^\n]*file1\.js/);
});

// ----- M1: per-section filtered diffStat (cwd-based) -----

function makeRepoFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-sections-repo-'));
  execSync('git init -q', { cwd: repo });
  execSync('git config user.email "test@example.com"', { cwd: repo });
  execSync('git config user.name "Test"', { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repo });
  execSync('git commit -q -m "init"', { cwd: repo });
  return repo;
}

test('appendTrailers: per-section filtered diff stat from cwd', () => {
  const repo = makeRepoFixture();
  const featureDir = path.join(repo, 'docs/features/X');
  fs.mkdirSync(featureDir, { recursive: true });
  const tasks = [];
  for (let i = 1; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
  emitSections(featureDir);

  // Create + commit changes to file1.js and file3.js only
  fs.writeFileSync(path.join(repo, 'file1.js'), 'one\nliner\nhere\n');
  fs.writeFileSync(path.join(repo, 'file3.js'), 'three\n');
  execSync('git add file1.js file3.js', { cwd: repo });
  execSync('git commit -q -m "change"', { cwd: repo });
  const sha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();

  appendTrailers({
    featureDir,
    commit: sha,
    filesChanged: ['file1.js', 'file3.js'],
    cwd: repo,
  });

  const sectionsDir = path.join(featureDir, 'sections');
  const files = fs.readdirSync(sectionsDir).sort();
  // Section 1 declares file1.js — diff stat should mention file1.js
  const s1 = fs.readFileSync(path.join(sectionsDir, files[0]), 'utf8');
  assert.match(s1, /file1\.js/);
  // Diff line should not include file3.js, file5.js etc (file3.js belongs to section 3)
  const diffLineMatchS1 = s1.match(/- \*\*Diff:\*\* ([^\n]+)/);
  assert.ok(diffLineMatchS1, 'has diff line');
  assert.ok(!/file3\.js/.test(diffLineMatchS1[1]), `s1 diff should not contain file3.js: ${diffLineMatchS1[1]}`);

  // Section 3 declares file3.js — diff stat should mention file3.js
  const s3 = fs.readFileSync(path.join(sectionsDir, files[2]), 'utf8');
  const diffLineMatchS3 = s3.match(/- \*\*Diff:\*\* ([^\n]+)/);
  assert.ok(diffLineMatchS3, 'has diff line');
  assert.ok(!/file1\.js/.test(diffLineMatchS3[1]), `s3 diff should not contain file1.js: ${diffLineMatchS3[1]}`);
});

test('appendTrailers: section with no declared files → "(no declared files)"', () => {
  const repo = makeRepoFixture();
  const featureDir = path.join(repo, 'docs/features/Y');
  fs.mkdirSync(featureDir, { recursive: true });
  // 7 tasks but task 1 has no file refs
  const tasks = [];
  tasks.push(`## Task 1 — No files\n\n- [ ] Just a description, no file ref\n`);
  for (let i = 2; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
  emitSections(featureDir);

  fs.writeFileSync(path.join(repo, 'file2.js'), 'x\n');
  execSync('git add file2.js', { cwd: repo });
  execSync('git commit -q -m "c"', { cwd: repo });
  const sha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();

  appendTrailers({ featureDir, commit: sha, filesChanged: ['file2.js'], cwd: repo });

  const sectionsDir = path.join(featureDir, 'sections');
  const files = fs.readdirSync(sectionsDir).sort();
  const s1 = fs.readFileSync(path.join(sectionsDir, files[0]), 'utf8');
  assert.match(s1, /\(no declared files\)/);
});

test('appendTrailers: cwd missing/invalid → "(diff stat unavailable)" but no throw', () => {
  const dir = setup7TaskFixture();
  // Use a non-git path as cwd
  const nonGitCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'compose-nongit-'));
  appendTrailers({
    featureDir: dir,
    commit: 'abc1234',
    filesChanged: ['file1.js'],
    cwd: nonGitCwd,
  });
  const sectionsDir = path.join(dir, 'sections');
  const s1 = fs.readFileSync(path.join(sectionsDir, fs.readdirSync(sectionsDir)[0]), 'utf8');
  assert.match(s1, /diff stat unavailable/);
});

// ----- S2: iteration numbering by max-N, not count -----

test('appendTrailers: iteration numbering uses max(N), not count (manual edits)', () => {
  const dir = setup7TaskFixture();
  const sectionsDir = path.join(dir, 'sections');
  const firstFile = fs.readdirSync(sectionsDir).sort()[0];
  const fullPath = path.join(sectionsDir, firstFile);
  // Hand-craft a section file with iterations 1, 2, and 5 — skipping 3,4
  const existing = fs.readFileSync(fullPath, 'utf8');
  const hand = existing
    + '\n## What Was Built\n\n- **Commit:** `aaa`\n'
    + '\n## What Was Built (iteration 2)\n\n- **Commit:** `bbb`\n'
    + '\n## What Was Built (iteration 5)\n\n- **Commit:** `eee`\n';
  fs.writeFileSync(fullPath, hand);

  appendTrailers({ featureDir: dir, commit: 'fff', filesChanged: ['file1.js'], diffStat: 's' });
  const after = fs.readFileSync(fullPath, 'utf8');
  // Next iteration should be 6 (max=5 + 1), not 4 (count=3 + 1)
  assert.match(after, /## What Was Built \(iteration 6\)/);
  assert.match(after, /fff/);
});

// ----- S3: emitSections renders **Depends on:** -----

test('emitSections: emits "**Depends on:** —" by default', () => {
  withEnv(undefined, () => {
    const dir = tmpFeatureDir();
    const tasks = [];
    for (let i = 1; i <= 7; i++) {
      tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
    }
    fs.writeFileSync(path.join(dir, 'plan.md'), tasks.join('\n'));
    emitSections(dir);
    const sectionsDir = path.join(dir, 'sections');
    const s1 = fs.readFileSync(path.join(sectionsDir, fs.readdirSync(sectionsDir).sort()[0]), 'utf8');
    assert.match(s1, /\*\*Depends on:\*\* —/);
  });
});

// ----- Security: shell-injection safety in computeFilteredDiffStat -----

test('appendTrailers: declared file path with shell metacharacters is not executed', () => {
  // Regression: previously computeFilteredDiffStat built a shell command string
  // and passed it to execSync, so a declared file containing $(echo PWN).txt
  // would be substituted by the shell. The fix uses execFileSync with an argv
  // array — git receives the literal pathspec and either resolves it or fails.
  // Either way, the substitution must NOT run.
  const repo = makeRepoFixture();
  const featureDir = path.join(repo, 'docs/features/SEC');
  fs.mkdirSync(featureDir, { recursive: true });
  // Need >threshold tasks to trigger emission; embed the dangerous filename in task 1.
  const tasks = [];
  tasks.push('## Task 1 — Dangerous\n\n- [ ] Update `path with $(echo PWN).txt`\n');
  for (let i = 2; i <= 7; i++) {
    tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
  }
  fs.writeFileSync(path.join(featureDir, 'plan.md'), tasks.join('\n'));
  emitSections(featureDir);

  // Make a real commit so git diff has something to talk about.
  fs.writeFileSync(path.join(repo, 'real.js'), 'x\n');
  execSync('git add real.js', { cwd: repo });
  execSync('git commit -q -m "c"', { cwd: repo });
  const sha = execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();

  // This must not throw, and must not let the shell expand $(echo PWN).
  appendTrailers({
    featureDir,
    commit: sha,
    filesChanged: ['real.js'],
    cwd: repo,
  });

  const sectionsDir = path.join(featureDir, 'sections');
  const s1 = fs.readFileSync(path.join(sectionsDir, fs.readdirSync(sectionsDir).sort()[0]), 'utf8');
  // The literal substring "PWN" must not appear in the trailer — its presence
  // would mean the shell evaluated $(echo PWN). The literal $(echo PWN) string
  // from the **Files:** header line is allowed (that line is rendered verbatim
  // from the declared list), but the **Diff:** line must not contain "PWN".
  const diffLine = s1.match(/- \*\*Diff:\*\* ([^\n]+)/);
  assert.ok(diffLine, 'has diff line');
  assert.ok(!/PWN/.test(diffLine[1]), `diff line must not contain PWN: ${diffLine[1]}`);
});

test('emitSections: parses "Depends on:" line from task body', () => {
  withEnv(undefined, () => {
    const dir = tmpFeatureDir();
    const tasks = [];
    tasks.push(`## Task 1 — Alpha\n\nDepends on: T0, lib/x.js\n\n- [ ] Update \`file1.js\`\n`);
    for (let i = 2; i <= 7; i++) {
      tasks.push(`## Task ${i} — Title ${i}\n\n- [ ] Update \`file${i}.js\`\n`);
    }
    fs.writeFileSync(path.join(dir, 'plan.md'), tasks.join('\n'));
    emitSections(dir);
    const sectionsDir = path.join(dir, 'sections');
    const s1 = fs.readFileSync(path.join(sectionsDir, fs.readdirSync(sectionsDir).sort()[0]), 'utf8');
    assert.match(s1, /\*\*Depends on:\*\* T0, lib\/x\.js/);
  });
});
