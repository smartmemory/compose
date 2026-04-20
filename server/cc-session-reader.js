/**
 * CC JSONL session reader — COMP-OBS-BRANCH T1.
 *
 * Walks a single `~/.claude/projects/<slug>/<session-id>.jsonl`, parses records,
 * builds a parent-pointer tree over non-sidechain records, identifies leaves,
 * classifies per-branch state, and derives the BranchOutcome metrics required by
 * the shared Wave 6 contract (docs/features/COMP-OBS-CONTRACT/schema.json).
 *
 * Producer-side only. The `feature_code` field is injected later by the watcher
 * (T5) using the CC-session feature resolver (T2); records emitted here omit it.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const WRITE_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const TEST_RUNNER_RE = /(pytest|jest|vitest|mocha|node\s+--test|npm\s+(run\s+)?test|go\s+test|cargo\s+test)/i;
const PASS_FAIL_RE = /(\d+)\s+passed(?:[^\n]*?\s(\d+)\s+failed)?(?:[^\n]*?\s(\d+)\s+skipped)?/i;

function sha1(s) { return createHash('sha1').update(s).digest('hex'); }

function parseJsonlSafe(text) {
  const out = [];
  const lines = text.split('\n');
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Any unparseable line (middle or trailing) marks the session as truncated
      // so the downstream classifier surfaces `unknown` rather than silently dropping
      // potentially load-bearing records (e.g. a result/error line).
      truncated = true;
    }
  }
  return { records: out, truncated };
}

function contentArray(msg) {
  const c = msg?.content;
  if (!c) return [];
  return Array.isArray(c) ? c : [];
}

function hasIsErrorToolResult(rec) {
  return rec?.type === 'user' &&
    contentArray(rec.message).some(item => item?.type === 'tool_result' && item?.is_error === true);
}

function classifyLeafState(leaf, childrenByParent) {
  if (!leaf) return 'unknown';
  if (hasIsErrorToolResult(leaf)) return 'failed';
  if (leaf.type === 'user') {
    const hasToolResult = contentArray(leaf.message).some(it => it?.type === 'tool_result');
    if (hasToolResult) return 'complete';
  }
  if (leaf.type === 'assistant') {
    const stopReason = leaf.message?.stop_reason;
    if (stopReason === 'end_turn') return 'complete';
    const hasUse = contentArray(leaf.message).some(it => it?.type === 'tool_use');
    if (hasUse) {
      const kids = childrenByParent.get(leaf.uuid) || [];
      if (kids.length === 0) return 'running';
    }
  }
  return 'unknown';
}

function walkPath(leafUuid, byUuid) {
  const path = [];
  let cur = byUuid.get(leafUuid);
  while (cur) {
    path.push(cur);
    if (!cur.parentUuid) break;
    cur = byUuid.get(cur.parentUuid);
  }
  return path.reverse();
}

function findForkUuid(path, forkPointUuids) {
  for (let i = path.length - 1; i >= 0; i--) {
    if (forkPointUuids.has(path[i].uuid)) return path[i].uuid;
  }
  return null;
}

function firstPostForkIndex(path, forkUuid) {
  if (!forkUuid) return 0;
  const idx = path.findIndex(r => r.uuid === forkUuid);
  return idx >= 0 ? idx + 1 : 0;
}

function extractMetricsForPath(path, fullRecords) {
  let turnCount = 0;
  const fileStats = new Map();
  let testsPassed = 0, testsFailed = 0, testsSkipped = 0;
  const runIds = new Set();
  let tokensIn = 0, tokensOut = 0, cacheReadIn = 0, cacheCreation = 0;
  let finalArtifact = null;
  let lastWriteIdx = -1;

  const childrenByParent = new Map();
  for (const r of fullRecords) {
    if (!r?.uuid) continue;
    const p = r.parentUuid || null;
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(r);
  }

  let lastUserTurnIdx = -1;
  for (let i = 0; i < path.length; i++) {
    const r = path[i];
    if (r.type === 'user') {
      turnCount++;
      lastUserTurnIdx = i;
    }
    if (r.type === 'assistant') {
      const usage = r.message?.usage || {};
      tokensIn += (usage.input_tokens || 0);
      tokensOut += (usage.output_tokens || 0);
      cacheReadIn += (usage.cache_read_input_tokens || 0);
      cacheCreation += (usage.cache_creation_input_tokens || 0);
      for (const item of contentArray(r.message)) {
        if (item?.type === 'tool_use') {
          if (WRITE_TOOL_NAMES.has(item.name)) {
            const filePath = item.input?.file_path;
            if (filePath) {
              if (!fileStats.has(filePath)) fileStats.set(filePath, new Set());
              fileStats.get(filePath).add(lastUserTurnIdx);
              lastWriteIdx = i;
            }
          }
          if (item.name === 'Bash' && r.requestId) {
            const cmd = item.input?.command || '';
            if (TEST_RUNNER_RE.test(cmd)) runIds.add(r.requestId);
          }
        }
      }
    }
    if (r.type === 'user') {
      for (const item of contentArray(r.message)) {
        if (item?.type === 'tool_result') {
          const content = item.content;
          const stdout = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.map(c => c?.text || '').join('\n')
              : '';
          const m = stdout.match(PASS_FAIL_RE);
          if (m) {
            testsPassed += parseInt(m[1] || '0', 10);
            testsFailed += parseInt(m[2] || '0', 10);
            testsSkipped += parseInt(m[3] || '0', 10);
          }
        }
      }
    }
  }

  if (lastWriteIdx >= 0) {
    const writeRec = path[lastWriteIdx];
    for (const item of contentArray(writeRec.message)) {
      if (item?.type === 'tool_use' && WRITE_TOOL_NAMES.has(item.name)) {
        const fp = item.input?.file_path;
        if (!fp) continue;
        if (fp.includes('docs/features/')) {
          const kind = inferArtifactKind(fp);
          finalArtifact = { path: fp, kind, snapshot: null };
          break;
        } else if (!finalArtifact) {
          finalArtifact = { path: fp, kind: inferArtifactKind(fp), snapshot: null };
        }
      }
    }
  }

  const files = [];
  for (const [path, turnSet] of fileStats.entries()) {
    files.push({ path, turns_modified: Math.max(1, turnSet.size) });
  }
  return {
    turnCount,
    files,
    tests: {
      passed: testsPassed,
      failed: testsFailed,
      skipped: testsSkipped,
      run_ids: [...runIds],
    },
    cost: {
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cache_read_input_tokens: cacheReadIn,
      cache_creation_input_tokens: cacheCreation,
    },
    finalArtifact,
  };
}

function inferArtifactKind(filePath) {
  const name = basename(filePath).toLowerCase();
  if (name === 'design.md') return 'design';
  if (name === 'plan.md') return 'plan';
  if (name === 'prd.md') return 'prd';
  if (name === 'blueprint.md') return 'blueprint';
  if (name === 'report.md') return 'report';
  if (name.endsWith('.diff') || name.endsWith('.patch')) return 'diff';
  if (name.endsWith('.md')) return 'other';
  return 'other';
}

function costUsd(tokensIn, tokensOut) {
  const inRate = Number(process.env.CC_USD_PER_1K_INPUT || 0);
  const outRate = Number(process.env.CC_USD_PER_1K_OUTPUT || 0);
  if (!inRate && !outRate) return 0;
  return (tokensIn / 1000) * inRate + (tokensOut / 1000) * outRate;
}

export async function readCCSession(jsonlPath) {
  const cc_session_id = basename(jsonlPath).replace(/\.jsonl$/, '');
  const raw = readFileSync(jsonlPath, 'utf8');
  const { records, truncated } = parseJsonlSafe(raw);

  const byUuid = new Map();
  for (const r of records) {
    if (r?.uuid && r.isSidechain !== true) byUuid.set(r.uuid, r);
  }

  const childrenByParent = new Map();
  for (const r of byUuid.values()) {
    const p = r.parentUuid || null;
    if (!childrenByParent.has(p)) childrenByParent.set(p, []);
    childrenByParent.get(p).push(r);
  }

  const forkPointUuids = new Set();
  for (const [parent, kids] of childrenByParent.entries()) {
    if (parent == null) continue;
    const userKids = kids.filter(k => k.type === 'user');
    if (userKids.length >= 2) forkPointUuids.add(parent);
  }

  const leaves = [];
  for (const r of byUuid.values()) {
    const kids = childrenByParent.get(r.uuid) || [];
    if (kids.length === 0) leaves.push(r);
  }

  const branches = [];
  const forkMap = new Map();
  for (const leaf of leaves) {
    const path = walkPath(leaf.uuid, byUuid);
    if (path.length === 0) continue;

    let state = classifyLeafState(leaf, childrenByParent);

    const forkUuid = findForkUuid(path, forkPointUuids);
    const startIdx = firstPostForkIndex(path, forkUuid);
    const branchPath = path.slice(startIdx);

    // If any line in the file was unparseable, we may have lost records that
    // would have classified a `running` leaf as `complete` (a missing tool_result).
    // `failed` and `complete` both have positive identifications on the leaf itself
    // (is_error / end_turn) so they remain trustworthy; `running` depends on the
    // absence of a child record and becomes unreliable under truncation.
    if (truncated && state === 'running') state = 'unknown';

    const terminal = state === 'complete' || state === 'failed';
    const startedAtRec = branchPath[0] || path[0];
    const started_at = startedAtRec?.timestamp || null;
    const ended_at = terminal ? (leaf.timestamp || null) : null;

    let metrics = null;
    if (terminal) {
      metrics = extractMetricsForPath(branchPath, [...byUuid.values()]);
    }

    const branch_id = sha1(cc_session_id + ':' + leaf.uuid);

    const outcome = {
      branch_id,
      cc_session_id,
      fork_uuid: forkUuid,
      leaf_uuid: leaf.uuid,
      parent_branch_id: null,
      state,
      started_at,
      ended_at,
      turn_count: terminal ? metrics.turnCount : null,
      files_touched: terminal ? metrics.files : null,
      tests: terminal ? metrics.tests : null,
      cost: terminal
        ? {
            tokens_in: metrics.cost.tokens_in,
            tokens_out: metrics.cost.tokens_out,
            usd: costUsd(metrics.cost.tokens_in, metrics.cost.tokens_out),
            wall_clock_ms: started_at && ended_at ? Math.max(0, Date.parse(ended_at) - Date.parse(started_at)) : null,
          }
        : null,
      final_artifact: terminal ? metrics.finalArtifact : null,
      drift_axes_snapshot: null,
      open_loops_produced: [],
    };

    if (forkUuid) {
      if (!forkMap.has(forkUuid)) forkMap.set(forkUuid, []);
      forkMap.get(forkUuid).push(leaf.uuid);
    }

    branches.push(outcome);
  }

  const fork_points = [];
  for (const [parent_uuid, child_leaf_uuids] of forkMap.entries()) {
    fork_points.push({ parent_uuid, child_leaf_uuids });
  }

  return {
    cc_session_id,
    branches,
    fork_points,
    truncated,
  };
}
