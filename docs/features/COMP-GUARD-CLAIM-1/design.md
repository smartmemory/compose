# COMP-GUARD-CLAIM-1 — Correct COMP-MCP-ENFORCE's false guard-coverage claim

**Status:** DESIGN — 2026-08-18
**Complexity:** S (doc-only, single file)
**Implements:** COMP-COMPLETION-GATE AC-14

## Related Documents

- Source of false claim: `docs/features/COMP-MCP-ENFORCE/report.md` (lines 8, 52–56)
- Audit that proved the claim false: `docs/features/COMP-COMPLETION-GATE/design.md` §1.1–1.5
- This correction does not touch code; it amends a shipped implementation report

---

## 1. The problem

`docs/features/COMP-MCP-ENFORCE/report.md` makes two overlapping claims that were never true.

### Claim 1 — line 8, Summary section

> "No caller — skill, human cockpit, or rogue MCP/REST client — can effect a transition the guard refuses."

This asserts universal coverage. It is false. `ensureGuard` / `guardedTransition` live exclusively in:
- `server/vision-routes.js` — HTTP, requires a live `:4001` server
- `lib/judgment-writer.js:262` — a separate mode

The CLI (`bin/compose.js`) and the build runner (`lib/build.js`) run in-process with no server and call no guarded transition. They are the paths that actually write COMPLETE. They were never covered.

### Claim 2 — line 56, Slice 3 section

> "The MCP boundary is closed against four bypass paths (`set_feature_status`, `add_roadmap_entry`, `propose_followup` reject lifecycle-owned COMPLETE/KILLED; `record_completion` enforces the same evidence) — each requires an out-of-band `STRATUM_GUARD_OVERRIDE_TOKEN` to deviate, the single authorized escape replacing `force`. *(Codex: 4 rounds enumerating every public terminal-write path → CLEAN.)*"

The first sentence is accurate for MCP tools. The Codex annotation ("every public terminal-write path → CLEAN") generalizes that to all callers — but the enumeration did not include the CLI and build runner, which are in-process paths that bypass the HTTP boundary entirely.

### Measured coverage (COMP-COMPLETION-GATE §1.1, independently re-verified)

| metric | value |
|---|---|
| managed feature codes | 321 |
| guard resources registered for this workspace | 31 |
| guard IDs matching a managed feature code | **0** |
| features with status COMPLETE | 230 |

All 31 registered resources are leaked test fixtures (`BUG-1`, `BUG-TEST-001`, `PROOF-1`, etc.). Real coverage was zero when the report was written and remained zero through the date of the COMP-COMPLETION-GATE audit (2026-08-18). 230 features reached COMPLETE without a single one passing a guarded transition.

### Why the claim appeared true

The report accurately describes what the MCP/REST boundary did: the four MCP-tool bypass paths were closed. That is real and correct. The error is generalization — the report extrapolates from "no MCP caller" to "no caller," without accounting for the in-process CLI and build runner that were never wired to `guardedTransition` at all.

---

## 2. What has changed since the report (slice 1+2 reality)

COMP-COMPLETION-GATE slices 1 and 2 extended coverage:

| path | gated as of |
|---|---|
| `record_completion` MCP tool (path 1) | COMP-COMPLETION-GATE slice 1 |
| `compose record-completion` CLI (path 2) | COMP-COMPLETION-GATE slice 1 |
| build runner terminal write (paths 3–4) | COMP-COMPLETION-GATE slice 2 |

**Still open after slices 1+2** (paths from COMP-COMPLETION-GATE §1.3):

| path | file:line |
|---|---|
| `setFeatureStatus` / MCP `set_feature_status` | `lib/feature-writer.js:406`, `server/compose-mcp-tools.js:326` |
| `PATCH /api/vision/items/:id` | `server/vision-routes.js:148` |
| stratum audit ingestion | `server/stratum-sync.js:234` |
| `VisionWriter.updateItemStatus` direct mode | `lib/vision-writer.js:310` |

The correction must describe the slice-1+2 state without claiming the full-gate coverage that AC-14 reserves for later slices. Swapping "no caller" for "most callers" would repeat the same error at a different scale.

---

## 3. The correction

### AC-14 requirement (from COMP-COMPLETION-GATE design.md §5)

