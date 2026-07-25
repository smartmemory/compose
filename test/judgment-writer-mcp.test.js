/**
 * judgment-writer-mcp.test.js — end-to-end coverage for the judgment MCP
 * surface (T6/S06). Spawns the MCP server, speaks JSON-RPC over stdio via
 * COMPOSE_TARGET; asserts golden-lite through the tools, forbidden-tag and
 * provenance rejections, error-code passthrough, and the reviewer policy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { isToolAllowed } from '../server/mcp-tool-policy.js';
import { checkProjectionRoundtrip } from '../lib/judgment-gen.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER = join(ROOT, 'server', 'compose-mcp.js');

class McpClient {
  constructor(cwd, extraEnv = {}) {
    this.proc = spawn('node', [MCP_SERVER], {
      env: { ...process.env, COMPOSE_TARGET: cwd, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf-8');
      let nl;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const { resolve: rs, reject: rj } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rj(new Error(msg.error.message || JSON.stringify(msg.error)));
            else rs(msg.result);
          }
        } catch { /* ignore */ }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rejectPromise(new Error(`MCP request "${method}" timed out`));
        }
      }, 8000);
    });
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }

  close() {
    this.proc.kill();
  }
}

function freshCwd() {
  return mkdtempSync(join(tmpdir(), 'mcp-judgment-writer-'));
}

