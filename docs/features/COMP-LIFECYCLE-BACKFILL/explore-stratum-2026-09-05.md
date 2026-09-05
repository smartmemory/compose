# Exploration: stratum guard surfaces for COMP-LIFECYCLE-BACKFILL (2026-09-05)

Read-only map of stratum 0.4.1 (`stratum/ts`) produced by a compose-explorer pass; saved by the controller.
Companion: `explore-compose-2026-09-05.md`.

## Q5 — Does the MCP-only restriction on apply-upgrade still hold?

**No.** Decision 6 of `stratum/docs/features/STRAT-GUARD-DESCRIPTOR/design.md:202-222` rests on a
three-step attack: write your own descriptor file, compute its digest, point both env vars at them.
Step 2 no longer exists: `STRATUM_GUARD_UPGRADE_DESCRIPTORS_SHA256` was deleted and the only
env-controlled input is the path (`src/guard/descriptors.ts:20-22`: "Locating an artifact is not
authorizing it: point this anywhere, the signature still has to verify").

Residual attacks are identical on both surfaces:
- Process-environment injection (`NODE_OPTIONS`) — conceded unfixable in-process. The MCP asymmetry
  only holds for a long-lived server the operator launched; compose spawns the stratum MCP server
  itself over stdio and owns that environment too.
- Editing the committed trust root `contracts/guard-signers.allowed` — surface-independent ceiling.
  Weaker for compose than the docs claim: compose resolves the INSTALLED package, so the trust root it
  reads is `compose/node_modules/@smartmemory/stratum/contracts/guard-signers.allowed` — not in any
  repo, no `git status` line. (Today that path is a symlink to `stratum/ts`, so it IS the checkout.)

The installed trust root currently has zero signer lines; every signed path reports itself
unavailable until a key is enrolled.

## 1. guardRegister (`src/guard/transition.ts:393-455`)

- Validates (`_validatePolicy` :414), computes checksum, takes the resource lock.
- Identical policy → `status: "exists"`, writes nothing (:428). Different policy →
  `GuardAlreadyRegistered` "use migrate" (:436-438). Fresh registration: `graph_version: 1`.
- No authorization. **A brand-new guard may be registered with `complete_backfilled` in `terminal`.**
  Only already-registered resources need the descriptor.
- `guardChecksum` (`src/guard/fingerprint.ts:7-20`): sha256 over canonical JSON of
  `{graph, edge_predicates, terminal, stakes}`; `terminal` sorted, adjacency arrays NOT sorted,
  predicates as-is. Canonical JSON sorts object keys (`src/guard/canonical.ts`). **Adjacency order and
  predicate order are load-bearing for `from_checksum` equality** — compose must emit byte-stable order.
- `_validatePolicy` (:296-389), shared by register/migrate/upgrade/apply-upgrade: names
  `[A-Za-z0-9_.-]+` (`src/guard/store.ts:81-85`); `__proto__`/`constructor`/`prototype` refused
  (:67, :345); `initial` must be a node or terminal; predicate types deterministic|verified|judged.

## 4. Descriptors and guardApplyUpgrade — CAN add a terminal state

`src/guard/descriptors.ts` (281 lines). Path env `STRATUM_GUARD_UPGRADE_DESCRIPTORS` (:33, must be
absolute :145-149); the SHA256 pin env is gone. Detached signature at `<path>.sig` (:67), namespace
`stratum-guard-descriptors` (:35). Trust root `contracts/guard-signers.allowed` resolved from module URL
(`trust.ts:23`); empty/unreadable = unavailable (`trust.ts:78-83`). Native Ed25519 verify
(`sshsig.ts:1-13`). File must not be group/world-writable (:200-202). All failures collapse to
`upgrade_descriptor_unavailable` (:184-189).

File format (:107-129, :160-181):
`{ "version": 1, "descriptors": [ { "id", "rationale", "from_checksum", "to_policy": {graph, edge_predicates, terminal, stakes} } ] }`
Unknown keys rejected at every level (:78-84). `id` `[A-Za-z0-9_.-]+`, unique. `from_checksum` 64-hex.
`to_policy` has exactly the four checksum fields; `initial`/`workspace_root` come from the stored registry.

`guardApplyUpgrade(resourceId, descriptorId, env)` — `transition.ts:1070-1133`: load+verify file OUTSIDE
the lock (:1075); lock; tamper check (:1085); destination check FIRST → `unchanged`, writes nothing
(:1092); `from_checksum` mismatch → `upgrade_descriptor_mismatch` naming both (:1095-1100);
`_validatePolicy` with registry.initial/workspace_root (:1102); current_state must be a node or
terminal in the new graph (:1103); apply, graph_version+1, ledger. No additive classifier — the path
exists to grant a terminal state (:1055-1067). Fixture `tests/guard/descriptors.test.ts:61-69` builds
`complete_backfilled` exactly.

## 6. Trust root in tests

`setGuardTrustRootForTests(path|null)` `trust.ts:39-46`, refused unless `NODE_ENV=test`. Signer helper
`tests/helpers/sshsig-sign.ts` `createTestSigner()` (:29) — independent Ed25519 signer producing real
armored sshsig. Golden ssh-keygen artifacts `tests/fixtures/sshsig/`. Recipe
`tests/guard/descriptors.test.ts:96-140`: write trust root line `operator <pubkey>`, install seam, write
descriptor JSON chmod 0600, write `.sig` = sign(EXACT bytes), set env, call apply.

**Consumer blocker:** `ts/package.json` has no `main`/`exports` — only `bin`. Compose cannot import the
seam or any guard function; only the two binaries are a supported surface. No env override exists for
the trust root or guards dir (`store.ts:58` uses `homedir()`; `$HOME` override isolates it).

## 7. Apply-upgrade ledger entry

`transition.ts:1108-1122`: kind/outcome `graph_version`, from=to=current_state, `resolved_by: "human"`,
rationale `descriptor <id> signed by <principal> (<fp>, file sha256 <digest>): <rationale>`. Response
carries no `authorized_by` (applied: {status, checksum, graph_version, ledger_ref, descriptor_id};
unchanged: no ledger_ref). History append-only, hash-chained; `unchanged` writes nothing. Read back via
`history` (CLI :163-165, MCP `stratum_guard_history`).

## 8. MCP client

Stratum ships no client. Compose already has one: `lib/stratum-mcp-client.js` (SDK Client +
StdioClientTransport, generic `#callTool` :517, `hasTool` :490). Guard tool errors arrive as a normal
tool result `{status:"error", error_type, message}` (`server.ts:326-330`, `:444`) — same envelope the
CLI prints, so compose's CLI error parsing transfers. The installed dist CLI (0.4.1) genuinely lacks
`apply-upgrade` (`dist/cli/guard.js:75`).

## 2. guardUpgrade cannot add a terminal state

`transition.ts:980-1069`, classifier `_upgradeIncompatibilities` `:881-978`. `terminal` frozen both
ways (:963-969); no new edge may terminate at a pre-existing state (:932-936) or leave a terminal
(:944-947); existing predicates/stakes byte-identical (:906-921). Grafting `complete_backfilled` →
`incompatible_policy_upgrade` on every registered resource. Only value: identical policy → `unchanged`,
no ledger entry (:1015-1019). Refusal text (:1024-1027): "use a signed upgrade descriptor, or guard
migrate with a signed authorization".

## 3. guardMigrate — per-resource signed authorization

`transition.ts:780-847`; CLI keys `src/cli/guard.ts:95`. Signed payload reconstructed server-side as
`{action:"migrate", resource_id, policy_checksum, rationale, ledger_head}` canonical JSON, namespace
`stratum-guard-migrate` (`authorization.ts:30-33, 54-60`; called `transition.ts:794-799`).
`ledger_head` read inside the lock (`:705-708`). Cost for a fleet: one human signature per resource,
killed by any intervening transition. `guard authorize` (CLI-only, read-only, `guard.ts:114-155`)
prints payload + exact `ssh-keygen -Y sign` invocation. Not the routine path.
