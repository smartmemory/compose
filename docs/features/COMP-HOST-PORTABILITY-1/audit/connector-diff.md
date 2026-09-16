# Stratum connector differential audit

Audit date: 2026-09-16. Stratum package: `@smartmemory/stratum` 0.5.2. Live CLIs: Claude Code 2.1.273 and Codex CLI 0.153.3.

The shared `base.ts` is a result/event type contract, not a capability abstraction: it standardizes `text`, aggregate usage, token split, telemetry, optional USD provenance, optional sandbox evidence, and connector events, but the runner explicitly branches on provider and rejects settings unsupported by the selected connector (`base.ts:18-95`; `runner.ts:49-184`). The one-sided capability groups counted in the verdict are labeled **OS-n** below.

## Capability table

| Capability / parameter | Claude connector | Codex connector | File:line evidence |
|---|---|---|---|
| Shared result contract | Returns `text`, `usage`, `split`, `telemetry`, optional `usdSource`; never returns sandbox evidence. | Same common fields plus optional `sandboxAudit`. | `connectors/base.ts:21-82`; `claude.ts:199-216`; `codex.ts:263-285,342-348,493-498` |
| `cwd` | Optional; defaults to `process.cwd()` and is passed to the SDK. | Optional; defaults to `process.cwd()` and is passed as SDK `workingDirectory` or exec `-C`. | `claude.ts:16-40,79-84`; `codex.ts:38-64,224-242,299-308,352-363` |
| Model handling | `options.model` → `CLAUDE_MODEL` → `claude-sonnet-5`; records the SDK init model when supplied. | `options.model` → `CODEX_MODEL` → `gpt-5.6-terra/high`; supports a `/effort` suffix and rejects a conflicting separate effort. | `claude.ts:64-65,121-132,215`; `codex.ts:142-144,173-193,224-225,683-690` |
| Effort handling | Separate SDK `effort`; public runner accepts `low|medium|high|xhigh|max`. | SDK `modelReasoningEffort` or exec config; accepts `minimal|low|medium|high|xhigh`. Both model and effort are retained in telemetry. | `claude.ts:21-22,121-122`; `codex.ts:173-193,298-308,537-540,683-690`; `runner.ts:160-184` |
| **OS-1 — sandbox-mode coverage** | Only effective workspace-write (`permissionMode: "acceptEdits"`). The runner loudly rejects `read-only` and `danger-full-access`; omission is also edit-capable. | Native `read-only` default, `workspace-write`, and opt-in `danger-full-access`; full access fails closed without an environment authorization. | `claude.ts:79-84`; `codex.ts:85-106,224-242`; `runner.ts:66-78`; `background.ts:278-306` |
| **OS-2 — `networkAccess`** | Unsupported and rejected. | Independent Boolean sandbox axis, default `false`, forwarded through SDK/exec. | `codex.ts:50-55,228-237,299-308,352-359`; `runner.ts:160-172` |
| **OS-3 — `writableRoots`** | Unsupported and rejected. | Independent string-array sandbox axis, default `[]`, forwarded through SDK/exec. | Same as OS-2; `config/types.ts:6-10` |
| **OS-4 — `approvalPolicy`** | Unsupported and rejected. | Independent `never|on-request|on-failure|untrusted` axis, default `never`. | `config/types.ts:3-10`; `codex.ts:224-237,299-308,352-359`; `runner.ts:160-172` |
| **OS-5 — allowed/disallowed tool filters** | `allowedTools` replaces the default Claude Code preset; `disallowedTools` is also forwarded. Works foreground and background. | Neither parameter is supported; runner rejects either instead of silently dropping it. | `claude.ts:16-22,114-120`; `runner.ts:120-123,144-157,160-165`; `background.ts:304-317,362-374` |
| **OS-6 — thinking configuration** | Forwards `{type,budgetTokens,display}` after public validation. | Unsupported and rejected. Reasoning effort is not the same control. | `claude.ts:21-22,121-122`; `runner.ts:160-184` |
| Environment and credential scrubbing | Accepts injected `env`; scrubs Anthropic, OpenAI, Claude and SmartMemory credentials before the child. | Accepts injected `env`; scrubs Anthropic/Claude/SmartMemory credentials but intentionally retains OpenAI credentials. | `base.ts:1-16`; `claude.ts:36,43,77-83`; `codex.ts:56,66,241-246` |
| Foreground abort/cancellation | Linked abort controller; optional owned POSIX process group, grace period and `onSpawn` hook; waits for teardown. | Same public controls. SDK signal is used normally; owning a group forces exec transport and group teardown. | `claude.ts:23-35,56-75,85-112,217-237`; `codex.ts:41-48,250-265,288-349,352-492`; `cancellation.ts:1-84` |
| **OS-7 — production transport selection** | Claude Agent SDK only (with a `query` injection seam). | Selectable SDK or exec compatibility transport; owned process groups force exec. Also has `sdkFactory` and `spawn` seams. | `claude.ts:37-42`; `codex.ts:21,57-63,146-149,247-260,279-285` |
| **OS-8 — sandbox policy evidence** | No `sandboxAudit` option, result, event, or background metadata. | Emits `sandbox_policy`, returns/persists policy plus per-axis provenance whenever policy exceeds safe defaults. | `codex.ts:54-55,213,232-240,263-285,506-523`; `base.ts:64-65`; `background.ts:74-88,207-221,388-478` |
| Background mode | Worker-thread adapter normalizes Claude SDK output into Codex-like JSONL; default mode is workspace-write. | Detached shell wrapper runs Codex JSONL and appends an exit sentinel; default mode is read-only. | `runner.ts:94-125`; `background.ts:131-265,278-386`; `claude-bg-worker.ts:1-116` |
| **OS-9 — restart-resilient background cancellation** | Cancellation needs the in-memory worker registry; after MCP restart an unfinished worker is `not_found`. | Durable `childPid` plus process-start identity allows a later process to validate and signal the detached process group. | `background.ts:481-547`, especially `485-492` versus `538-547` |
| **OS-10 — background peer discovery** | No peer record or sidecar metadata. | Registers/discovers a peer and returns `{name,registered,pid,sock}`; meta includes `childPid`/`procStartTime`. | `background.ts:74-90,191-265,388-412` |
| Started and assistant progress | Emits `agent_started`; assistant text becomes `agent_relay(role=assistant)`. | Same common kinds. | `claude.ts:124-139`; `codex.ts:584-635` |
| **OS-11 — reasoning progress** | Configurable thinking exists, but thinking blocks are not emitted by the connector. | A Codex `reasoning` item becomes `agent_relay(role=system)`. | `claude.ts:133-153`; `codex.ts:629-636` |
| Tool-use summary progress | Emits provider tool name/input and optional `tool_use_id`; duration is always zero. | Synthesizes `bash` summaries for commands and `edit` summaries for file changes. | `claude.ts:139-151`; `codex.ts:637-668` |
| **OS-12 — explicit tool-result progress** | Emits `tool_result` with `tool_use_id`, `ok`, and capped output. | No corresponding event; command completion is folded into `tool_use_summary`. | `claude.ts:155-166`; `codex.ts:637-668` |
| Usage and cost, foreground | Provider token counts and provider-reported USD; `usdSource="reported"`. | Token counts plus provider cost if ever present, otherwise connector price-table estimate; `usdSource="estimated"`. | `claude.ts:168-191,199-215`; `codex.ts:589-627,729-762` |
| **OS-13 — cache-creation accounting** | Records `cacheRead` and `cacheCreation` in result and usage events. | Records cached input reads, but no cache-creation field in the result; usage events hardcode cache creation to zero. | `claude.ts:67-71,172-189,204-214`; `codex.ts:293-345,610-625,729-755` |
| **OS-14 — background USD/provenance** | Background stream carries `total_cost_usd`; poll returns USD and `usdSource="reported"`. | Raw Codex has no cost; background polling does not run foreground `usdFromTokens`, so live poll returned neither USD nor `usdSource`. | `claude-bg-worker.ts:83-93`; `background.ts:597-643`; live `raw/*-direct-bg-terminal.json` |
| **OS-15 — background cached-input preservation** | Normalized field `cache_read_input_tokens` is retained in poll split. | Raw stream uses `cached_input_tokens`, but shared scanner reads only `cache_read_input_tokens`; the measured 61,312 cached tokens disappeared from poll output. | `claude-bg-worker.ts:83-93`; `background.ts:622-638`; live Codex `stream.jsonl` versus terminal JSON |
| Telemetry | Duration and resolved model; default Claude run had no effort field. | Duration, base model and parsed effort. | `base.ts:28-33`; `claude.ts:215,219-224`; `codex.ts:342-348,493-498,758-762` |
| Text output contract | `result.result ?? concatenated assistant text`; multiple assistant chunks concatenate without a delimiter. | Concatenated `agent_message` text without a delimiter. Neither connector promises JSON. | `claude.ts:124-170,199-200`; `codex.ts:312-346,371-405,493-498` |
| Provider/API errors | Any Claude result subtype other than `success` throws; partial usage/telemetry and owned-child stderr are attached. | SDK `error`/`turn.failed` throws; exec parses structured errors from stdout or stderr even when process status is zero; usage/telemetry/sandbox evidence are attached. | `claude.ts:193-228`; `codex.ts:327-349,379-405,470-492,558-580,758-762` |
| **OS-16 — empty-output rejection** | No check: a successful provider result with no result/assistant text resolves with `text:""`. | Both SDK and exec reject with `codex completed without agent output`; background poll does the same. | `claude.ts:124-200`; `codex.ts:339-348,481-489`; `background.ts:466-478` |
| Nonzero process status | Claude uses SDK result subtype rather than a public exit-status rule. | Exec intentionally accepts nonzero status when at least one agent-message text exists and no structured API error was found. | `claude.ts:168-197`; `codex.ts:481-489` |
| **OS-17 — foreground stream-line bound** | No connector-level JSONL size control (SDK owns transport). | SDK event serialization and exec JSONL lines are capped by `STRATUM_CODEX_STREAM_LIMIT_BYTES`; overrun kills/fails the run. | `codex.ts:152-160,288-348,408-443,473-492,673-680` |
| Injection/testing seams | `query`. | `sdkFactory`, `spawn`; background Codex also permits a final command seam. | `claude.ts:37-42`; `codex.ts:59-63`; `background.ts:108-115` |