> `COMP-MCP-ENFORCE/report.md:8,52` corrected with a dated note; the original claim preserved, not deleted; the correction describes the new guarantee accurately (evidence-checked + ledgered, not lifecycle-enforced) rather than swapping one overclaim for another.

### What the correction must say

The replacement text must:

1. **Preserve the original claim** — strike it, but keep it readable so history is traceable.
2. **State what was actually delivered** — the MCP/REST boundary was closed (four specific MCP tool paths); the HTTP-facing `advance` / `skip` / `complete` / `kill` transitions are fail-closed when `capabilities.guard` is true.
3. **State the measured non-coverage** — zero managed features were ever registered; 230 COMPLETE features completed without a guarded transition.
4. **State the current (post-slice-1+2) reality** — `record_completion` (MCP + CLI) and the build runner are now gated; four paths remain open.
5. **Forward-reference COMP-COMPLETION-GATE** — the plan to close the remaining paths.

### What the correction must NOT say

- Do not say "completions are guarded" — four write paths remain open.
- Do not say "evidence is verified for all completions" — that is slice-2 reality only for the build runner and slice-1 reality only for record_completion; the remaining four paths are unchecked.
- Do not add a new ceiling claim without measuring it. The honest ceiling after slices 1+2: "completions via `record_completion` (MCP/CLI) and the build runner are evidence-checked and ledgered; other status-mutation paths are not."

### Replacement text — line 8 (Summary section)

**Old text (preserve with strikethrough or dated correction block):**
```
No caller — skill, human cockpit, or rogue MCP/REST client — can effect a transition the guard refuses.
```

**New text (dated correction note, appended inline or as a block immediately after):**
```
> **Correction — 2026-08-18 (COMP-GUARD-CLAIM-1):** The claim above was not true when written
> and was not true at ship. The guard covered only HTTP-facing lifecycle transitions in
> `server/vision-routes.js` — the CLI and build runner run in-process and called no guarded
> transition. COMP-COMPLETION-GATE's audit (2026-08-18) measured 321 managed features against
> 31 registered guard resources with zero overlap (all 31 are leaked test fixtures), and
> 230 COMPLETE features none of which passed a guarded transition. After COMP-COMPLETION-GATE
> slices 1–2 (2026-08-18), `record_completion` (MCP + CLI) and the build runner are gated;
> `setFeatureStatus`, the vision PATCH endpoint, stratum-sync, and direct `updateItemStatus`
> remain open. See `docs/features/COMP-COMPLETION-GATE/design.md` for the full plan.
```

### Replacement text — Slice 3 section (lines 55–56)

The Slice 3 claim is structurally correct for MCP. The annotation "*(Codex: 4 rounds enumerating every public terminal-write path → CLEAN.)*" is the overclaim — the CLI and build runner were not enumerated.

**Append a dated correction note after the Slice 3 paragraph:**
```
> **Correction — 2026-08-18 (COMP-GUARD-CLAIM-1):** The MCP tool boundary above is accurate.
> The Codex annotation ("every public terminal-write path") is not: COMP-COMPLETION-GATE's
> audit identified 14 paths (§1.3), of which the CLI and build runner — the paths that account
> for the majority of real completions — were not covered. The annotation reflects an incomplete
> enumeration; it does not reflect coverage.
```

---

## 4. Implementation

**Single file changed:** `docs/features/COMP-MCP-ENFORCE/report.md`

Two edits:
1. Append a dated correction block after line 8's summary paragraph (or inline after the "No caller..." sentence).
2. Append a dated correction block after the Slice 3 paragraph (line 56).

No code changes. No other files.

---

## 5. Acceptance criteria

- [ ] Original text at lines 8 and 56 preserved (not deleted); correction clearly dated with COMP-GUARD-CLAIM-1
- [ ] The correction states: zero managed features were ever registered; 230 COMPLETE without a guarded transition
- [ ] The correction states the post-slice-1+2 ceiling honestly: record_completion + build runner gated; four paths still open (named)
- [ ] Forward reference to `docs/features/COMP-COMPLETION-GATE/design.md` present
- [ ] No new absolute claim introduced (no "all callers", no "completions are guarded")
- [ ] CHANGELOG entry added in the same edit