function parseToolText(result) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error(`tool returned no text content: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function errorText(result) {
  assert.equal(result.isError, true, `expected isError result, got ${JSON.stringify(result)}`);
  return result.content?.[0]?.text ?? '';
}

const JUDGMENT_TOOLS = [
  'judgment_position_create',
  'judgment_position_amend',
  'judgment_joint_add',
  'judgment_transition',
  'judgment_ledger_append',
  'judgment_person_write',
  'judgment_situation_write',
  'judgment_goal_write',
  'get_judgment_state',
];

const NEW_JUDGMENT_TOOL_OPS = {
  judgment_person_write: ['create', 'add_fact', 'correct', 'open_field', 'edge', 'load_link'],
  judgment_situation_write: ['create', 'add_fact', 'correct', 'owed', 'load_link'],
  judgment_goal_write: ['cut', 'correct', 'joint_link', 'load_link', 'migrate'],
};

// COMP-JUDGMENT-GOAL-MIGRATE S3 — the legacy pre-cutover fixture, seeded only
// through the registered tools (no module imports, no hand-written records).
const MIGRATION_JOINT_SLUGS = ['horizon', 'success-criteria', 'commercial-intent'];

const LEGACY_OBJECTIVE_CLAIM = {
  id: 'c1',
  text: 'build Compose into a system that decides what to build well.',
  grounding: 'ASSERT',
  supports: [],
  elicitation: {
    asked: 'What are we optimizing for?',
    answered_at: '2026-07-20T12:00:00Z',
    answer_ref: 'import:docs/judgment/OBJECTIVE.md (back-inferred draft)',
  },
};

const MIGRATION_REQUIRED_MESSAGE = 'judgment_goal_write cut: legacy objective is live; run judgment_goal_write op=migrate before any other goal operation';
const MIGRATION_CONFLICT_MESSAGE = 'judgment_goal_write migrate: legacy objective is not live and no durable migration is complete';
const OBJECTIVE_RETIRED_MESSAGE = 'judgment_position_create: objective is retired after goal cutover; use judgment_goal_write for goal changes (retracted:true remains legal)';

async function seedLegacyThroughTools(client) {
  for (const slug of MIGRATION_JOINT_SLUGS) {
    parseToolText(await client.callTool('judgment_joint_add', {
      slug,
      question: `${slug}?`,
      branch_true: 'a',
      branch_false: 'b',
      resolve_by: 'INT',
      cost: 'hours',
      rank: 'medium',
    }));
  }
  parseToolText(await client.callTool('judgment_position_create', {
    slug: 'objective',
    claims: [{ ...LEGACY_OBJECTIVE_CLAIM, elicitation: { ...LEGACY_OBJECTIVE_CLAIM.elicitation } }],
    conviction: { level: 'low', source: 'inferred' },
  }));
}

const recordsPath = (cwd, ...parts) => join(cwd, 'docs', 'judgment', 'records', ...parts);
const readRecord = (cwd, ...parts) => JSON.parse(readFileSync(recordsPath(cwd, ...parts), 'utf8'));

function readLedger(cwd) {
  return readFileSync(recordsPath(cwd, 'ledger.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function pendingIntentIds(cwd) {
  const dir = recordsPath(cwd, 'intents');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

const elicitation = {
  asked: 'Do we ship the writer?',
  answered_at: '2026-07-22T11:00:00Z',
  answer_ref: 'session quote',
};

const ratifiedGoalCut = {
  op: 'cut',
  clauses: [{
    text: 'Ship the complete judgment-store family.',
    channel: 'said',
    elicitation,
  }],
  provocation: {
    quote: 'What must the final slice prove?',
    at: '2026-07-23T12:00:00Z',
  },
  ratification: {
    ...elicitation,
    quote: 'Ship the complete judgment-store family.',
  },
  diff_note: 'Initial ratified goal cut.',
};

describe('compose-mcp judgment registry parity', () => {
  test('has 50 tool definitions, 50 dispatch cases, and nine exact judgment names', () => {
    const source = readFileSync(MCP_SERVER, 'utf8');
    const toolsStart = source.indexOf('const TOOLS = [');
    const toolsEnd = source.indexOf('\n];\n\n// ---------------------------------------------------------------------------\n// MCP Server setup', toolsStart);
    const switchStart = source.indexOf('    switch (name) {');
    const switchEnd = source.indexOf('      // agent_run removed', switchStart);
    assert.ok(toolsStart >= 0 && toolsEnd > toolsStart, 'TOOLS array anchors must resolve');
    assert.ok(switchStart >= 0 && switchEnd > switchStart, 'dispatch switch anchors must resolve');

    const definitionNames = [
      ...source.slice(toolsStart, toolsEnd).matchAll(/^    name: '([^']+)',/gm),
    ].map((match) => match[1]);
    const dispatchNames = [
      ...source.slice(switchStart, switchEnd).matchAll(/^      case '([^']+)'/gm),
    ].map((match) => match[1]);

    assert.equal(definitionNames.length, 50, 'TOOLS definition count');
    assert.equal(dispatchNames.length, 50, 'dispatch case count');
    assert.deepEqual(
      [...definitionNames].sort(),
      [...dispatchNames].sort(),
      'every listed tool has exactly one dispatch case',
    );
    assert.deepEqual(
      definitionNames.filter((name) => name.startsWith('judgment_') || name === 'get_judgment_state').sort(),
      [...JUDGMENT_TOOLS].sort(),
    );
  });
});

describe('compose-mcp judgment writer (end-to-end)', () => {
  test('tools/list includes the nine judgment tools with exact new op enums', async () => {
    const client = new McpClient(freshCwd());
    try {
      const result = await client.request('tools/list', {});
      const names = result.tools.map((t) => t.name);
      for (const tool of JUDGMENT_TOOLS) {
        assert.ok(names.includes(tool), `${tool} should be listed`);
      }
      for (const [name, ops] of Object.entries(NEW_JUDGMENT_TOOL_OPS)) {
        const definition = result.tools.find((tool) => tool.name === name);
        assert.deepEqual(definition.inputSchema.required, ['op'], `${name} requires only its discriminant`);
        assert.deepEqual(definition.inputSchema.properties.op.enum, ops, `${name} op enum`);
      }
      const ledgerAppend = result.tools.find((tool) => tool.name === 'judgment_ledger_append');
      assert.ok(ledgerAppend.inputSchema.properties.rests_on, 'judgment_ledger_append advertises rests_on');
    } finally {
      client.close();
    }
  });

  test('golden-lite: position → joint → transition → ledger → state, all through tools', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      const created = parseToolText(await client.callTool('judgment_position_create', {
        slug: 'objective',
        claims: [{ id: 'c1', text: 'Owner asserted X.', grounding: 'ASSERT', elicitation }],
        conviction: { level: 'high', source: 'stated' },
      }));
      assert.equal(created.ref, 'objective#r1');

      const joint = parseToolText(await client.callTool('judgment_joint_add', {
        slug: 'first-joint',
        question: 'Does it work end to end?',
        branch_true: 'Ship.',
        branch_false: 'Fix.',
        resolve_by: 'CONSTRUCT',
        cost: 'hours',
        rank: 'high',
      }));
      assert.equal(joint.state, 'open');

      const transition = parseToolText(await client.callTool('judgment_transition', {
        slug: 'first-joint',
        to: 'under_test',
      }));
      assert.equal(transition.applied, true);
      assert.equal(transition.state, 'under_test');

      const appended = parseToolText(await client.callTool('judgment_ledger_append', {
        kind: 'open',
        title: 'Disposed first-joint via CONSTRUCT',
        disposition: 'CONSTRUCT',
        refs: ['first-joint'],
        prediction: { text: 'e2e goes green', outcome_criteria: 'suite green' },
      }));
      assert.ok(appended.prediction_id);

      const amended = parseToolText(await client.callTool('judgment_position_amend', {
        slug: 'objective',
        claim_id: 'c1',
        grounding: 'AGENT',
      }));
      assert.equal(amended.rev, 2);

      const state = parseToolText(await client.callTool('get_judgment_state', {}));
      assert.deepEqual(state.under_test, ['first-joint']);
      assert.equal(state.positions[0].ref, 'objective#r2');
      assert.equal(state.open_predictions.length, 1);
    } finally {
      client.close();
    }
  });

  test('golden family flow: person, situation, ratified goal, and typed counts through tools', async () => {
    const client = new McpClient(freshCwd());
    try {
      const person = parseToolText(await client.callTool('judgment_person_write', {
        op: 'create',
        slug: 'maya',
        display_name: 'Maya',
      }));
      assert.deepEqual(person, { op: 'create', slug: 'maya' });
      const personFact = parseToolText(await client.callTool('judgment_person_write', {
        op: 'add_fact',
        slug: 'maya',
        section: 'stated',
        text: 'I ratified the final slice.',
        channel: 'said',
        at: '2026-07-23',
      }));
      assert.equal(personFact.id, 'f1');

      const situation = parseToolText(await client.callTool('judgment_situation_write', {
        op: 'create',
        slug: 'launch-window',
        display_name: 'Launch Window',
      }));
      assert.deepEqual(situation, { op: 'create', slug: 'launch-window' });
      const situationFact = parseToolText(await client.callTool('judgment_situation_write', {
        op: 'add_fact',
        slug: 'launch-window',
        text: 'The full judgment family is green.',
        channel: 'observed',
        at: '2026-07-23',
      }));
      assert.equal(situationFact.id, 'f1');

      const goal = parseToolText(await client.callTool('judgment_goal_write', ratifiedGoalCut));
      assert.deepEqual(goal, {
        op: 'cut',
        version: 1,
        ref: 'goal:v1',
        ratified: true,
      });

      const state = parseToolText(await client.callTool('get_judgment_state', {}));
      assert.deepEqual(state.counts, {
        people: { spoken: 1, stub: 0 },
        entities: 1,
        goal: { version: 1, ratified: true },
      });
    } finally {
      client.close();
    }
  });

  test('forbidden owner tag through tools names the import/override paths', async () => {
    const client = new McpClient(freshCwd());
    try {
      const text = errorText(await client.callTool('judgment_position_create', {
        slug: 'sneaky',
        claims: [{ id: 'c1', text: 't', grounding: 'INT', owner_locked: true }],
        conviction: { level: 'high', source: 'stated' },
      }));
      assert.match(text, /JUDGMENT_GROUNDING_VIOLATION/);
      assert.match(text, /import/);
      assert.match(text, /override/);
    } finally {
      client.close();
    }
  });

  test('caller-supplied provenance and error codes pass through the MCP boundary', async () => {
    const client = new McpClient(freshCwd());
    try {
      const forged = errorText(await client.callTool('judgment_position_create', {
        slug: 'forged',
        claims: [{ id: 'c1', text: 't', grounding: 'INT' }],
        conviction: { level: 'low', source: 'inferred' },
        provenance: { actor: 'agent', written_at: '2020-01-01T00:00:00Z' },
      }));
      assert.match(forged, /Error \[JUDGMENT_INPUT\]/);

      const ghost = errorText(await client.callTool('judgment_transition', {
        slug: 'ghost', to: 'under_test',
      }));
      assert.match(ghost, /Error \[JUDGMENT_NOT_FOUND\]/);
    } finally {
      client.close();
    }
  });

  test('new writer error codes survive the MCP boundary', async () => {
    const client = new McpClient(freshCwd());
    try {
      const input = errorText(await client.callTool('judgment_person_write', {
        op: 'not_an_op',
      }));
      assert.match(input, /Error \[JUDGMENT_INPUT\]/);

      parseToolText(await client.callTool('judgment_person_write', {
        op: 'create',
        slug: 'load-stub',
        display_name: 'Load Stub',
      }));
      parseToolText(await client.callTool('judgment_person_write', {
        op: 'add_fact',
        slug: 'load-stub',
        section: 'role',
        text: 'Carries a secondhand observation.',
        channel: 'observed',
        at: '2026-07-23',
      }));
      const loadChannel = errorText(await client.callTool('judgment_person_write', {
        op: 'load_link',
        slug: 'load-stub',
        fact: 'f1',
        carries: 'launch decision',
      }));
      assert.match(loadChannel, /Error \[JUDGMENT_LOAD_CHANNEL\]/);

      const unratified = errorText(await client.callTool('judgment_goal_write', {
        op: 'cut',
        clauses: [],
        diff_note: 'Not ratified.',
      }));
      assert.match(unratified, /Error \[JUDGMENT_UNRATIFIED_CUT\]/);

      parseToolText(await client.callTool('judgment_position_create', {
        slug: 'objective',
        claims: [{ id: 'c1', text: 'Legacy live objective.', grounding: 'INT' }],
        conviction: { level: 'high', source: 'stated' },
      }));
      const migration = errorText(await client.callTool('judgment_goal_write', ratifiedGoalCut));
      assert.match(migration, /Error \[JUDGMENT_MIGRATION_REQUIRED\]/);
    } finally {
      client.close();
    }
  });
});

describe('COMP-JUDGMENT-GOAL-MIGRATE S3 — MCP reachability', () => {
  test('judgment_goal_write advertises migrate on the existing 50/50 registry', async () => {
    const source = readFileSync(MCP_SERVER, 'utf8');
    const toolsStart = source.indexOf('const TOOLS = [');
    const toolsEnd = source.indexOf('\n];\n\n// ---------------------------------------------------------------------------\n// MCP Server setup', toolsStart);
    const switchStart = source.indexOf('    switch (name) {');
    const switchEnd = source.indexOf('      // agent_run removed', switchStart);
    const definitionNames = [
      ...source.slice(toolsStart, toolsEnd).matchAll(/^    name: '([^']+)',/gm),
    ].map((match) => match[1]);
    const dispatchNames = [
      ...source.slice(switchStart, switchEnd).matchAll(/^      case '([^']+)'/gm),
    ].map((match) => match[1]);

    // Adding an op must not add a tool: the registry stays at its pinned size.
    assert.equal(definitionNames.length, 50, 'TOOLS definition count');
    assert.equal(dispatchNames.length, 50, 'dispatch case count');
    assert.deepEqual(
      definitionNames.filter((name) => name.startsWith('judgment_') || name === 'get_judgment_state').sort(),
      [...JUDGMENT_TOOLS].sort(),
      'the nine judgment tool names are unchanged',
    );

    const client = new McpClient(freshCwd());
    try {
      const result = await client.request('tools/list', {});
      const goal = result.tools.find((tool) => tool.name === 'judgment_goal_write');
      assert.deepEqual(
        goal.inputSchema.properties.op.enum,
        ['cut', 'correct', 'joint_link', 'load_link', 'migrate'],
        'goal op enum',
      );
      assert.deepEqual(goal.inputSchema.required, ['op'], 'migrate adds no required argument');
      for (const argument of ['provenance', 'intent', 'intent_id', 'note', 'source', 'joints']) {
        assert.equal(
          argument in goal.inputSchema.properties,
          false,
          `migrate must not advertise a ${argument} argument`,
        );
      }
      // The fence is wholesale over every non-migrate op, and migrate is the
      // one-shot, no-payload cutover that lifts it.
      assert.match(goal.description, /Every non-migrate op is migration-locked/);
      assert.match(goal.description, /one-shot, fail-closed cutover/);
      assert.match(goal.description, /takes no payload/);

      const state = result.tools.find((tool) => tool.name === 'get_judgment_state');
      assert.match(state.description, /Replays pending judgment intents first\./);
      assert.doesNotMatch(state.description, /pending transition intents/);
    } finally {
      client.close();
    }
  });

  test('MCP migrate publishes the typed cutover', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      await seedLegacyThroughTools(client);
      const legacyProjection = readFileSync(join(cwd, 'docs', 'judgment', 'OBJECTIVE.md'), 'utf8');

      const migrated = parseToolText(await client.callTool('judgment_goal_write', { op: 'migrate' }));
      assert.deepEqual(migrated, {
        op: 'migrate',
        status: 'migrated',
        version: 1,
        ref: 'goal:v1',
        intent_id: migrated.intent_id,
      });
      assert.match(migrated.intent_id, /^intent-/);

      const goal = readRecord(cwd, 'goal', 'v1.json');
      assert.equal(goal.clauses.length, 1);
      assert.equal(goal.clauses[0].text, LEGACY_OBJECTIVE_CLAIM.text);
      assert.equal(goal.clauses[0].channel, 'inferred');
      assert.equal(goal.provocation, null);
      assert.equal('ratification' in goal, false);
      assert.equal(goal.provenance.via, 'migration');
      assert.equal(goal.provenance.intent_id, migrated.intent_id);

      const tombstone = readRecord(cwd, 'positions', 'objective', 'r2.json');
      assert.equal(tombstone.retracted, true);
      assert.deepEqual(tombstone.claims, []);
      assert.equal(tombstone.provenance.intent_id, migrated.intent_id);

      const state = readRecord(cwd, 'goal', 'state.json');
      assert.deepEqual(state.joints.map((entry) => entry.joint), MIGRATION_JOINT_SLUGS);
      assert.deepEqual(state.load_links, []);

      const ledger = readLedger(cwd);
      const note = ledger.find((event) => event.kind === 'note' && event.anchor === 'position:objective');
      assert.equal(note.title, 'Legacy objective migrated to goal:v1');
      assert.ok(note.body.includes(legacyProjection.trim()), 'the note carries the legacy projection verbatim');
      const attestations = ledger.filter((event) => event.kind === 'attest' && event.intent_id === migrated.intent_id);
      assert.equal(attestations.length, 1);
      assert.equal(attestations[0].tool, 'judgment_goal_write');
      assert.equal(attestations[0].op, 'migrate');
      assert.deepEqual(pendingIntentIds(cwd), [], 'the intent is cleared at the publication point');

      const again = parseToolText(await client.callTool('judgment_goal_write', { op: 'migrate' }));
      assert.deepEqual(again, {
        op: 'migrate',
        status: 'already migrated',
        version: 1,
        ref: 'goal:v1',
        intent_id: migrated.intent_id,
      });
      assert.equal(readLedger(cwd).length, ledger.length, 'the rerun writes no record');
    } finally {
      client.close();
    }
  });

  test('MCP migration errors preserve exact code and message', async () => {
    const requiredClient = new McpClient(freshCwd());
    try {
      await seedLegacyThroughTools(requiredClient);
      const required = errorText(await requiredClient.callTool('judgment_goal_write', ratifiedGoalCut));
      assert.equal(required, `Error [JUDGMENT_MIGRATION_REQUIRED]: ${MIGRATION_REQUIRED_MESSAGE}`);
    } finally {
      requiredClient.close();
    }

    // The non-empty-chain and revived conflicts are unreachable across stdio:
    // C6 retires the objective as soon as ANY goal version exists, so neither a
    // live objective beside an ordinary cut nor a revived one can be built
    // through the tools. The no-live-objective conflict is the reachable one.
    const conflictClient = new McpClient(freshCwd());
    try {
      const conflict = errorText(await conflictClient.callTool('judgment_goal_write', { op: 'migrate' }));
      assert.equal(conflict, `Error [JUDGMENT_MIGRATION_CONFLICT]: ${MIGRATION_CONFLICT_MESSAGE}`);
    } finally {
      conflictClient.close();
    }

    const retiredClient = new McpClient(freshCwd());
    try {
      await seedLegacyThroughTools(retiredClient);
      parseToolText(await retiredClient.callTool('judgment_goal_write', { op: 'migrate' }));
      const retired = errorText(await retiredClient.callTool('judgment_position_create', {
        slug: 'objective',
        claims: [{ id: 'c1', text: 'Revive the objective.', grounding: 'INT' }],
        conviction: { level: 'high', source: 'stated' },
      }));
      assert.equal(retired, `Error [JUDGMENT_OBJECTIVE_RETIRED]: ${OBJECTIVE_RETIRED_MESSAGE}`);
    } finally {
      retiredClient.close();
    }
  });

  test('next read repairs a killed clear-to-regenerate window', async () => {
    const cwd = freshCwd();
    const client = new McpClient(cwd);
    try {
      await seedLegacyThroughTools(client);

      // Obstruct exactly one generated file so the post-clear regeneration
      // dies where a kill would: canonical effects committed, surfaces stale.
      // It must NOT be OBJECTIVE.md — the migration reads that to build the
      // note, so obstructing it fails before any canonical write.
      const objectivePath = join(cwd, 'docs', 'judgment', 'OBJECTIVE.md');
      const obstruction = join(cwd, 'docs', 'judgment', 'index.md');
      rmSync(obstruction);
      mkdirSync(obstruction);
      writeFileSync(join(obstruction, '.keep'), 'obstruction\n');

      const stale = errorText(await client.callTool('judgment_goal_write', { op: 'migrate' }));
      assert.match(stale, /Error \[JUDGMENT_PROJECTION_STALE\]/);
      assert.match(stale, /canonical effects are committed but projections are stale/);
      assert.ok(existsSync(recordsPath(cwd, 'goal', 'v1.json')), 'the cutover records are committed');
      assert.deepEqual(pendingIntentIds(cwd), [], 'the intent is already cleared');
      assert.ok(existsSync(join(obstruction, '.keep')), 'the obstructed surface never regenerated');

      rmSync(obstruction, { recursive: true });
      const state = parseToolText(await client.callTool('get_judgment_state', {}));
      assert.equal(state.positions.find((position) => position.slug === 'objective').status, 'retracted');

      assert.equal(checkProjectionRoundtrip(cwd).fixedPoint, true, 'the next read repairs the window');
      assert.match(
        readFileSync(objectivePath, 'utf8'),
        /build Compose into a system that decides what to build well\./,
      );
    } finally {
      client.close();
    }
  });
});

describe('reviewer gate enforced end-to-end (phaseScopedTools workspace)', () => {
  test('reviewer session: judgment writes PHASE_TOOL_DENIED, get_judgment_state allowed', async () => {
    const cwd = freshCwd();
    mkdirSync(join(cwd, '.compose'), { recursive: true });
    writeFileSync(
      join(cwd, '.compose', 'compose.json'),
      JSON.stringify({ capabilities: { phaseScopedTools: true } }),
    );
    const client = new McpClient(cwd, { COMPOSE_SESSION_PROFILE: 'reviewer' });
    try {
      const denied = errorText(await client.callTool('judgment_position_create', {
        slug: 'nope',
        claims: [{ id: 'c1', text: 't', grounding: 'INT' }],
        conviction: { level: 'low', source: 'inferred' },
      }));
      assert.match(denied, /PHASE_TOOL_DENIED/);
      for (const tool of Object.keys(NEW_JUDGMENT_TOOL_OPS)) {
        const newDenied = errorText(await client.callTool(tool, {}));
        assert.match(newDenied, /PHASE_TOOL_DENIED/, `${tool} must be denied before writer validation`);
        assert.doesNotMatch(newDenied, /JUDGMENT_INPUT/, `${tool} must not reach writer validation`);
      }
      const state = parseToolText(await client.callTool('get_judgment_state', {}));
      assert.deepEqual(state.positions, []);
    } finally {
      client.close();
    }
  });
});

describe('mcp-tool-policy — judgment entries', () => {
  test('reviewer: write tools denied, get_judgment_state allowed', () => {
    for (const tool of JUDGMENT_TOOLS.filter((t) => t !== 'get_judgment_state')) {
      assert.equal(isToolAllowed({ tool, profile: 'reviewer' }).allowed, false, `${tool} must be denied to reviewer`);
    }
    assert.equal(isToolAllowed({ tool: 'get_judgment_state', profile: 'reviewer' }).allowed, true);
  });

  test('implementer and orchestrator may write judgment canon', () => {
    for (const tool of JUDGMENT_TOOLS) {
      assert.equal(isToolAllowed({ tool, profile: 'implementer' }).allowed, true, `${tool} allowed for implementer`);
      assert.equal(isToolAllowed({ tool, profile: 'orchestrator' }).allowed, true, `${tool} allowed for orchestrator`);
    }
  });
});