## Matched two-run measurement and actual diff

The source spec is `conn/ws/connector-flow.stratum.yaml`, validated by `npx tsx src/cli/stratum.ts validate ...` (`{"valid":true}`). It has two ordered task steps: write exactly two bytes `OK` to `out.txt`, then verify it; both steps have `file_exists` and `result.ok == true` ensures. The identical YAML object and `{}` input were used; only each step's required `agent` discriminant was changed from `claude` to `codex` for the Codex run. Calls went through a real `createMcpServer` + MCP client transport using `stratum_plan`, foreground `stratum_agent_run`, `stratum_step_done`, and `stratum_audit`. Codex was pinned to `gpt-5.6-sol`, effort `high`, exec transport; Claude used its default. Separate flow workspaces prevented the first run's file from satisfying the second run's ensure.

Both runs completed, both files were exactly `OK`/2 bytes, and both flow audits had the same event kinds:

```text
["planned","ready","usage_debit","result","ready","usage_debit","result","completed"]
```

The actual flow-audit event diff (timestamps/tokens not normalized in the source; this extract removes only timestamps and run IDs) shows the persistent shape difference—Codex carries effort—and also shows a shared provenance loss discussed under constraints:

```diff
--- ws/raw/claude-flow-events.json
+++ ws/raw/codex-flow-events.json
@@ -19,12 +19,13 @@
       "amount": {
-        "usd": 0.3691317,
-        "tokens": 14605,
-        "ms": 6403
+        "tokens": 74948,
+        "ms": 24865,
+        "usd": 0.0835008
       },
-      "model": "claude-sonnet-5",
-      "durationMs": 6403,
+      "model": "gpt-5.6-sol",
+      "effort": "high",
+      "durationMs": 24865,
       "attempt": 1,
       "usdSource": "legacy"
@@ -54,12 +55,13 @@
       "amount": {
-        "usd": 0.3616094999999999,
-        "tokens": 22744,
-        "ms": 15253
+        "tokens": 49898,
+        "ms": 18120,
+        "usd": 0.0702832
       },
-      "model": "claude-sonnet-5",
-      "durationMs": 15253,
+      "model": "gpt-5.6-sol",
+      "effort": "high",
+      "durationMs": 18120,
       "attempt": 1,
       "usdSource": "legacy"
```

