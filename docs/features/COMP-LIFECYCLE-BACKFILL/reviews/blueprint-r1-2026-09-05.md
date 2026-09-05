# Blueprint review round 1 — 2026-09-05 (Codex gpt-6-astra/high)

18 findings (14 must-fix, 3 should-fix, 1 nit). Controller adjudication: **all confirmed**. Resolutions
are design-level where marked (D) and blueprint-level otherwise.

| # | Finding (short) | Sev | Resolution |
|---|---|---|---|
| 1 | `idempotency_conflict` branch adopts any applied entry under the key; reintroduces R2-1 | must | **(D)** Refuse unless the ledger entry's `payload_digest` matches a digest computed by **stratum** for the persisted envelope + the policy checksum persisted in the intent before the transition. New stratum read-only CLI action `guard digest` (0.4.3) computes it; compose never reimplements `fingerprint`/canonical JSON. Also require current_state still `complete_backfilled` and no later transition entry. Missing material → refuse |
| 2 | Terminal refused before replay; replay sends fresh `fromState` | must | Split bootstrap (new op) from recovery (replay the saved envelope unchanged, before any terminal/policy check) |
| 3 | Recovery reader expects fields never persisted | must | One recovery DTO = the intent file (full request, envelope, checksum, stable timestamps, tests attestation). Pending batch record is a marker only; pending record without intent → refuse |
| 4 | History validated after the guard transition | must | Materialise + validate prospective history before register/upgrade/transition; persist that result |
| 5 | Finalize unconditionally; `safeAppendEvent` swallows; in-memory record mutated before save | must | Finalize only with empty failure set and positively confirmed audit write (non-swallowing append); roll back in-memory on save failure; emit backfill audit even when status already COMPLETE |
| 6 | Re-drive duplicates terminal occurrence, rewrites timestamps | must | Stable timestamps persisted once in the intent; terminal occurrence carries `operation_id`; skip append if present |
| 7 | Merge joins by `_id` nobody assigns; shared mutable objects | must | Temp ids, clone candidates, compare recomputed closure against untouched originals; H5 exercises it |
| 8 | ISO-string vs epoch comparisons; `%aI` offsets | must | Parse to epoch, validate finite, compare numerically; validate final history incl. terminal (future-dated commit) |
| 9 | Occurrence DTO incomplete; out-of-graph exemption too wide | must | Full occurrence construction; reject unknown incoming phases; marker exemption only for the existing genesis record |
| 10 | MCP tool calls the gate directly but MCP is a separate process | must | MCP delegates to the HTTP route (`_postLifecycle` pattern); server passes the live store into the gate |
| 11 | fix/plan modes (`tracksFeatureJson:false`) cannot pass feature preflight | must | Mode-aware preflight and writes: lifecycle-only writes for modes without feature.json; real fix-mode gate flow test |
| 12 | Guard-off backfill still calls stratum | must | Guard calls inside `if guarded`; unguarded source from lifecycle; local terminal legality; guard-off flow test |
| 13 | Sync test run under the dir lock starves the heartbeat | must | Async runner while holding the lock (keep R2-5 order) |
| 14 | `yaml` resolves into a pnpm nested dir with only `yaml` | must | Symlink the real package root's own `node_modules` if present, else the nearest ancestor `node_modules` of the package root; smoke-run the copied CLI first |
| 15 | Wrong fixtures (graph vs policy, H1 equality, R7/R15/R22) | should | As specified by the reviewer |
| 16 | Emit passes `origin ?? 'live'` but test wants absence preserved | should | Pass `entry.origin` unchanged; readers interpret absence |
| 17 | judgment-writer surplus-edge test + golden adjacency pins not in plan | should | Add both suites to the File Plan; update expectations, never weaken |
| 18 | Two stale citations; blanket "zero stale" claim | nit | Fix and re-sweep |
