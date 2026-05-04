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
import {
  toolGetVisionItems,
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
  toolGetChangelogEntries,
  toolWriteJournalEntry,
  toolGetJournalEntries,
  toolRecordCompletion,
  toolGetCompletions,
  toolValidateFeature,
  toolValidateProject,
} from './compose-mcp-tools.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'get_vision_items',
    description: 'Query Compose tracker items. Filter by phase, status, type, or keyword. Returns id, title, type, phase, status, confidence, description.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          description: 'Filter by phase: vision, requirements, design, planning, implementation, verification, release',
        },
        status: {
          type: 'string',
          description: 'Filter by status (comma-separated for multiple): planned, in_progress, complete, blocked, parked, killed',
        },
        type: {
          type: 'string',
          description: 'Filter by type: task, decision, evaluation, idea, spec, thread, artifact, question, feature, track',
        },
        keyword: {
          type: 'string',
          description: 'Search keyword matched against title and description',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default 30)',
        },
      },
    },
  },
  {
    name: 'get_item_detail',
    description: 'Get full detail for a single tracker item including all its connections.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Item ID (UUID) or semanticId/slug',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_phase_summary',
    description: 'Get status and type distribution for a phase (or all phases). Useful for understanding overall project health.',
    inputSchema: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          description: 'Phase to summarize: vision, requirements, design, planning, implementation, verification, release. Omit for all phases.',
        },
      },
    },
  },
  {
    name: 'get_blocked_items',
    description: 'List all tracker items that are blocked by non-complete items.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_current_session',
    description: 'Get the most recent session: tool count, items touched, error count, and recent Haiku summaries of what was accomplished.',
    inputSchema: {
      type: 'object',
      properties: {
        featureCode: { type: 'string', description: 'Optional: get context for a specific feature' },
      },
    },
  },
  {
    name: 'bind_session',
    description: 'Bind the current agent session to a lifecycle feature. Call once per session after creating/identifying the feature. Binding is one-shot — calling again on a bound session returns already_bound.',
    inputSchema: {
      type: 'object',
      properties: {
        featureCode: { type: 'string', description: 'The feature code (e.g., "gate-ui")' },
      },
      required: ['featureCode'],
    },
  },
  {
    name: 'get_feature_lifecycle',
    description: 'Get the lifecycle state of a feature: current phase, phase history, artifacts, warnings.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID (UUID) or slug' },
      },
      required: ['id'],
    },
  },
  {
    name: 'kill_feature',
    description: 'Kill a feature from any phase. Records reason and sets status to killed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
        reason: { type: 'string', description: 'Why the feature is being killed' },
      },
      required: ['id', 'reason'],
    },
  },
  {
    name: 'complete_feature',
    description: 'Mark a feature as complete. Only callable from the ship phase. When commit_sha is provided, the lifecycle endpoint also writes a commit-bound completion record via record_completion (which atomically flips feature.status to COMPLETE and regenerates ROADMAP.md). Without commit_sha, the lifecycle transitions but no completion record is written; a `cockpit_completion_skipped` decision event explains the skip.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID' },
        commit_sha: { type: 'string', description: 'Full 40-char commit SHA. Required to write a completion record.' },
        tests_pass: { type: 'boolean', description: 'Defaults to true when commit_sha is provided.' },
        files_changed: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths committed in the SHA.' },
        notes: { type: 'string', description: 'One-line note for the completion record.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'start_iteration_loop',
    description: 'Start a review or coverage iteration loop on a feature. Returns loop state.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID or semanticId' },
        loopType: { type: 'string', enum: ['review', 'coverage'], description: 'Type of iteration loop' },
        maxIterations: { type: 'number', description: 'Override max iterations (optional, defaults from settings)' },
      },
      required: ['id', 'loopType'],
    },
  },
  {
    name: 'report_iteration_result',
    description: 'Report one iteration result. Compose evaluates exit criteria and returns whether to continue.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID or semanticId' },
        result: { type: 'object', description: 'Iteration result. Review: {clean: bool, findings: []}, Coverage: {passing: bool, failures: []}' },
      },
      required: ['id', 'result'],
    },
  },
  {
    name: 'abort_iteration_loop',
    description: 'Abort the current iteration loop early.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Item ID or semanticId' },
        reason: { type: 'string', description: 'Why the loop was aborted' },
      },
      required: ['id'],
    },
  },
  {
    name: 'assess_feature_artifacts',
    description: 'Assess quality signals for all artifacts of a feature: section completeness, word count, last modified.',
    inputSchema: {
      type: 'object',
      properties: {
        featureCode: { type: 'string', description: 'Feature folder name (e.g. "artifact-awareness")' },
      },
      required: ['featureCode'],
    },
  },
  {
    name: 'scaffold_feature',
    description: 'Create feature folder with template stubs for all phase artifacts. Existing files are never overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        featureCode: { type: 'string', description: 'Feature folder name' },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to specific artifacts (e.g. ["design.md", "blueprint.md"]). Omit for all.',
        },
      },
      required: ['featureCode'],
    },
  },
  {
    name: 'approve_gate',
    description: 'Resolve a pending policy gate. Outcomes: approved (proceed), revised (stay in phase), killed (abandon feature).',
    inputSchema: {
      type: 'object',
      properties: {
        gateId: { type: 'string', description: 'Gate ID' },
        outcome: { type: 'string', enum: ['approved', 'revised', 'killed'], description: 'Resolution outcome' },
        comment: { type: 'string', description: 'Optional human feedback' },
      },
      required: ['gateId', 'outcome'],
    },
  },
  {
    name: 'get_pending_gates',
    description: 'List pending policy gates. Optionally filter by item ID.',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'Filter to gates for a specific item (optional)' },
      },
    },
  },
  // `agent_run` tool removed 2026-04-18 (STRAT-DEDUP-AGENTRUN v1); LLM-facing
  // dispatch goes through `mcp__stratum__stratum_agent_run`.

  // -------------------------------------------------------------------------
  // Roadmap writers — COMP-MCP-ROADMAP-WRITER
  // -------------------------------------------------------------------------
  {
    name: 'add_roadmap_entry',
    description: 'Register a new feature in the project. Writes feature.json and regenerates ROADMAP.md (audit-log append is best-effort). Use this instead of editing ROADMAP.md by hand.',
    inputSchema: {
      type: 'object',
      required: ['code', 'description', 'phase'],
      properties: {
        code: { type: 'string', description: 'Unique feature code (e.g. "COMP-FOO-1"). Must be uppercase A-Z, digits, dashes; cannot start or end with a dash.' },
        description: { type: 'string', description: 'One-line description for the ROADMAP cell' },
        phase: { type: 'string', description: 'Phase heading (e.g. "Phase 6: MCP Writers"). Required.' },
        complexity: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
        status: { type: 'string', enum: ['PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE', 'BLOCKED', 'KILLED', 'PARKED', 'SUPERSEDED'], description: 'Initial status (default PLANNED)' },
        position: { type: 'number', description: 'Sort order within phase' },
        parent: { type: 'string', description: 'Parent feature code, for cross-references' },
        tags: { type: 'array', items: { type: 'string' } },
        idempotency_key: { type: 'string', description: 'Optional caller-provided key. Same key replays return the cached result without re-mutating.' },
      },
    },
  },
  {
    name: 'set_feature_status',
    description: 'Flip a feature status. Updates feature.json and regenerates ROADMAP.md. Enforces a transition policy (use force: true to bypass). Appends an audit event (best-effort).',
    inputSchema: {
      type: 'object',
      required: ['code', 'status'],
      properties: {
        code: { type: 'string' },
        status: { type: 'string', enum: ['PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE', 'BLOCKED', 'KILLED', 'PARKED', 'SUPERSEDED'] },
        reason: { type: 'string', description: 'Free-form reason persisted in the audit event' },
        commit_sha: { type: 'string', description: 'Optional commit binding' },
        force: { type: 'boolean', description: 'Bypass the transition policy. Recorded in audit.' },
        idempotency_key: { type: 'string' },
      },
    },
  },
  {
    name: 'roadmap_diff',
    description: 'Read the feature-management audit log for a window. Returns events plus derived added[] and status_changed[] arrays.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Window: shorthand like "24h"/"7d"/"30m", or an ISO date. Default 24h.' },
        feature_code: { type: 'string' },
        tool: { type: 'string', description: 'Filter to one tool name, e.g. "set_feature_status"' },
      },
    },
  },
  {
    name: 'validate_feature',
    description: 'Cross-check a single feature against ROADMAP, vision-state, feature.json, folder contents, linked artifacts, and cross-references. Returns structured findings with severity (error/warning/info). FEATURE_NOT_FOUND emitted as a finding (not thrown) when the code matches strict regex but exists in no source.',
    inputSchema: {
      type: 'object',
      required: ['feature_code'],
      properties: {
        feature_code: { type: 'string', description: 'Strict feature code, e.g. "COMP-MCP-VALIDATE"' },
        external_prefixes: { type: 'array', items: { type: 'string' }, description: 'Code prefixes (e.g. ["STRAT-"]) treated as external; downgrades ORPHAN_FOLDER to info' },
        feature_json_mode: { type: 'boolean', description: 'Default true. Set false to skip feature.json comparisons in legacy projects.' },
      },
    },
  },
  {
    name: 'validate_project',
    description: 'Run validate_feature for every code in vision-state, ROADMAP, and folders, plus cross-cutting checks (orphan folders, dangling cross-refs, CHANGELOG references, journal index drift). Returns the union of all findings.',
    inputSchema: {
      type: 'object',
      properties: {
        external_prefixes: { type: 'array', items: { type: 'string' } },
        feature_json_mode: { type: 'boolean' },
      },
    },
  },
  {
    name: 'propose_followup',
    description: 'File a follow-up feature against a parent. Auto-numbers the next code in the parent\'s namespace (parent_code-N), adds the ROADMAP row, links surfaced_by from new → parent, and scaffolds design.md with a "## Why" rationale block. Idempotent on (parent_code, idempotency_key); resumes across partial failures via an inflight ledger.',
    inputSchema: {
      type: 'object',
      required: ['parent_code', 'description', 'rationale'],
      properties: {
        parent_code: { type: 'string', description: 'Parent feature code (e.g. "COMP-MCP-MIGRATION"). Must exist; must not be KILLED/SUPERSEDED.' },
        description: { type: 'string', description: 'One-line description for the ROADMAP cell.' },
        rationale: { type: 'string', description: 'Why this follow-up exists. Persisted as a "## Why" block in the new design.md and in the audit event.' },
        complexity: { type: 'string', enum: ['S', 'M', 'L', 'XL'] },
        phase: { type: 'string', description: 'Phase heading. Defaults to the parent\'s phase if omitted.' },
        status: { type: 'string', enum: ['PLANNED', 'IN_PROGRESS', 'PARTIAL', 'COMPLETE', 'BLOCKED', 'KILLED', 'PARKED', 'SUPERSEDED'] },
        idempotency_key: { type: 'string', description: 'Optional retry-safety key. Without it, repeated calls allocate new codes.' },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Linker — COMP-MCP-ARTIFACT-LINKER
  // -------------------------------------------------------------------------
  {
    name: 'link_artifact',
    description: 'Register a non-canonical artifact (snapshot, journal entry, finding, etc.) on a feature. Canonical artifacts (design.md, plan.md, …) inside the feature folder are auto-discovered and rejected here. Stores in feature.json artifacts[]; dedups on (type, path); appends an audit event (best-effort).',
    inputSchema: {
      type: 'object',
      required: ['feature_code', 'artifact_type', 'path'],
      properties: {
        feature_code: { type: 'string' },
        artifact_type: { type: 'string', description: 'e.g. "journal", "snapshot", "finding", "report-supplement", "link", "external"' },
        path: { type: 'string', description: 'Repo-relative path. Must exist; cannot contain ".." after normalization.' },
        status: { type: 'string', enum: ['current', 'superseded', 'historical'] },
        force: { type: 'boolean', description: 'Overwrite an existing entry with the same (type, path)' },
        idempotency_key: { type: 'string' },
      },
    },
  },
  {
    name: 'link_features',
    description: 'Register a typed cross-feature relationship. Stores on the source feature; query the inverse via get_feature_links(direction:"incoming"). Closed enum on kind; self-links rejected; dedups on (kind, to_code).',
    inputSchema: {
      type: 'object',
      required: ['from_code', 'to_code', 'kind'],
      properties: {
        from_code: { type: 'string' },
        to_code: { type: 'string', description: 'Target feature code. Need not exist yet (you can link to a code you are about to create).' },
        kind: { type: 'string', enum: ['surfaced_by', 'blocks', 'depends_on', 'follow_up', 'supersedes', 'related'] },
        note: { type: 'string' },
        force: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
    },
  },
  {
    name: 'get_feature_artifacts',
    description: 'Read both canonical (auto-discovered: design.md, plan.md, …) and linked (snapshots, journals, findings) artifacts for a feature in one call. Each linked entry includes a current existence check.',
    inputSchema: {
      type: 'object',
      required: ['feature_code'],
      properties: {
        feature_code: { type: 'string' },
      },
    },
  },
  {
    name: 'get_feature_links',
    description: 'Read outgoing and/or incoming feature links. Default returns both directions; filter by kind if needed.',
    inputSchema: {
      type: 'object',
      required: ['feature_code'],
      properties: {
        feature_code: { type: 'string' },
        direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'] },
        kind: { type: 'string' },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Changelog writer — COMP-MCP-CHANGELOG-WRITER
  // -------------------------------------------------------------------------
  {
    name: 'add_changelog_entry',
    description: 'Insert (or replace, with force: true) a typed entry in compose/CHANGELOG.md. Idempotent on (date_or_version, code) at storage level; optional caller-supplied idempotency_key for retry safety. Audit-log append is best-effort. Use this instead of editing CHANGELOG.md by hand.',
    inputSchema: {
      type: 'object',
      required: ['date_or_version', 'code', 'summary'],
      properties: {
        date_or_version: { type: 'string', description: 'ISO date "YYYY-MM-DD" or semver "vX.Y.Z"' },
        code: { type: 'string', description: 'Feature code (e.g. "COMP-FOO-1"). Uppercase A-Z, digits, dashes; cannot start or end with a dash.' },
        summary: { type: 'string', description: 'One-line summary; renders as the "— summary" tail of the entry header.' },
        body: { type: 'string', description: 'Free paragraphs between header and labeled subsections.' },
        sections: {
          type: 'object',
          description: 'Optional labeled subsections; emitted in fixed order Added → Changed → Fixed → Snapshot.',
          properties: {
            added:    { type: 'array', items: { type: 'string' } },
            changed:  { type: 'array', items: { type: 'string' } },
            fixed:    { type: 'array', items: { type: 'string' } },
            snapshot: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        force: { type: 'boolean', description: 'If true and an entry with the same (date_or_version, code) exists, replace it in place.' },
        idempotency_key: { type: 'string', description: 'Optional caller-supplied key. Same key replays return the cached result without re-mutating.' },
      },
    },
  },
  {
    name: 'get_changelog_entries',
    description: 'Read parsed entries from compose/CHANGELOG.md. Filter by code (exact) or since (shorthand "24h"/"7d"/"30m" or ISO date — date-only; version surfaces always pass through).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Window: shorthand like "24h"/"7d"/"30m" or ISO date. Date-only filter; version surfaces are always returned.' },
        code: { type: 'string' },
        limit: { type: 'number', description: 'Default 50; capped at 500.' },
      },
    },
  },

  // -------------------------------------------------------------------------
  // Journal writer — COMP-MCP-JOURNAL-WRITER
  // -------------------------------------------------------------------------
  {
    name: 'write_journal_entry',
    description: 'Write a typed entry to compose/docs/journal/ with auto-numbered global session and inserted index row. Idempotent on (date, slug) at storage level; optional caller idempotency_key for retry safety. Audit-log append is best-effort.',
    inputSchema: {
      type: 'object',
      required: ['date', 'slug', 'sections', 'summary_for_index'],
      properties: {
        date: { type: 'string', description: 'ISO date "YYYY-MM-DD".' },
        slug: { type: 'string', description: 'Kebab-case slug for the filename, e.g. "mcp-journal-writer".' },
        sections: {
          type: 'object',
          required: ['what_happened', 'what_we_built', 'what_we_learned', 'open_threads'],
          properties: {
            what_happened:   { type: 'string' },
            what_we_built:   { type: 'string' },
            what_we_learned: { type: 'string' },
            open_threads:    { type: 'string' },
          },
          additionalProperties: false,
        },
        summary_for_index: { type: 'string', description: 'Single-line summary for the README index row. No newlines, no "|".' },
        feature_code:      { type: 'string', description: 'Optional feature code stamped in entry frontmatter.' },
        closing_line:      { type: 'string', description: 'Optional final italicized one-liner.' },
        force:             { type: 'boolean', description: 'If true and an entry with the same (date, slug) exists, overwrite in place.' },
        idempotency_key:   { type: 'string', description: 'Optional caller-supplied key. Same key replays return the cached result without re-mutating.' },
      },
    },
  },
  {
    name: 'get_journal_entries',
    description: 'Read parsed entries from compose/docs/journal/. Filter by feature_code (exact), session (exact), or since (shorthand "24h"/"7d"/"30m" or ISO date).',
    inputSchema: {
      type: 'object',
      properties: {
        since:        { type: 'string' },
        feature_code: { type: 'string' },
        session:      { type: 'number' },
        limit:        { type: 'number', description: 'Default 50; capped at 500.' },
      },
    },
  },
  // -------------------------------------------------------------------------
  // Completion writer — COMP-MCP-COMPLETION
  // -------------------------------------------------------------------------
  {
    name: 'record_completion',
    description: 'Record a completion bound to a commit SHA. Stores in feature.json completions[]; idempotent on (feature_code, commit_sha); when set_status:true (default) also flips status to COMPLETE via set_feature_status. Audit append best-effort. Status-flip failure rethrows as STATUS_FLIP_AFTER_COMPLETION_RECORDED with err.cause; the completion record is still persisted.',
    inputSchema: {
      type: 'object',
      required: ['feature_code', 'commit_sha', 'tests_pass', 'files_changed'],
      properties: {
        feature_code:    { type: 'string' },
        commit_sha:      { type: 'string', description: 'Full 40-char hex SHA (Decision 9). Short prefixes are rejected on write. Stored verbatim; commit_sha_short is derived for display only.' },
        tests_pass:      { type: 'boolean' },
        files_changed:   { type: 'array', items: { type: 'string' } },
        notes:           { type: 'string' },
        set_status:      { type: 'boolean', description: 'Default true. When true, flips status to COMPLETE via set_feature_status.' },
        force:           { type: 'boolean', description: 'If true and a record with the same (feature_code, commit_sha) exists, replace it in place.' },
        idempotency_key: { type: 'string' },
      },
    },
  },
  {
    name: 'get_completions',
    description: 'Read completion records from feature.json files. Filter by feature_code (exact), commit_sha (short or full prefix), or since (shorthand or ISO date).',
    inputSchema: {
      type: 'object',
      properties: {
        feature_code: { type: 'string' },
        commit_sha:   { type: 'string' },
        since:        { type: 'string' },
        limit:        { type: 'number', description: 'Default 50; capped at 500.' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'compose', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;
    switch (name) {
      case 'get_vision_items':    result = toolGetVisionItems(args); break;
      case 'get_item_detail':     result = toolGetItemDetail(args); break;
      case 'get_phase_summary':   result = toolGetPhasesSummary(args); break;
      case 'get_blocked_items':   result = toolGetBlockedItems(); break;
      case 'get_current_session': result = await toolGetCurrentSession(args); break;
      case 'bind_session':             result = await toolBindSession(args); break;
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
      case 'link_artifact':            result = await toolLinkArtifact(args); break;
      case 'link_features':            result = await toolLinkFeatures(args); break;
      case 'get_feature_artifacts':    result = await toolGetFeatureArtifacts(args); break;
      case 'get_feature_links':        result = await toolGetFeatureLinks(args); break;
      case 'add_changelog_entry':      result = await toolAddChangelogEntry(args); break;
      case 'get_changelog_entries':    result = await toolGetChangelogEntries(args); break;
      case 'write_journal_entry':      result = await toolWriteJournalEntry(args); break;
      case 'get_journal_entries':      result = await toolGetJournalEntries(args); break;
      case 'record_completion':        result = await toolRecordCompletion(args); break;
      case 'get_completions':          result = await toolGetCompletions(args); break;
      case 'validate_feature':         result = await toolValidateFeature(args); break;
      case 'validate_project':         result = await toolValidateProject(args); break;
      case 'propose_followup':         result = await toolProposeFollowup(args); break;
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
  } catch (err) {
    // Surface typed error codes (e.g. INVALID_INPUT, CHANGELOG_FORMAT) when
    // tools attach them, so MCP callers can branch deterministically. Plain
    // errors fall back to the original "Error: <message>" shape.
    // When err.cause is an Error-shaped object, append it so callers can
    // distinguish partial-write sub-errors (e.g. rollback succeeded vs failed).
    let text = err && err.code
      ? `Error [${err.code}]: ${err.message}`
      : `Error: ${err.message}`;
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

const transport = new StdioServerTransport();
await server.connect(transport);
// Server runs until stdin closes — no explicit exit needed