The actual connector-progress kind diff for the first matched step is not isomorphic: Codex adds policy evidence; Claude adds a separately correlated tool result.

```diff
--- ws/raw/claude-success-event-kinds.json
+++ ws/raw/codex-success-event-kinds.json
@@ -1,7 +1,8 @@
 [
+  "sandbox_policy",
   "agent_started",
   "tool_use_summary",
-  "tool_result",
+  "tool_use_summary",
   "agent_relay",
   "step_usage"
 ]
```

The actual metadata-field diff makes the missing correlation/output fields explicit:

```diff
--- ws/raw/claude-success-event-fields.json
+++ ws/raw/codex-success-event-fields.json
@@ -15,6 +15,13 @@
     ]
   },
   {
+    "kind": "sandbox_policy",
+    "metadata_fields": [
+      "policy",
+      "provenance"
+    ]
+  },
+  {
     "kind": "step_usage",
     "metadata_fields": [
       "cache_creation_input_tokens",
@@ -28,22 +35,13 @@
     ]
   },
   {
-    "kind": "tool_result",
-    "metadata_fields": [
-      "ok",
-      "output",
-      "tool_use_id"
-    ]
-  },
-  {
     "kind": "tool_use_summary",
     "metadata_fields": [
       "duration_ms",
       "input",
       "ok",
       "summary",
-      "tool",
-      "tool_use_id"
+      "tool"
     ]
   }
 ]
```

