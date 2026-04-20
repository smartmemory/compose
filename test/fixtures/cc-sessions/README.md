# CC Session JSONL Fixtures

Fixtures for **COMP-OBS-BRANCH T1 (cc-session-reader)**, **T2 (feature-resolver)**, **T5 (watcher)**, and **T11 (E2E smoke)**. Every fixture is a scrubbed / synthesized Claude Code session JSONL mirroring the on-disk shape of `~/.claude/projects/<slug>/*.jsonl`.

Produced by [`capture.js`](./capture.js) in synth mode:

```bash
node test/fixtures/cc-sessions/capture.js synth
```

The committed fixtures are deterministic — re-running `synth` reproduces them byte-for-byte. Use `node capture.js scrub <src> <dest>` to regenerate from a real on-disk session if CC's JSONL format drifts (see §Recapture).

## Record shape (what the T1 reader must handle)

Every line is one JSON object. Fields observed on real disk (verified 2026-04-19 against `~/.claude/projects/-Users-ruze-reg-my-forge/*.jsonl`):

| Field | Where | Notes |
|---|---|---|
| `uuid` | every record | primary key |
| `parentUuid` | every record | `null` on roots; forms the tree |
| `isSidechain` | every record | BRANCH tree traversal uses non-sidechain only |
| `type` | every record | `user`, `assistant`, `system`, `summary`, plus occasional `file-history-snapshot`, `queue-operation`, `attachment`, `last-prompt`, `file-history-snapshot` — reader should log-and-skip unknown types |
| `timestamp` | every record | ISO-8601 |
| `cwd` | user/assistant/system | repo root, not feature path |
| `sessionId` | every record except snapshot records | used for `branch_id = sha1(cc_session_id + ':' + leaf_uuid)` |
| `gitBranch` / `version` / `userType` | most records | stable but not used by BRANCH |
| `message.role` | user/assistant | `user` / `assistant` |
| `message.model` | assistant | e.g. `claude-sonnet-4-6` |
| `message.content[]` | user/assistant | array of `{ type: 'text' \| 'thinking' \| 'tool_use' \| 'tool_result', … }` OR a plain string for user messages |
| `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` | assistant only | feeds `cost.tokens_in/out/cache_read_input_tokens` per blueprint §6.5 |
| `requestId` | assistant only | used for `tests.run_ids[]` |
| `tool_use.name` / `tool_use.id` / `tool_use.input` | inside `message.content[]` | `name ∈ {Edit, Write, Read, Bash, NotebookEdit, MultiEdit, Glob, …}` |
| `tool_result.tool_use_id` / `tool_result.content` / `tool_result.is_error` | inside user `message.content[]` | `is_error: true` marks failure |

## State-classifier markers

| State | Marker shape used in these fixtures |
|---|---|
| `complete` | **Leaf is a user-message tool_result (without `is_error`) OR an assistant text record with `stop_reason: "end_turn"`.** All leaves in `linear-session.jsonl`, both leaves in `forked-session-two-branches.jsonl`, all three in `forked-session-three-branches.jsonl`, Branch A of `mid-progress-session.jsonl`, Branch A of `failed-branch-session.jsonl`, and both files in `multi-session-same-feature/`. |
| `failed` | **Leaf is a user-message with `message.content[].is_error === true` on a `tool_result` item.** Branch B of `failed-branch-session.jsonl`. Shape matches the real-world pattern observed in session `37817895-b4b0-4616-8eb3-ee32be8f19a5`. `ended_at` = that tool_result's timestamp. This is the ONE failure shape these fixtures use; T1 should accept this shape as `state=failed` and not require a separate `type: "system", subtype: "error"` record. |
| `running` | **Leaf is an assistant `tool_use` with NO matching user tool_result following it, and NOT on a branch terminating in `is_error`.** Branch B of `mid-progress-session.jsonl`. |
| `unknown` | **JSONL file ends with a non-newline-terminated line that fails `JSON.parse`.** `truncated-session.jsonl`. Parseable records before the truncated line populate branches normally; the truncated tail implies a trailing branch whose state is `unknown`. |

**Note on the `result` record shape.** Real CC sessions do not consistently emit a standalone `type: "result"` record; the closing signal for a completed tool cycle is the `tool_result` inside a user message. These fixtures use that shape exclusively. If a future CC version adds top-level `type: "result"` records, T1 should treat them as equivalent-or-stronger completion markers.

## Fixture catalog

### `linear-session.jsonl` — 8 records

