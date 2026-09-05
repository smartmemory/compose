#!/usr/bin/env node
/**
 * Compose MCP Server — stdio transport
 *
 * Exposes Compose tracker state as MCP tools for Claude Code agents running
 * inside this project. Claude Code launches this process on-demand and
 * communicates via stdin/stdout JSON-RPC. No port, no supervisor entry.
 *
 * Register in .mcp.json:
 *   { "mcpServers": { "compose": { "command": "node", "args": ["server/compose-mcp.js"] } } }
 *
 * Tools:
 *   get_vision_items     — query items by phase/status/type/keyword
 *   get_item_detail      — single item with its connections
 *   get_current_session  — active session: tool count, items touched, summaries
 *   get_phase_summary    — status distribution for a given phase
 *   get_blocked_items    — items blocked by non-complete dependencies
 *
 * Token budget (per docs/features/mcp-connector/design.md Decision 6):
 *   Baseline (2026-02-24): ~519 tokens for all 5 tool definitions combined
 *   Soft cap: 2,000 tokens. Add typed tools for new operations; avoid proliferation.
 *   Per-tool: get_vision_items 235, get_phase_summary 104,
 *   get_item_detail 72, get_current_session 62, get_blocked_items 44
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeSync } from 'node:fs';
import {
  toolGetVisionItems,
  toolGetRoadmap,
  toolGetItemDetail,
  toolGetPhasesSummary,
  toolGetBlockedItems,
  toolGetCurrentSession,
  toolGetFeatureLifecycle,
  toolKillFeature,
  toolCompleteFeature,
  toolAssessFeatureArtifacts,
  toolScaffoldFeature,
  toolApproveGate,
  toolGetPendingGates,
  toolBindSession,
  toolIterationStart,
  toolIterationReport,
  toolIterationAbort,
  toolAddRoadmapEntry,
  toolSetFeatureStatus,
  toolRoadmapDiff,
  toolLinkArtifact,
  toolLinkFeatures,
  toolGetFeatureArtifacts,
  toolGetFeatureLinks,
  toolProposeFollowup,
  toolAddChangelogEntry,
  toolCanonOverrideGrant,
  toolGetChangelogEntries,
  toolWriteJournalEntry,
  toolGetJournalEntries,
  toolRecordCompletion,
  toolGetCompletions,
  toolValidateFeature,
  toolValidateProject,
  toolRoadmapGraph,
  toolRoadmapGraphCheck,
  toolRoadmapXrefPush,
  toolSetWorkspace,
  toolGetWorkspace,
  toolWriteCheckpoint,
  toolComposeResume,
  toolJudgmentPositionCreate,
  toolJudgmentPositionAmend,
  toolJudgmentJointAdd,
  toolJudgmentTransition,
  toolJudgmentLedgerAppend,
  toolJudgmentPersonWrite,
  toolJudgmentSituationWrite,
  toolJudgmentGoalWrite,
  toolGetJudgmentState,
  toolGetJudgmentTrace,
  _getBinding,
  assertToolPhaseAllowed,
  _getSessionProfile,
  resolveBoundPhase,
  preloadEagerModules,
  EAGER_PRELOAD_MODULES,
} from './compose-mcp-tools.js';
import { isToolAllowed } from './mcp-tool-policy.js';
import { prepareProject, withProjectContext, getTargetRoot, loadProjectConfig } from './project-root.js';
import { resolveWorkspace } from '../lib/resolve-workspace.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

import { TOOLS } from './mcp-tool-defs.js';

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'compose', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// COMP-COVERAGE-GATE: `effect`/`writes` are LOCAL declarations consumed by
// lib/tool-inventory.js — they are not part of the MCP tool schema and must not
// reach the wire. Strip them at this one boundary rather than keeping a parallel
// wire-shaped copy of the array, which would be the drift this feature exists
// to stop.
const WIRE_TOOL = ({ name, description, inputSchema }) => ({ name, description, inputSchema });
const toWire = (tools) => tools.map(WIRE_TOOL);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // COMP-MCP-ENFORCE-1: best-effort surface filter by the session's profile×phase.
  // The hard guarantee is the CallTool gate below; ListTools just hides what the
  // current context can't use (no tools/list_changed dependency).
  const enabled = loadProjectConfig()?.capabilities?.phaseScopedTools === true;
  if (!enabled) return { tools: toWire(TOOLS) };
  const profile = _getSessionProfile();
  if (profile === 'orchestrator') return { tools: toWire(TOOLS) };
  const phase = resolveBoundPhase();
  // target match is unknowable at list time → list a tool if its profile base
  // (ignoring the feature-scoped re-permit) would ever permit it in this phase.
  const tools = TOOLS.filter((t) =>
    isToolAllowed({ tool: t.name, profile, phase, targetMatchesBoundFeature: true }).allowed);
  return { tools: toWire(tools) };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const WORKSPACE_EXEMPT = new Set(['set_workspace', 'get_workspace']);

  try {
    // set_workspace changes the session default. Every other operation pins its
    // resolved root before awaiting, so a concurrent rebind cannot retarget it.
    let binding = null;
    if (!WORKSPACE_EXEMPT.has(name)) {
      const ws = resolveWorkspace({ workspaceId: _getBinding(), cwd: getTargetRoot() });
      binding = { ...prepareProject(ws.root), workspaceId: ws.id };
    }
    return await withProjectContext(binding, async () => {
      assertToolPhaseAllowed(name, args);
      let result;
      switch (name) {
        case 'get_vision_items':    result = toolGetVisionItems(args); break;
        case 'get_item_detail':     result = toolGetItemDetail(args); break;
        case 'get_phase_summary':   result = toolGetPhasesSummary(args); break;
        case 'get_blocked_items':   result = toolGetBlockedItems(); break;
        case 'get_current_session': result = await toolGetCurrentSession(args); break;
        case 'bind_session':             result = await toolBindSession(args); break;
        case 'set_workspace':            result = toolSetWorkspace(args); break;
        case 'get_workspace':            result = toolGetWorkspace(); break;
        case 'get_feature_lifecycle':    result = toolGetFeatureLifecycle(args); break;
        case 'kill_feature':             result = await toolKillFeature(args); break;
        case 'complete_feature':         result = await toolCompleteFeature(args); break;
        case 'start_iteration_loop':     result = await toolIterationStart(args); break;
        case 'report_iteration_result':  result = await toolIterationReport(args); break;
        case 'abort_iteration_loop':     result = await toolIterationAbort(args); break;
        case 'assess_feature_artifacts': result = toolAssessFeatureArtifacts(args); break;
        case 'scaffold_feature':         result = toolScaffoldFeature(args); break;
        case 'approve_gate':             result = await toolApproveGate(args); break;
        case 'get_pending_gates':        result = toolGetPendingGates(args); break;
        case 'add_roadmap_entry':        result = await toolAddRoadmapEntry(args); break;
        case 'set_feature_status':       result = await toolSetFeatureStatus(args); break;
        case 'roadmap_diff':             result = await toolRoadmapDiff(args); break;
        case 'get_roadmap':              result = toolGetRoadmap(args); break;
        case 'link_artifact':            result = await toolLinkArtifact(args); break;
        case 'link_features':            result = await toolLinkFeatures(args); break;
        case 'get_feature_artifacts':    result = await toolGetFeatureArtifacts(args); break;
        case 'get_feature_links':        result = await toolGetFeatureLinks(args); break;
        case 'add_changelog_entry':      result = await toolAddChangelogEntry(args); break;
        case 'canon_override_grant':     result = await toolCanonOverrideGrant(args); break;
        case 'get_changelog_entries':    result = await toolGetChangelogEntries(args); break;
        case 'write_journal_entry':      result = await toolWriteJournalEntry(args); break;
        case 'get_journal_entries':      result = await toolGetJournalEntries(args); break;
        case 'record_completion':        result = await toolRecordCompletion(args); break;
        case 'get_completions':          result = await toolGetCompletions(args); break;
        case 'validate_feature':         result = await toolValidateFeature(args); break;
        case 'validate_project':         result = await toolValidateProject(args); break;
        case 'roadmap_graph':            result = await toolRoadmapGraph(args); break;
        case 'roadmap_graph_check':      result = await toolRoadmapGraphCheck(args); break;
        case 'roadmap_xref_push':        result = await toolRoadmapXrefPush(args); break;
        case 'propose_followup':         result = await toolProposeFollowup(args); break;
        case 'write_checkpoint':         result = await toolWriteCheckpoint(args); break;
        case 'compose_resume':           result = await toolComposeResume(args); break;
        case 'judgment_position_create': result = await toolJudgmentPositionCreate(args); break;
        case 'judgment_position_amend':  result = await toolJudgmentPositionAmend(args); break;
        case 'judgment_joint_add':       result = await toolJudgmentJointAdd(args); break;
        case 'judgment_transition':      result = await toolJudgmentTransition(args); break;
        case 'judgment_ledger_append':   result = await toolJudgmentLedgerAppend(args); break;
        case 'judgment_person_write':    result = await toolJudgmentPersonWrite(args); break;
        case 'judgment_situation_write': result = await toolJudgmentSituationWrite(args); break;
        case 'judgment_goal_write':      result = await toolJudgmentGoalWrite(args); break;
        case 'get_judgment_state':       result = await toolGetJudgmentState(args); break;
        case 'get_judgment_trace':       result = await toolGetJudgmentTrace(args); break;
        // agent_run removed — STRAT-DEDUP-AGENTRUN v1. Use mcp__stratum__stratum_agent_run.
        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    });
  } catch (err) {
    // Surface typed error codes (e.g. INVALID_INPUT, CHANGELOG_FORMAT) when
    // tools attach them, so MCP callers can branch deterministically. Plain
    // errors fall back to the original "Error: <message>" shape.
    // When err.cause is an Error-shaped object, append it so callers can
    // distinguish partial-write sub-errors (e.g. rollback succeeded vs failed).
    let text = err && err.code
      ? `Error [${err.code}]: ${err.message}`
      : `Error: ${err.message}`;
    // For workspace ambiguity, include the candidate list and the call to fix it
    // so Claude can prompt the user without a follow-up tool call.
    if (err && err.code === 'WorkspaceAmbiguous' && Array.isArray(err.candidates)) {
      text += '\n\nCandidates:';
      for (const c of err.candidates) text += `\n  - ${c.id}  (${c.root})`;
      text += '\n\nNext step: call set_workspace({"workspaceId": "<id>"}) and retry.';
    }
    if (err && err.code === 'WorkspaceIdCollision' && Array.isArray(err.roots)) {
      text += `\n\nworkspaceId "${err.id}" is used by multiple roots:`;
      for (const r of err.roots) text += `\n  - ${r}`;
      text += '\n\nFix: set an explicit workspaceId in each .compose/compose.json.';
    }
    if (err && err.code === 'WorkspaceUnset') {
      text += '\n\nNo .compose/ workspace was found. Run `compose init` to scaffold one.';
    }
    if (err && err.cause && typeof err.cause.message === 'string') {
      text += err.cause.code
        ? `\n  Caused by [${err.cause.code}]: ${err.cause.message}`
        : `\n  Caused by: ${err.cause.message}`;
    }
    return {
      content: [{ type: 'text', text }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// COMP-MCP-FOLLOWUP-1-1: eager-preload lazily-imported hot-path modules so a
// genuine on-disk break (missing module/export) fails fast at boot instead of
// on first tool call. COMPOSE_PRELOAD_PROBE is an ops/test seam: comma-separated
// entries appended to the default set, each `specifier` or `specifier#export`
// (the `#export` form also exercises the export assertion). Absent → default.
const probeExtra = (process.env.COMPOSE_PRELOAD_PROBE || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const hash = entry.indexOf('#');
    return hash === -1
      ? { specifier: entry }
      : { specifier: entry.slice(0, hash), expect: entry.slice(hash + 1) };
  });
try {
  await preloadEagerModules([...EAGER_PRELOAD_MODULES, ...probeExtra]);
} catch (err) {
  // writeSync (not stderr.write) so the line is guaranteed flushed before
  // process.exit — an async pipe write can otherwise be truncated/dropped.
  writeSync(2, `[compose-mcp] boot aborted: ${err.message}\n`);
  process.exit(1);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs until stdin closes — no explicit exit needed