The actual foreground accounting/result diff shows reported versus estimated spend, Claude-only cache creation, Codex effort, and Codex-only sandbox evidence:

```diff
--- ws/raw/claude-success-accounting.json
+++ ws/raw/codex-success-accounting.json
@@ -1,19 +1,44 @@
 {
   "usage": {
-    "usd": 0.3691317,
-    "tokens": 14605,
-    "ms": 6403
+    "tokens": 74948,
+    "ms": 24865,
+    "usd": 0.0835008
   },
   "split": {
-    "input": 14392,
-    "output": 213,
-    "cacheRead": 37329,
-    "cacheCreation": 51927
+    "input": 74671,
+    "output": 277,
+    "cacheRead": 61312
   },
-  "usdSource": "reported",
+  "usdSource": "estimated",
   "telemetry": {
-    "durationMs": 6403,
-    "model": "claude-sonnet-5"
+    "durationMs": 24865,
+    "model": "gpt-5.6-sol",
+    "effort": "high"
   },
-  "sandboxAudit": null
+  "sandboxAudit": {
+    "policy": {
+      "filesystemMode": "workspace-write",
+      "networkAccess": false,
+      "writableRoots": [],
+      "approvalPolicy": "never"
+    },
+    "provenance": {
+      "filesystemMode": {
+        "layer": "dispatch",
+        "source": "stratum_agent_run"
+      },
+      "networkAccess": {
+        "layer": "default",
+        "source": "built-in defaults"
+      },
+      "writableRoots": {
+        "layer": "default",
+        "source": "built-in defaults"
+      },
+      "approvalPolicy": {
+        "layer": "default",
+        "source": "built-in defaults"
+      }
+    }
+  }
 }
```

