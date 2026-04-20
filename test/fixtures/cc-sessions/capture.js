#!/usr/bin/env node
/**
 * capture.js — CC-session JSONL fixture producer
 *
 * This script has two modes:
 *
 *   1. Scrub mode (default, used when re-capturing from real disk):
 *        node capture.js scrub <source.jsonl> <dest.jsonl>
 *      Reads a real session JSONL from ~/.claude/projects/<slug>/*.jsonl,
 *      strips user-identifying content, writes to the fixture path.
 *
 *   2. Synth mode (what produced the committed fixtures):
 *        node capture.js synth
 *      Deterministically builds all six fixture JSONL files + the
 *      multi-session-same-feature/ directory from pure data — no disk reads.
 *      Use this to regenerate fixtures from scratch when CC format changes.
 *
 * -------------------------------------------------------------------------
 * Source-filename → fixture-path mapping (historical reference only — the
 * committed fixtures were produced by synth mode for determinism, but each
 * fixture's record shape mirrors what was observed in these real sessions):
 *
 *   ~/.claude/projects/-Users-ruze-reg-my-forge/
 *     c6596ebc-da1f-490b-8d35-ae581489d150.jsonl  →  linear-session.jsonl
 *     c19a2c46-a126-4709-bd01-393964c10854.jsonl  →  forked-session-two-branches.jsonl
 *     0e47c2a7-524b-4706-a4bf-9739f41cc2ff.jsonl  →  forked-session-three-branches.jsonl  (shape only; trimmed)
 *     24a4cabe-2aa1-4b71-988b-6e449d64a449.jsonl  →  mid-progress-session.jsonl            (shape only; trimmed)
 *     37817895-b4b0-4616-8eb3-ee32be8f19a5.jsonl  →  failed-branch-session.jsonl           (is_error pattern)
 *     51b6208c-f3ef-4aa5-97df-654b3dfe44bc.jsonl  →  truncated-session.jsonl               (tail chopped)
 *     97b7270a-9fcf-4765-9fea-180144a6f429.jsonl  →  multi-session-same-feature/session-a.jsonl
 *     49adb308-73f3-4d20-a955-3e7a896a1637.jsonl  →  multi-session-same-feature/session-b.jsonl
 *
 * Scrub rules applied by scrub-mode (matches what synth-mode embeds):
 *   - message.content[].text                  → "[scrubbed]"
 *   - tool_use.input.file_path                → keep first segment if inside repo,
 *                                                else "test/scrubbed.md"
 *   - tool_use.input.command                  → "echo scrubbed"
 *   - tool_result.content                     → "[scrubbed output]"
 *                                                (preserves is_error, exit_code)
 *   KEEP: uuid, parentUuid, isSidechain, type, timestamp, cwd,
 *         message.role, message.model, message.usage, requestId,
 *         tool_use.name, tool_use.id, is_error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -------------------------------------------------------------------------
// Scrubbing — public surface, also used by scrub mode.
// -------------------------------------------------------------------------

const REPO_ROOT = '/Users/ruze/reg/my/forge';

function scrubFilePath(p) {
  if (typeof p !== 'string') return p;
  if (!p.startsWith(REPO_ROOT)) return 'test/scrubbed.md';
  // keep first meaningful segment after repo root
  const rel = p.slice(REPO_ROOT.length + 1);
  return rel || 'test/scrubbed.md';
}

function scrubRecord(rec) {
  const out = JSON.parse(JSON.stringify(rec));
  const msg = out.message;
  if (msg && Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (c.type === 'text' && typeof c.text === 'string') c.text = '[scrubbed]';
      if (c.type === 'thinking' && typeof c.thinking === 'string') c.thinking = '[scrubbed]';
      if (c.type === 'tool_use' && c.input) {
        if (typeof c.input.file_path === 'string') c.input.file_path = scrubFilePath(c.input.file_path);
        if (typeof c.input.command === 'string') c.input.command = 'echo scrubbed';
        // scrub other large string inputs (prompt-like fields)
        for (const k of ['prompt', 'description', 'old_string', 'new_string', 'content', 'pattern']) {
          if (typeof c.input[k] === 'string') c.input[k] = '[scrubbed]';
        }
      }
      if (c.type === 'tool_result') {
        if (typeof c.content === 'string') c.content = '[scrubbed output]';
        if (Array.isArray(c.content)) {
          c.content = c.content.map(x => ({ ...x, text: '[scrubbed output]' }));
        }
        // keep is_error as-is
      }
    }
  } else if (msg && typeof msg.content === 'string') {
    msg.content = '[scrubbed]';
  }
  // top-level scrub fields
  if (typeof out.toolUseResult === 'string') out.toolUseResult = '[scrubbed output]';
  if (out.toolUseResult && typeof out.toolUseResult === 'object') {
    // preserve any exit_code or interrupted flag
    const keep = {};
    for (const k of ['exit_code', 'interrupted', 'type']) if (k in out.toolUseResult) keep[k] = out.toolUseResult[k];
    out.toolUseResult = { ...keep, content: '[scrubbed output]' };
  }
  if (typeof out.content === 'string' && out.type === 'system') out.content = '[scrubbed system message]';
  return out;
}

function scrubMode(srcPath, destPath) {
  const lines = fs.readFileSync(srcPath, 'utf8').split('\n').filter(l => l.trim());
  const out = [];
  for (const l of lines) {
    try {
      out.push(JSON.stringify(scrubRecord(JSON.parse(l))));
    } catch (_) {
      // skip unparseable
    }
  }
  fs.writeFileSync(destPath, out.join('\n') + '\n');
  console.log(`wrote ${out.length} scrubbed records → ${destPath}`);
}

// -------------------------------------------------------------------------
// Synth mode — builds fixtures from structured templates.
// -------------------------------------------------------------------------

const HERE = __dirname;
void HERE;
const CWD = '/Users/ruze/reg/my/forge';
const VERSION = '2.1.68';
const MODEL = 'claude-sonnet-4-6';

const BASE_TIME = Date.parse('2026-04-15T10:00:00.000Z');
let tick = 0;
function ts() { return new Date(BASE_TIME + (tick++) * 1000).toISOString(); }

function resetTicker() { tick = 0; }

function usage() {
  return {
    input_tokens: 3,
    cache_creation_input_tokens: 1200,
    cache_read_input_tokens: 8500,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1200 },
    output_tokens: 45,
    service_tier: 'standard',
    inference_geo: 'not_available',
  };
}

// deterministic uuid generator (not RFC-compliant, but shape-compatible and stable across runs)
function mkUuid(sessionId, n) {
  // sessionId is 8-4-4-4-12 hex; derive a stable per-record uuid
  const hex = (n).toString(16).padStart(12, '0');
  return `${sessionId.slice(0, 8)}-${sessionId.slice(9, 13)}-${sessionId.slice(14, 18)}-${sessionId.slice(19, 23)}-${hex}`;
}

function systemRoot(sessionId) {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'system',
    subtype: 'bridge_status',
    content: '[scrubbed system message]',
    isMeta: false,
    timestamp: ts(),
    uuid: mkUuid(sessionId, 1),
    userType: 'external',
    entrypoint: 'cli',
    cwd: CWD,
    sessionId,
    version: VERSION,
    gitBranch: 'main',
  };
}

function userMsg(sessionId, parentUuid, uuidN) {
  return {
    parentUuid,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: '[scrubbed]' },
    uuid: mkUuid(sessionId, uuidN),
    timestamp: ts(),
    userType: 'external',
    cwd: CWD,
    sessionId,
    version: VERSION,
    gitBranch: 'main',
  };
}

function assistantText(sessionId, parentUuid, uuidN, reqId) {
  return {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: CWD,
    sessionId,
    version: VERSION,
    gitBranch: 'main',
    message: {
      model: MODEL,
      id: `msg_${uuidN.toString(16).padStart(8, '0')}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '[scrubbed]' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: usage(),
    },
    requestId: reqId,
    type: 'assistant',
    uuid: mkUuid(sessionId, uuidN),
    timestamp: ts(),
  };
}

function assistantToolUse(sessionId, parentUuid, uuidN, reqId, toolName, toolId, input) {
  return {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: CWD,
    sessionId,
    version: VERSION,
    gitBranch: 'main',
    message: {
      model: MODEL,
      id: `msg_${uuidN.toString(16).padStart(8, '0')}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: usage(),
    },
    requestId: reqId,
    type: 'assistant',
    uuid: mkUuid(sessionId, uuidN),
    timestamp: ts(),
  };
}

function toolResult(sessionId, parentUuid, uuidN, toolId, { isError = false, content = '[scrubbed output]' } = {}) {
  const resultItem = { tool_use_id: toolId, type: 'tool_result', content };
  if (isError) resultItem.is_error = true;
  return {
    parentUuid,
    isSidechain: false,
    userType: 'external',
    cwd: CWD,
    sessionId,
    version: VERSION,
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content: [resultItem] },
    uuid: mkUuid(sessionId, uuidN),
    timestamp: ts(),
  };
}

function writeJsonl(filePath, records, { truncate = false } = {}) {
  const lines = records.map(r => JSON.stringify(r));
  let out = lines.join('\n');
  if (!truncate) out += '\n';
  else {
    // Append one intentionally-broken tail line: truncated JSON, no newline.
    out += '\n{"parentUuid":"' + records[records.length - 1].uuid + '","isSidechain":false,"type":"assis';
  }
  fs.writeFileSync(filePath, out);
}

// --- Fixture 1: linear-session.jsonl -------------------------------------
// A simple linear chain ending in a tool_result (state=complete).
function buildLinear() {
  resetTicker();
  const sid = '11111111-1111-4111-8111-000000000001';
  const recs = [];
  const root = systemRoot(sid); recs.push(root);
  const u1 = userMsg(sid, root.uuid, 2); recs.push(u1);
  const a1 = assistantText(sid, u1.uuid, 3, 'req_lin_001'); recs.push(a1);
  const a2 = assistantToolUse(sid, a1.uuid, 4, 'req_lin_002', 'Edit', 'toolu_lin_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/plan.md',
    old_string: '[scrubbed]',
    new_string: '[scrubbed]',
  }); recs.push(a2);
  const tr1 = toolResult(sid, a2.uuid, 5, 'toolu_lin_01'); recs.push(tr1);
  const a3 = assistantToolUse(sid, tr1.uuid, 6, 'req_lin_003', 'Write', 'toolu_lin_02', {
    file_path: 'docs/features/COMP-OBS-BRANCH/report.md',
    content: '[scrubbed]',
  }); recs.push(a3);
  const tr2 = toolResult(sid, a3.uuid, 7, 'toolu_lin_02'); recs.push(tr2);
  const a4 = assistantText(sid, tr2.uuid, 8, 'req_lin_004'); recs.push(a4);
  writeJsonl(path.join(HERE, 'linear-session.jsonl'), recs);
}

// --- Fixture 2: forked-session-two-branches.jsonl ------------------------
// One fork point; two non-sidechain user-message children; both complete.
function buildForkTwo() {
  resetTicker();
  const sid = '22222222-2222-4222-8222-000000000002';
  const recs = [];
  const root = systemRoot(sid); recs.push(root);
  const u1 = userMsg(sid, root.uuid, 2); recs.push(u1);
  const a1 = assistantText(sid, u1.uuid, 3, 'req_f2_001'); recs.push(a1);
  // Fork point: a1 has two user children (a rewind / re-prompt).
  // Branch A
  const uA = userMsg(sid, a1.uuid, 10); recs.push(uA);
  const aA1 = assistantToolUse(sid, uA.uuid, 11, 'req_f2_a01', 'Edit', 'toolu_f2a_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/design.md',
    old_string: '[scrubbed]',
    new_string: '[scrubbed]',
  }); recs.push(aA1);
  const trA = toolResult(sid, aA1.uuid, 12, 'toolu_f2a_01'); recs.push(trA);
  const aA2 = assistantText(sid, trA.uuid, 13, 'req_f2_a02'); recs.push(aA2);
  // Branch B
  const uB = userMsg(sid, a1.uuid, 20); recs.push(uB);
  const aB1 = assistantToolUse(sid, uB.uuid, 21, 'req_f2_b01', 'Write', 'toolu_f2b_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/plan.md',
    content: '[scrubbed]',
  }); recs.push(aB1);
  const trB = toolResult(sid, aB1.uuid, 22, 'toolu_f2b_01'); recs.push(trB);
  const aB2 = assistantText(sid, trB.uuid, 23, 'req_f2_b02'); recs.push(aB2);
  writeJsonl(path.join(HERE, 'forked-session-two-branches.jsonl'), recs);
}

// --- Fixture 3: forked-session-three-branches.jsonl ----------------------
function buildForkThree() {
  resetTicker();
  const sid = '33333333-3333-4333-8333-000000000003';
  const recs = [];
  const root = systemRoot(sid); recs.push(root);
  const u1 = userMsg(sid, root.uuid, 2); recs.push(u1);
  const a1 = assistantText(sid, u1.uuid, 3, 'req_f3_001'); recs.push(a1);
  // three sibling user messages under a1
  for (const [tag, base] of [['a', 10], ['b', 20], ['c', 30]]) {
    const u = userMsg(sid, a1.uuid, base); recs.push(u);
    const tu = assistantToolUse(sid, u.uuid, base + 1, `req_f3_${tag}01`, 'Edit', `toolu_f3${tag}_01`, {
      file_path: `docs/features/COMP-OBS-BRANCH/branch-${tag}.md`,
      old_string: '[scrubbed]',
      new_string: '[scrubbed]',
    }); recs.push(tu);
    const tr = toolResult(sid, tu.uuid, base + 2, `toolu_f3${tag}_01`); recs.push(tr);
    const at = assistantText(sid, tr.uuid, base + 3, `req_f3_${tag}02`); recs.push(at);
  }
  writeJsonl(path.join(HERE, 'forked-session-three-branches.jsonl'), recs);
}

// --- Fixture 4: mid-progress-session.jsonl -------------------------------
// Branch A complete; Branch B running (tip is assistant tool_use with NO tool_result).
function buildMidProgress() {
  resetTicker();
  const sid = '44444444-4444-4444-8444-000000000004';
  const recs = [];
  const root = systemRoot(sid); recs.push(root);
  const u1 = userMsg(sid, root.uuid, 2); recs.push(u1);
  const a1 = assistantText(sid, u1.uuid, 3, 'req_mp_001'); recs.push(a1);
  // Branch A — complete
  const uA = userMsg(sid, a1.uuid, 10); recs.push(uA);
  const aA1 = assistantToolUse(sid, uA.uuid, 11, 'req_mp_a01', 'Edit', 'toolu_mpa_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/design.md',
    old_string: '[scrubbed]',
    new_string: '[scrubbed]',
  }); recs.push(aA1);
  const trA = toolResult(sid, aA1.uuid, 12, 'toolu_mpa_01'); recs.push(trA);
  const aA2 = assistantText(sid, trA.uuid, 13, 'req_mp_a02'); recs.push(aA2);
  // Branch B — still running: last record is an assistant tool_use with NO matching tool_result.
  const uB = userMsg(sid, a1.uuid, 20); recs.push(uB);
  const aB1 = assistantText(sid, uB.uuid, 21, 'req_mp_b01'); recs.push(aB1);
  const aB2 = assistantToolUse(sid, aB1.uuid, 22, 'req_mp_b02', 'Read', 'toolu_mpb_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/blueprint.md',
  }); recs.push(aB2);
  // deliberately no tool_result after aB2 — the session is still running.
  writeJsonl(path.join(HERE, 'mid-progress-session.jsonl'), recs);
}

// --- Fixture 5: failed-branch-session.jsonl ------------------------------
// Branch A complete; Branch B terminates in is_error:true tool_result.
// State classifier shape chosen: assistant-tool_use → user-tool_result with is_error:true
// (matches the real `37817895…` session we observed).
function buildFailed() {
  resetTicker();
  const sid = '55555555-5555-4555-8555-000000000005';
  const recs = [];
  const root = systemRoot(sid); recs.push(root);
  const u1 = userMsg(sid, root.uuid, 2); recs.push(u1);
  const a1 = assistantText(sid, u1.uuid, 3, 'req_fa_001'); recs.push(a1);
  // Branch A — complete
  const uA = userMsg(sid, a1.uuid, 10); recs.push(uA);
  const aA1 = assistantToolUse(sid, uA.uuid, 11, 'req_fa_a01', 'Edit', 'toolu_faa_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/plan.md',
    old_string: '[scrubbed]',
    new_string: '[scrubbed]',
  }); recs.push(aA1);
  const trA = toolResult(sid, aA1.uuid, 12, 'toolu_faa_01'); recs.push(trA);
  const aA2 = assistantText(sid, trA.uuid, 13, 'req_fa_a02'); recs.push(aA2);
  // Branch B — fails via is_error tool_result, then branch stops.
  const uB = userMsg(sid, a1.uuid, 20); recs.push(uB);
  const aB1 = assistantToolUse(sid, uB.uuid, 21, 'req_fa_b01', 'Bash', 'toolu_fab_01', {
    command: 'echo scrubbed',
    description: '[scrubbed]',
  }); recs.push(aB1);
  const trB = toolResult(sid, aB1.uuid, 22, 'toolu_fab_01', { isError: true, content: '[scrubbed output]' }); recs.push(trB);
  writeJsonl(path.join(HERE, 'failed-branch-session.jsonl'), recs);
}

// --- Fixture 6: truncated-session.jsonl ----------------------------------
// Valid records then a final non-newline-terminated, non-JSON-parseable line.
function buildTruncated() {
  resetTicker();
  const sid = '66666666-6666-4666-8666-000000000006';
  const recs = [];
  const root = systemRoot(sid); recs.push(root);
  const u1 = userMsg(sid, root.uuid, 2); recs.push(u1);
  const a1 = assistantText(sid, u1.uuid, 3, 'req_tr_001'); recs.push(a1);
  const a2 = assistantToolUse(sid, a1.uuid, 4, 'req_tr_002', 'Edit', 'toolu_tr_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/plan.md',
    old_string: '[scrubbed]',
    new_string: '[scrubbed]',
  }); recs.push(a2);
  const tr1 = toolResult(sid, a2.uuid, 5, 'toolu_tr_01'); recs.push(tr1);
  writeJsonl(path.join(HERE, 'truncated-session.jsonl'), recs, { truncate: true });
}

// --- Fixture 7: multi-session-same-feature/ ------------------------------
// Two separate complete linear sessions. Both will be bound to the same
// feature via sessions.json (join handled by T2); the JSONL files themselves
// carry no feature hint.
function buildMultiSession() {
  const dir = path.join(HERE, 'multi-session-same-feature');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Session A
  resetTicker();
  const sidA = '77777777-7777-4777-8777-00000000000a';
  const recsA = [];
  const rA = systemRoot(sidA); recsA.push(rA);
  const uA1 = userMsg(sidA, rA.uuid, 2); recsA.push(uA1);
  const aA1 = assistantToolUse(sidA, uA1.uuid, 3, 'req_msa_001', 'Edit', 'toolu_msa_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/design.md',
    old_string: '[scrubbed]',
    new_string: '[scrubbed]',
  }); recsA.push(aA1);
  const trA = toolResult(sidA, aA1.uuid, 4, 'toolu_msa_01'); recsA.push(trA);
  const aA2 = assistantText(sidA, trA.uuid, 5, 'req_msa_002'); recsA.push(aA2);
  writeJsonl(path.join(dir, `${sidA}.jsonl`), recsA);
  // Session B
  resetTicker();
  const sidB = '88888888-8888-4888-8888-00000000000b';
  const recsB = [];
  const rB = systemRoot(sidB); recsB.push(rB);
  const uB1 = userMsg(sidB, rB.uuid, 2); recsB.push(uB1);
  const aB1 = assistantToolUse(sidB, uB1.uuid, 3, 'req_msb_001', 'Write', 'toolu_msb_01', {
    file_path: 'docs/features/COMP-OBS-BRANCH/plan.md',
    content: '[scrubbed]',
  }); recsB.push(aB1);
  const trB = toolResult(sidB, aB1.uuid, 4, 'toolu_msb_01'); recsB.push(trB);
  const aB2 = assistantText(sidB, trB.uuid, 5, 'req_msb_002'); recsB.push(aB2);
  writeJsonl(path.join(dir, `${sidB}.jsonl`), recsB);
}

function synthMode() {
  buildLinear();
  buildForkTwo();
  buildForkThree();
  buildMidProgress();
  buildFailed();
  buildTruncated();
  buildMultiSession();
  console.log('synth complete — all fixtures written to', HERE);
}

// -------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [, , mode, src, dest] = process.argv;
  if (mode === 'scrub') {
    if (!src || !dest) { console.error('usage: capture.js scrub <source.jsonl> <dest.jsonl>'); process.exit(2); }
    scrubMode(src, dest);
  } else if (mode === 'synth' || !mode) {
    synthMode();
  } else {
    console.error('unknown mode:', mode);
    process.exit(2);
  }
}

export { scrubRecord, scrubFilePath };
