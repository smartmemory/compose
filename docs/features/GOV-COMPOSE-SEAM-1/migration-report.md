# GOV-COMPOSE-SEAM-1 `canon-on-decisions` P3 — backfill report

**Target workspace:** `team_b3774c516a5f` · **API:** `http://localhost:9001`

- Decision-shaped ledger entries: **43**
- Written this run: **0**
- Already present (verified server-side, skipped): **43**
- Failed: **0**

## Superseding links NOT applied

`POST /memory/decisions/{id}/supersede` builds its replacement from `new_content`,
`new_decision_type` and `new_confidence` only — no `source_type`, no
`context_snapshot`, no tags. Using it here would mint extra decisions with no
idempotency key and break the run-it-twice property, so these links are recorded
and left unapplied rather than faked. Closing them needs a service change.

- [35] supersedes `not-bias-but-threshold` — The reading machine is not biased; it is handed unanswerable questions
- [102] supersedes `retire-not-gated-on-parity` — switching off the old /competitors skill is not gated
- [110] supersedes `research-pass-per-box` — every box gets a literature pass before its sketch locks