One direct durable `stratum_agent_run` per connector then used the exact same 99-character prompt, same `direct-shared` cwd, and `workspace-write`. Both exited zero and left the same two-byte file, but their output/telemetry contracts differed in practice:

```diff
--- ws/raw/claude-direct-terminal-shape.json
+++ ws/raw/codex-direct-terminal-shape.json
@@ -1,21 +1,49 @@
 {
-  "text": "{\"ok\":true}",
+  "text": "I’ll create the exact one-word file and verify its bytes.{\"ok\":true}",
   "usage": {
-    "usd": 0.25140209999999996,
-    "tokens": 14523
+    "tokens": 75242
   },
   "split": {
-    "input": 14392,
-    "output": 131,
-    "cacheRead": 57597,
-    "cacheCreation": 31497
+    "input": 74855,
+    "output": 387
   },
-  "usdSource": "reported",
+  "usdSource": null,
   "exitCode": 0,
   "telemetry": {
-    "durationMs": 6977,
-    "model": "claude-sonnet-5"
+    "durationMs": 31128,
+    "model": "gpt-5.6-sol",
+    "effort": "high"
   },
-  "sandboxAudit": null,
-  "peer": null
+  "sandboxAudit": {
+    "policy": {
+      "filesystemMode": "workspace-write",
+      "networkAccess": false,
+      "writableRoots": [],
+      "approvalPolicy": "never"
+    },
+    "provenance": {
+      "filesystemMode": {
+        "layer": "dispatch",
+        "source": "stratum_agent_run"
+      },
+      "networkAccess": {
+        "layer": "default",
+        "source": "built-in defaults"
+      },
+      "writableRoots": {
+        "layer": "default",
+        "source": "built-in defaults"
+      },
+      "approvalPolicy": {
+        "layer": "default",
+        "source": "built-in defaults"
+      }
+    }
+  },
+  "peer": {
+    "name": "codex-sol-4cea86",
+    "registered": true,
+    "pid": 95112,
+    "sock": "/tmp/cc-socks/95112.sock"
+  }
 }
```

The missing Codex background cache-read field is not absence at the provider: its raw `turn.completed` had `"cached_input_tokens":61312`, but `agent_poll` returned only `{input:74855,output:387}`. Its raw stream also has a substantially richer native event dialect:

```diff
--- ws/raw/claude-direct-stream-shape.json
+++ ws/raw/codex-direct-stream-shape.json
@@ -1,9 +1,41 @@
 [
   {
+    "type": "thread.started",
+    "item_type": null
+  },
+  {
+    "type": "turn.started",
+    "item_type": null
+  },
+  {
     "type": "item.completed",
+    "item_type": "error"
+  },
+  {
+    "type": "item.completed",
     "item_type": "agent_message"
   },
   {
+    "type": "item.started",
+    "item_type": "file_change"
+  },
+  {
+    "type": "item.completed",
+    "item_type": "file_change"
+  },
+  {
+    "type": "item.started",
+    "item_type": "command_execution"
+  },
+  {
+    "type": "item.completed",
+    "item_type": "command_execution"
+  },
+  {
+    "type": "item.completed",
+    "item_type": "agent_message"
+  },
+  {
     "type": "turn.completed",
     "item_type": null
   },
```

The Codex `item.completed/error` above was a non-terminal skill-budget warning. The connector/poller correctly did not mistake that item subtype for the top-level `type:"error"` failure record.

