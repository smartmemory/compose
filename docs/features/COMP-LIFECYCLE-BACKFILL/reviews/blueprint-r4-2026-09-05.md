# Blueprint gate — round 4, fixes-only (2026-09-05/06)

Reviewer: Codex `gpt-6-astra/high`, stratum agent run `f79ddc7ffbaf`, 347 s, 1.09M tokens.
Scope: the 8 round-3 fixes only. The reviewer also EXECUTED the §7.1 step-4 dependency-resolution
strategy from `stratum/ts`: all nine dependencies resolve to roots with matching package names, and the
in-place CLI smoke returns exit 1 with usage text. R3-3's schema was checked with AJV against a genesis
record produced by the real history writer: accepted.
Verdict: 1 × P1, 1 × P2 — both residuals of R3-2, both folded by the controller (targeted edits; no
further review round per the review-budget rule).

## Raw findings

1. **P1 — R3-2 still permits unchecked recovery.** `blueprint.md:545` still instructs omitting the recovery checksum; `:279` repeats that instruction. The schema permits its omission, and `:1507` forwards that optional field rather than the required persisted checksum. AJV confirmed that an envelope without it validates. **Evidence:** `stratum/ts/src/cli/guard.ts:104` omits checksum enforcement for absent/null values; `stratum/ts/src/guard/transition.ts:566` checks only when supplied, allowing the pre-transition crash scenario to apply under changed policy at `:660`. **Change:** remove both omission instructions, validate a non-null persisted checksum before guarded recovery, and pass `writeContext.policyChecksum`; require any duplicated envelope checksum to match it.

2. **P2 — R3-2's new recovery path checks the wrong error shape.** `blueprint.md:1508`, `:1574`, and `:1581` check `.error`, but raw CLI errors have top-level `status`, `error_type`, and `message`. **Evidence:** `compose/server/stratum-client.js:235` returns parsed stdout unchanged; `stratum/ts/src/cli/guard.ts:42` defines that envelope. Executing the real transport with its test seam confirmed the checksum condition is false; a history error then reaches `h.ledger.find` and throws instead of returning the specified recovery refusal. **Change:** handle both transport-local `.error` and canonical `status === 'error'` before inspecting successful response fields, and test both shapes.

## Adjudication

| # | Sev | Verdict | Evidence opened | What changed in blueprint.md |
|---|---|---|---|---|
| 1 | P1 | **CONFIRMED** | `ts/src/cli/guard.ts:104-106` spreads `expectedPolicyChecksum` only when the payload key is present and non-null; `transition.ts:566` checks only when supplied. The r3 fold fixed the §5.9a algorithm but left the schema description (`:279`, `type: ["string","null"]`, "Deliberately NOT sent on a replay"), the payload table (`:545`, "without") and the call site reading `env.expected_policy_checksum` | Schema: `type: "string"`, description rewritten (always present, equal to `policy_checksum`, contract test rejects omission/mismatch). Payload table row: "same eight keys, persisted checksum, never omitted". §5.9a: refuse at `recovery` if `writeContext.policyChecksum` is null/malformed or disagrees with the envelope, BEFORE the transport call; send `writeContext.policyChecksum`. Correction row C43 |
| 2 | P2 | **CONFIRMED** | `server/stratum-client.js:235` returns `JSON.parse(stdout)` unchanged on non-zero exit (canonical `{status:'error',error_type,message}` per `ts/src/cli/guard.ts:42-46`); only `:230`/`:237` wrap as `{error}`. `guardedTransition` normalises both (`lifecycle-guard.js:368-370`) but §5.9 uses the raw verbs. S1-3's `guardPolicy` check at `stored.error` had the same bug, not cited by the reviewer | Three helpers `isGuardError` / `guardErrorType` / `guardErrorMessage` exported from `server/lifecycle-guard.js` (added to Boundary Map S01); §5.9a transition, §5.9c digest + history, and S1-3 `guardPolicy` all use them; a non-mismatch transport error on recovery now refuses at `recovery` explicitly. Helper tests in `test/lifecycle-guard.test.js`; R25-R29 run under both shapes. Correction row C44 |

Boundary Map validator after the fold: `{"ok":true,"violations":[],"warnings":[]}`.
Verification Table: +5 rows (`stratum-client.js:235`, `:230`/`:237`, `lifecycle-guard.js:368-370`,
`guard.ts:42-46`, `guard.ts:104-106`), each re-opened with `sed -n`.

**Gate closed** after four rounds (18 → 13 → 8 → 2 findings, every one confirmed). The remaining two
were residuals of a single round-3 fix and were folded as targeted edits.
