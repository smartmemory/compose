/**
 * archetype-debug.test.js — COMP-STAGE-GRADING-3 (G3): shared notes-server scenario, archetype loader, `debug` archetype.
 *
 * Contracts: docs/features/COMP-MODEL-AB-DECISION/archetype-contract.json, stage-run-contract.json.
 * No model call: every oracle row is fed a canned workspace.
 *
 * Run: node --test test/archetype-debug.test.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { loadArchetype, describeArchetype, ARCHETYPE_IDS } from '../lib/archetypes/index.js';
import * as debug from '../lib/archetypes/debug.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'docs/features/COMP-MODEL-AB-DECISION/archetype-contract.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(CONTRACT);
const schema = (def) => ajv.getSchema(`${CONTRACT.$id}#/$defs/${def}`);

const temps = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), `archetype-debug-test-${prefix}-`));
  temps.push(d);
  return d;
}
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

function listTree(root, rel = '') {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? join(rel, e.name) : e.name;
    return e.isDirectory() ? listTree(root, r) : [r];
  }).sort();
}

/** A provisioned-looking workspace (.git and .compose/data, as experiment-sandbox.js provision leaves it) after buildInput. */
function seededWorkspace(name) {
  const ws = tempDir(name);
  mkdirSync(join(ws, '.git'));
  mkdirSync(join(ws, '.compose', 'data'), { recursive: true });
  debug.buildInput(ws, debug.publicScenario());
  return ws;
}

const STORE = join('src', 'store.js');
const BUG_LINE = "    sql += ')';\n";
const FIX_LINE = "    sql += \" OR n.body LIKE $p ESCAPE '\\\\')\";\n";
const TITLE_CLAUSE = "\" WHERE (n.title LIKE $p ESCAPE '\\\\'\"";
const BODY_CLAUSE = "\" WHERE (n.body LIKE $p ESCAPE '\\\\'\"";

function editStore(ws, from, to) {
  const p = join(ws, STORE);
  const src = readFileSync(p, 'utf8');
  assert.ok(src.includes(from), `canned edit anchor missing: ${from}`);
  writeFileSync(p, src.replace(from, to));
}

function runNodeTests(cwd, files) {
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  const res = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', ...files],
    { cwd, env, encoding: 'utf8', timeout: 120_000 });
  return { status: res.status, stdout: res.stdout };
}