Raw evidence and generated diffs are under `/private/tmp/claude-501/-Users-ruze-reg-my-forge/12cb24d4-cdb3-44d6-814f-0b9dbcc1efbc/scratchpad/hostaudit/conn/ws/raw/`. The copied durable streams retain their original `~/.stratum/ts/agent_runs/<id>/stream.jsonl` locations in `*-location.json`.

## Failure-surfacing comparison

The live invalid-model probe used `audit-invalid-claude-model` and `audit-invalid-codex-model`. Foreground calls used the MCP surface; background calls captured provider JSONL and the wrapper sentinel. In both cases the MCP foreground call rejected with `-32603` / `data.code="agent_run_failed"`; both background polls returned `status:"error", exitCode:1`; and after the connector error was submitted to `stratum_step_done`, both flow steps became `failed`. Neither silently passed.

The actual surface diff is:

```diff
--- ws/raw/claude-failure-surface.json
+++ ws/raw/codex-failure-surface.json
@@ -1,29 +1,54 @@
 {
   "foreground": {
-    "message": "MCP error -32603: MCP error -32603: Claude Code returned an error result: There's an issue with the selected model (audit-invalid-claude-model). It may not exist or you may not have access to it. Run --model to pick a different model.",
+    "message": "MCP error -32603: MCP error -32603: {\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'audit-invalid-codex-model' model is not supported when using Codex with a ChatGPT account.\"}}",
     "data": {
       "code": "agent_run_failed",
       "usage": {
         "tokens": 0,
-        "ms": 1318
+        "ms": 7829
       },
       "split": {
         "input": 0,
-        "output": 0,
-        "cacheRead": 0,
-        "cacheCreation": 0
+        "output": 0
       },
       "telemetry": {
-        "durationMs": 1318,
-        "model": "audit-invalid-claude-model"
+        "durationMs": 7829,
+        "model": "audit-invalid-codex-model",
+        "effort": "high"
+      },
+      "sandboxAudit": {
+        "policy": {
+          "filesystemMode": "workspace-write",
+          "networkAccess": false,
+          "writableRoots": [],
+          "approvalPolicy": "never"
+        },
+        "provenance": {
+          "filesystemMode": {
+            "layer": "dispatch",
+            "source": "stratum_agent_run"
+          },
+          "networkAccess": {
+            "layer": "default",
+            "source": "built-in defaults"
+          },
+          "writableRoots": {
+            "layer": "default",
+            "source": "built-in defaults"
+          },
+          "approvalPolicy": {
+            "layer": "default",
+            "source": "built-in defaults"
+          }
+        }
       }
     }
   },
   "background": {
     "status": "error",
     "exitCode": 1,
-    "textTail": "There's an issue with the selected model (audit-invalid-claude-model). It may not exist or you may not have access to it. Run --model to pick a different model.",
-    "reason": "Claude Code returned an error result: There's an issue with the selected model (audit-invalid-claude-model). It may not exist or you may not have access to it. Run --model to pick a different model."
+    "textTail": "",
+    "reason": "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'audit-invalid-codex-model' model is not supported when using Codex with a ChatGPT account.\"}}"
   },
   "flowStatus": "failed"
 }
```

Three additional failure-surfacing asymmetries are counted:

- **FS-1 — diagnostic shape:** Claude surfaces a human-readable provider diagnostic in both assistant `textTail` and `reason`; Codex surfaces a nested JSON string as `reason` with empty `textTail`. This is actionable but not normalized.
- **FS-2 — progress before failure:** Claude emitted `agent_started`, then the invalid-model message as normal `agent_relay`, then zero-token `step_usage`, and only afterward rejected. Codex emitted only `sandbox_policy` and `agent_started` before rejecting. Neither emitted a connector `kind:"error"` progress event, so consumers cannot handle failures uniformly from the stream alone.
- **FS-3 — exit interpretation:** the controlled probe made Codex emit one agent message and exit 7; the connector resolved successfully with `text:"partial text"`. The paired Claude probe emitted the same assistant text followed by a non-success SDK result and rejected with `synthetic provider failure`. This matches Codex's explicit rule (`codex.ts:481-489`) versus Claude's subtype rule (`claude.ts:168-197`); an equivalent provider failure is not a common connector contract.