A single non-sidechain chain: `system → user → assistant text → assistant tool_use (Edit plan.md) → user tool_result → assistant tool_use (Write report.md) → user tool_result → assistant text`. Exercises `state=complete`, single branch, populated `files_touched`, populated `cost.tokens_in`.

Expected T1 output: `branches.length === 1`, `state === 'complete'`, `fork_points === []`, `files_touched.length === 2`, `final_artifact.path === 'docs/features/COMP-OBS-BRANCH/report.md'` (most-recent `.md`-targeting write under `docs/features/`).

### `forked-session-two-branches.jsonl` — 11 records

One fork point: parent `a1` (assistant text) has two non-sidechain `user` children. Both branches complete (edit + tool_result + assistant text).

Expected: `branches.length === 2`, both `state === 'complete'`, `fork_points.length === 1` with two sibling leaf uuids.

### `forked-session-three-branches.jsonl` — 15 records

One fork point with three sibling non-sidechain user-message children; each branch edits a distinct file and completes. Exercises the single-fork-multi-sibling case.

Expected: `branches.length === 3`, all `state === 'complete'`, `fork_points.length === 1` with three child leaves.

### `mid-progress-session.jsonl` — 10 records

One fork with two siblings. Branch A completes. Branch B's tip is an assistant `tool_use` with no matching `tool_result` — still running. Exercises the T1 rule: *running branches have null completion-only fields (`ended_at`, `turn_count`, `files_touched`, `tests`, `cost`, `final_artifact`) per blueprint §6.5*.

Expected: `branches.length === 2`, one `state === 'complete'`, one `state === 'running'`; the running branch has every completion-only field null.

### `failed-branch-session.jsonl` — 10 records

One fork. Branch A completes. Branch B's tip is a `tool_result` user-message with `is_error: true` on a Bash tool call. Exercises `state=failed`.

Expected: `branches.length === 2`, one `state === 'complete'`, one `state === 'failed'`; the failed branch still has populated `ended_at`, `turn_count`, `files_touched`, `cost` (per blueprint §6.5 terminal-populated rule).

### `truncated-session.jsonl` — 5 valid records + 1 truncated tail

Five well-formed records (chain: system → user → assistant text → assistant tool_use → user tool_result) followed by a final line that is:

1. NOT terminated with `\n`
2. NOT valid JSON (it is a partial object `{"parentUuid":"...","isSidechain":false,"type":"assis`)

Exercises T1's resilience rule: "Parses [the fixture] without throwing — truncated fixture parses up to truncation point; records past it are skipped with a log-warn" (T1 acceptance). The leaf reachable via the valid prefix should be classified `state=unknown` (open-ended — file ended mid-record so we can't confirm completion).

### `multi-session-same-feature/` — two linear sessions

Two independent JSONL files (`77777777-…a.jsonl` and `88888888-…b.jsonl`), each a tiny complete linear session in its own `sessionId`.

Neither JSONL encodes `featureCode` — the join is consumer-side via `sessions.json`'s `transcriptPath` basename (per blueprint §5). T5's watcher test is expected to populate a temp `sessions.json` binding **both** cc_session_ids to the same `featureCode`, then assert the resulting `BranchLineage` contains branches from both sessions (**not** last-writer-wins). This is the critical T5 correctness case called out in the plan at T5 acceptance (“feature with 2 sessions: lineage contains branches from BOTH (no overwrite)”).

## Recapture

If CC's JSONL format drifts and these fixtures no longer mirror reality:

1. Pick a fresh small session from `~/.claude/projects/-Users-ruze-reg-my-forge/*.jsonl` (sort by size, pick ~10–60 records).
2. Scrub it: `node capture.js scrub <real.jsonl> ./linear-session.jsonl` (etc.). Inspect the diff; adjust `scrubRecord` in `capture.js` if new sensitive fields have appeared.
3. For synth fixtures that encode specific tree shapes (forks, is_error, truncation), edit the corresponding `buildXxx()` function in `capture.js` and re-run `node capture.js synth`. Do not hand-edit the JSONL output — regenerate.
4. Grep the fixture tree for sensitive strings before committing:

```bash
grep -REi 'password|secret|api[_-]?key|bearer' --include='*.jsonl' test/fixtures/cc-sessions/
grep -REn '"command":' --include='*.jsonl' test/fixtures/cc-sessions/ | grep -v '"command":"echo scrubbed"'
grep -RE '"text":"[^\[]' --include='*.jsonl' test/fixtures/cc-sessions/
```

(The `tokens` word inside `message.usage` is fine — that's the CC schema, not a leaked credential.)

## Source → fixture mapping

See the comment block at the top of `capture.js` for the historical source filenames and which real session each fixture's shape was modeled on.