describe('notes-server fixture self-test', () => {
  const GOLDEN = ['test/store.test.js', 'test/server.test.js'];

  test('golden suite and repro are green with the bug patch reverted', () => {
    const ws = seededWorkspace('selftest-reverted');
    editStore(ws, BUG_LINE, FIX_LINE);
    assert.equal(readFileSync(join(ws, STORE), 'utf8'), readFileSync(join(debug.scenarioDir, STORE), 'utf8'),
      'reverting the planted bug restores the scenario source byte for byte');
    for (const f of GOLDEN) writeFileSync(join(ws, f), readFileSync(join(debug.scenarioDir, f)));
    const golden = runNodeTests(ws, GOLDEN);
    assert.equal(golden.status, 0, golden.stdout);
    assert.match(golden.stdout, /^# fail 0$/m);
    assert.equal(runNodeTests(ws, [debug.REPRO_PATH]).status, 0);
  });

  test('repro is red with the bug patch applied, and so is the golden suite', () => {
    const ws = seededWorkspace('selftest-buggy');
    const repro = runNodeTests(ws, [debug.REPRO_PATH]);
    assert.equal(repro.status, 1);
    assert.match(repro.stdout, /^# fail 1$/m);
    for (const f of GOLDEN) writeFileSync(join(ws, f), readFileSync(join(debug.scenarioDir, f)));
    assert.equal(runNodeTests(ws, GOLDEN).status, 1);
  });
});

describe('debug.buildInput', () => {
  test('writes the buggy code and the failing repro only; no hidden material reaches the workspace', () => {
    const ws = seededWorkspace('build-input');
    const files = listTree(ws);
    assert.deepEqual(files, ['README.md', join('bin', 'notes-server.js'), 'package.json', join('src', 'server.js'), STORE,
      join('test', 'repro.test.js')].sort());
    assert.equal(readFileSync(join(ws, STORE), 'utf8').includes(BUG_LINE), true, 'planted bug present');

    const fixture = JSON.parse(readFileSync(debug.fixturePath, 'utf8'));
    const hiddenNames = [...readdirSync(debug.hiddenDir), ...readdirSync(join(debug.hiddenDir, 'suite')),
      ...readdirSync(join(debug.scenarioDir, 'test'))].filter((n) => n !== 'repro.test.js' && n !== 'README.md');
    for (const f of files) assert.ok(!hiddenNames.includes(f.split(sep).pop()), `hidden file ${f} in workspace`);
    assert.equal(readFileSync(join(ws, 'README.md'), 'utf8'), readFileSync(join(debug.scenarioDir, 'README.md'), 'utf8'),
      'the workspace README is the scenario README, not the hidden one');
    const all = files.map((f) => readFileSync(join(ws, f), 'utf8')).join('\n');
    assert.ok(!all.includes(fixture.gold.fix), 'answer key text in workspace');
    assert.ok(!all.includes(FIX_LINE.trim()), 'fixed line in workspace');
  });

  test('refuses a scenario carrying gold and a workspace that is not empty', () => {
    const ws = tempDir('build-input-refuse');
    assert.throws(() => debug.buildInput(ws, { ...debug.publicScenario(), gold: {} }), /carries gold/);
    assert.throws(() => debug.prompt({ gold: {} }), /carries gold/);
    writeFileSync(join(ws, 'seed.txt'), 'x');
    assert.throws(() => debug.buildInput(ws, null), /not empty \(seed\.txt\)/);
  });

  test('prompt names the task and the repro command, never the answer key', () => {
    const fixture = JSON.parse(readFileSync(debug.fixturePath, 'utf8'));
    const p = debug.prompt(debug.publicScenario());
    assert.ok(p.includes(fixture.task));
    assert.ok(p.includes(fixture.gold.reproCommand), 'module REPRO_COMMAND matches gold.reproCommand');
    assert.equal(debug.REPRO_COMMAND, fixture.gold.reproCommand);
    assert.ok(!p.includes(fixture.gold.fix));
    assert.equal(debug.prompt(null), p);
  });
});

describe('debug.oracle outcome table (canned workspaces, no model)', () => {
  const WITH_MARKER = `$ node --test test/repro.test.js\n# ${debug.REPRO_MARKER}\nok 1 - search_notes finds a note by a word in its body\n`;
  const rows = [
    { outcome: 'untouched workspace', make: () => {}, transcript: null,
      expect: { accuracy: 0, failed: ['repro', 'suite'], canary: false, mechanismEngaged: false, oracleError: null } },
    { outcome: 'repro green + suite red (body-only search drops title matches)',
      make: (ws) => editStore(ws, TITLE_CLAUSE, BODY_CLAUSE), transcript: WITH_MARKER,
      expect: { accuracy: 0, failed: ['suite'], canary: true, mechanismEngaged: true, oracleError: null } },
    { outcome: 'repro green + suite green (real fix)', make: (ws) => editStore(ws, BUG_LINE, FIX_LINE), transcript: WITH_MARKER,
      expect: { accuracy: 1, failed: [], canary: true, mechanismEngaged: true, oracleError: null } },
    { outcome: 'repro red (edit that does not fix)', make: (ws) => editStore(ws, BUG_LINE, `    // TODO body search\n${BUG_LINE}`),
      transcript: 'cat src/store.js', expect: { accuracy: 0, failed: ['repro', 'suite'], canary: true, mechanismEngaged: false, oracleError: null } },
    { outcome: 'hidden suite cannot start', make: (ws) => editStore(ws, BUG_LINE, FIX_LINE), hidden: () => tempDir('empty-hidden'),
      transcript: WITH_MARKER, expect: { accuracy: null, canary: true, mechanismEngaged: true, oracleError: /^hidden suite cannot start/ } },
  ];

  for (const row of rows) {
    test(row.outcome, () => {
      const ws = seededWorkspace(row.outcome.split(' ')[0]);
      row.make(ws);
      const before = listTree(ws);
      const result = debug.oracle(ws, row.hidden ? row.hidden() : debug.hiddenDir, { transcriptPath: null });

      assert.ok(schema('oracleResult')(result), JSON.stringify(schema('oracleResult').errors));
      assert.deepEqual(listTree(ws), before, 'oracle leaves the workspace untouched');
      assert.equal(result.accuracy, row.expect.accuracy);
      if (row.expect.oracleError) {
        assert.match(result.oracleError, row.expect.oracleError);
      } else {
        assert.equal(result.oracleError, null);
        assert.deepEqual(result.detail.failed, row.expect.failed);
        assert.equal(result.detail.repro.ok, !row.expect.failed.includes('repro'));
        assert.equal(result.detail.suite.ok, !row.expect.failed.includes('suite'));
        assert.ok(result.detail.suite.total >= 16, `hidden full suite ran (${result.detail.suite.total} tests)`);
      }
      assert.equal(debug.canary(ws), row.expect.canary);
      assert.equal(debug.mechanismEngaged(ws, row.transcript), row.expect.mechanismEngaged);
    });
  }

  const gamingRows = [
    { name: 'repro rewritten to pass (the oracle runs the pristine repro)', make: (ws) =>
      writeFileSync(join(ws, debug.REPRO_PATH), "import { test } from 'node:test';\ntest('passes', () => {});\n") },
    { name: 'store exits the process at import (no test runs, exit 0)', make: (ws) =>
      editStore(ws, "import { DatabaseSync } from 'node:sqlite';\n", "import { DatabaseSync } from 'node:sqlite';\nprocess.exit(0);\n") },
    { name: 'test/ replaced by a symlink into the workspace', make: (ws) => {
      rmSync(join(ws, 'test'), { recursive: true });
      mkdirSync(join(ws, 'decoy'));
      symlinkSync(join(ws, 'decoy'), join(ws, 'test'));
    } },
  ];
  for (const row of gamingRows) {
    test(`gaming: ${row.name} scores 0 and leaks nothing`, () => {
      const ws = seededWorkspace('gaming');
      row.make(ws);
      const before = listTree(ws);
      const result = debug.oracle(ws, debug.hiddenDir, null);
      assert.equal(result.oracleError, null);
      assert.equal(result.accuracy, 0);
      assert.ok(result.detail.failed.includes('repro'));
      assert.deepEqual(listTree(ws), before, 'no hidden file written into the workspace');
    });
  }

  test('a hidden dir inside the workspace is refused', () => {
    const ws = seededWorkspace('hidden-inside');
    const result = debug.oracle(ws, join(ws, 'test'), null);
    assert.equal(result.accuracy, null);
    assert.match(result.oracleError, /inside the workspace/);
  });
});

describe('debug.canary and debug.mechanismEngaged', () => {
  const canaryRows = [
    { name: 'only generated files added (test log, db, sandbox data, node_modules)', expect: false, make: (ws) => {
      mkdirSync(join(ws, '.test-log'));
      writeFileSync(join(ws, '.test-log', 'repro.log'), 'x');
      writeFileSync(join(ws, 'notes.db'), 'x');
      writeFileSync(join(ws, '.compose', 'data', 'state.json'), '{}');
      mkdirSync(join(ws, 'node_modules'));
      writeFileSync(join(ws, 'node_modules', 'x.js'), '');
    } },
    { name: 'seeded file edited', expect: true, make: (ws) => editStore(ws, BUG_LINE, FIX_LINE) },
    { name: 'seeded file deleted', expect: true, make: (ws) => unlinkSync(join(ws, 'README.md')) },
    { name: 'source file added', expect: true, make: (ws) => writeFileSync(join(ws, 'src', 'helper.js'), 'export {};\n') },
  ];
  for (const row of canaryRows) {
    test(`canary: ${row.name} -> ${row.expect}`, () => {
      const ws = seededWorkspace('canary');
      row.make(ws);
      assert.equal(debug.canary(ws), row.expect);
    });
  }

  // mechanismEvidence: one row per evidence case. `transcript` is the text handed to the check, `log` seeds the workspace test log.
  const evidenceRows = [
    { name: 'command line in a codex-shaped event line', transcript: '{"kind":"tool_use_summary","tool":"bash","input":{"command":"node --test test/repro.test.js"}}', engaged: true, label: 'engaged' },
    { name: 'command with a ./ prefix and a node flag', transcript: '{"input":{"command":"node --no-warnings --test ./test/repro.test.js"}}', engaged: true, label: 'engaged' },
    { name: 'marker in tool output', transcript: '{"kind":"tool_result","output":"repro-executed-notes-search"}', engaged: true, label: 'engaged' },
    { name: 'test log only', transcript: null, log: true, engaged: true, label: 'engaged' },
    { name: 'neither source holds anything', transcript: null, engaged: false, label: 'no-evidence' },
    { name: 'transcript reads the repro but never runs it', transcript: '{"input":{"command":"cat test/repro.test.js"}}', engaged: false, label: 'evidence-without-repro' },
    { name: 'transcript runs the whole suite, not the repro', transcript: '{"input":{"command":"node --test"}}', engaged: false, label: 'evidence-without-repro' },
  ];
  for (const row of evidenceRows) {
    test(`mechanismEvidence: ${row.name}`, () => {
      const ws = seededWorkspace('evidence');
      if (row.log) {
        mkdirSync(join(ws, '.test-log'));
        writeFileSync(join(ws, '.test-log', 'repro.log'), `x ${debug.REPRO_MARKER}\n`);
      }
      const ev = debug.mechanismEvidence(ws, row.transcript);
      assert.equal(ev.engaged, row.engaged);
      assert.equal(ev.label, row.label);
      assert.equal(debug.mechanismEngaged(ws, row.transcript), row.engaged);
    });
  }

  test('mechanismEngaged: transcript text, transcript path, workspace test log, or neither', () => {
    const ws = seededWorkspace('mechanism');
    const reproSource = readFileSync(join(ws, debug.REPRO_PATH), 'utf8');
    assert.ok(!reproSource.includes(debug.REPRO_MARKER), 'reading the repro does not produce the marker');
    assert.equal(debug.mechanismEngaged(ws, null), false);
    assert.equal(debug.mechanismEngaged(ws, `$ cat test/repro.test.js\n${reproSource}`), false);
    assert.equal(debug.mechanismEngaged(ws, `tool_result: # ${debug.REPRO_MARKER}`), true);
    const tp = join(tempDir('transcript'), 'transcript.jsonl');
    writeFileSync(tp, JSON.stringify({ type: 'tool_result', content: `# ${debug.REPRO_MARKER}` }) + '\n');
    assert.equal(debug.mechanismEngaged(ws, tp), true);

    const run = runNodeTests(ws, [debug.REPRO_PATH]);
    assert.match(run.stdout, new RegExp(debug.REPRO_MARKER), 'running the repro prints the marker');
    assert.equal(debug.mechanismEngaged(ws, null), true, 'running the repro in the workspace writes the test log');
    assert.equal(debug.canary(ws), false, 'the test log is not a diff');
  });
});

describe('loadArchetype', () => {
  test('refuses an unknown id with ARCHETYPE_UNKNOWN', () => {
    for (const bad of ['nope', '__proto__', 'constructor', 'toString', '', undefined, null, 7]) {
      assert.throws(() => loadArchetype(bad), (err) => err.code === 'ARCHETYPE_UNKNOWN' && /^ARCHETYPE_UNKNOWN/.test(err.message),
        `id ${String(bad)}`);
    }
  });

  test('returns debug, whose descriptor validates against the contract and equals its worked example', () => {
    assert.deepEqual(ARCHETYPE_IDS, ['debug']);
    const mod = loadArchetype('debug');
    assert.equal(mod, debug);
    const descriptor = describeArchetype(mod);
    assert.ok(schema('descriptor')(descriptor), JSON.stringify(schema('descriptor').errors));
    const example = CONTRACT.examples.find((e) => e.name.startsWith('debug archetype descriptor'));
    assert.deepEqual(descriptor, example.value);
    assert.deepEqual(CONTRACT.$defs.methodTable.const.map((m) => m.name), ['buildInput', 'prompt', 'oracle', 'canary', 'mechanismEngaged']);
    assert.deepEqual(['buildInput', 'prompt', 'oracle', 'canary', 'mechanismEngaged'].map((n) => typeof mod[n]), Array(5).fill('function'));
  });

  test("G2's dynamic import resolves the loader", async () => {
    const { loadArchetype: viaImport } = await import('../lib/archetypes/index.js');
    assert.equal(viaImport('debug').runner, 'stage');
    assert.equal((await viaImport('debug')).id, 'debug', 'awaiting the sync loader is harmless');
  });

  test('the fixture unit validates against the contract', () => {
    const fixture = JSON.parse(readFileSync(debug.fixturePath, 'utf8'));
    assert.ok(schema('fixtureUnit')(fixture), JSON.stringify(schema('fixtureUnit').errors));
    assert.equal(fixture.task_type, debug.stage);
    assert.deepEqual(debug.publicScenario(), { context: fixture.context, task: fixture.task, task_type: 'debug' });
  });
});