The installed Codex CLI did **not** reproduce the historical “API 400 with exit 0” premise: 0.153.3 emitted top-level `error` + `turn.failed` and the wrapper recorded rc=1. To verify `STRAT-CODEX-DISPATCH-1` itself, `zero-exit-probe.ts` injected the connector's documented `spawn` seam with rc=0. Results were:

```json
{
  "codexStructuredApiErrorExit0": {
    "settled": "rejected",
    "message": "Codex API error (status 400): synthetic API 400"
  },
  "codexEmptyOutputExit0": {
    "settled": "rejected",
    "message": "codex completed without agent output"
  },
  "claudeSuccessResultEmptyOutput": {
    "settled": "resolved",
    "result": { "text": "" }
  },
  "codexNonzeroExitWithAgentText": {
    "settled": "resolved",
    "result": { "text": "partial text" }
  },
  "claudeNonSuccessWithAssistantText": {
    "settled": "rejected",
    "message": "synthetic provider failure"
  }
}
```

Therefore the recent Codex work is verified at the connector boundary: structured API errors and empty rc=0 output both fail loudly. The same empty-output guarantee is absent from Claude (**OS-16**).

## VERDICT

**Refuted: the Stratum connector layer is not genuinely host-agnostic.** It exposes a common dispatch/result envelope and both connectors can complete the same workspace-write flow, but parity stops at that lowest common path. Codex alone has full sandbox-mode coverage, network/root/approval axes, policy provenance, selectable SDK/exec transport, reasoning events, durable post-restart background control, peer discovery, empty-output enforcement, and bounded foreground JSONL; Claude alone has tool allow/deny controls, thinking configuration, explicit correlated tool-result events, and cache-creation accounting. Live background telemetry diverges further: Claude preserves reported USD and cached-input detail while Codex polling drops its foreground estimate/provenance and the raw `cached_input_tokens` value. Failure is loud for the tested invalid models on both sides, but diagnostics, progress, and nonzero-exit semantics are not uniform. This is a provider-discriminated adapter pair behind shared types, not a capability-neutral connector abstraction.

## Constraints hit

- Both providers were authenticated; no Claude-auth constraint was hit.
- `stratum_step_done`'s frozen MCP request admits only `output|failure|usage|telemetry`, not connector `split|usdSource|sandboxAudit` (`contracts/mcp-surface.json:243-258`), even though `stratum_agent_run` returns those fields (`:1107-1124`). The matched flow driver therefore could not forward them. Both audit traces label submitted USD as `legacy` and omit Codex sandbox evidence; direct connector responses/progress are the authoritative comparison for those fields.
- Flow state was redirected to `conn/ws/state` so all audit artifacts remained in the requested scratch area. Durable agent runs were created by the supported path under `~/.stratum/ts/agent_runs/` and copied verbatim into `conn/ws/raw/`.
- The live Codex invalid-model process exited 1, not the historically observed 0. The rc=0 regression case was measured through the connector's process-boundary seam and is explicitly identified as a controlled fixture, not a live API observation.
- The Codex success stream's stderr contains unrelated local MCP OAuth-refresh noise and a recovered patch-format error; because the JSONL produced an agent message, `turn.completed`, and rc=0, those lines were retained as raw evidence but not classified as terminal connector failures.
- Timings, token counts, and costs are single observations, not performance claims. Claude default versus the requested Codex high-effort model makes their magnitudes intentionally non-comparable.
- No Stratum or Compose files were modified except this report; no test suite ran; `~/.stratum/config.toml`, Compose `ROADMAP.md`, and all `audit.json` files were untouched.

FINDINGS_COUNT: 20
