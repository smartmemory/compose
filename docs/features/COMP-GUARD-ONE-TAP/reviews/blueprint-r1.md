# Codex blueprint gate r1 (gpt-6-astra/high, 2026-09-06)

Twelve findings (1 P1, 11 P2), all dispositioned in `blueprint.md` §"Codex blueprint gate r1 disposition".

1. **P1 — Enrolment omits the protected spawn contract.** The root step specifies `sudo -k /bin/sh -s` and unqualified installer commands, but does not apply `SUDO_ENV` or pin the installer's executables. **Fix:** scrubbed environment and absolute executables for the root installation step; assert the spawn contract.
2. **P2 — The unconditional test-custody enrolment refusal is missing.** **Fix:** reject every non-sudo backend before any installation or trust-root operation; test the orchestrator with spies proving zero side effects.
3. **P2 — Enrolment can print `done` without verifying the installed descriptor pair** (the inspector lists signers even when verification fails, `descriptors.ts:253`). **Fix:** reuse the round-trip fixture after rebuilding; require verified signature + fingerprint.
4. **P2 — Publication can discard the verified pair and publish an invalid generation** (existing `<sha>` failing verification falls through to signing; race destination used unverified). **Fix:** refuse invalid existing generations without moving `current`; re-verify a reused destination.
5. **P2 — The verdict differs from apply's acceptance** (`group_or_world_writable` reported separately, `descriptors.ts:266`, refused by apply at :200). **Fix:** require ok + verified + not writable.
6. **P2 — Concurrent backfills cannot wait through the approval window** (lock deadline 30 s, `lib/dir-lock.js:57`). **Fix:** configurable acquisition budget; test contention through approval and apply.
7. **P2 — Real infrastructure failures bypass the refusal envelope** (enumeration throws at `guard-descriptors.js:95`; route's generic 400 at `vision-routes.js:689`). **Fix:** normalise to `{code,message,hint}`; clean staging; HTTP/MCP real-failure test.
8. **P2 — Manual recovery prints a command for an unpublished file.** **Fix:** separate manual preparation path preserving unsigned candidate bytes without changing `current`.
9. **P2 — Status rejects the decided r3 layout** (`guard/` 0700 vs 0755). **Fix:** `guard/` 0755, `private/` 0700, sudoers 0440.
10. **P2 — Signing status lacks workspace resolution and `--prune`.** **Fix:** resolve the workspace; prune under the lock preserving `current`.
11. **P2 — The test plan misreads the producer path** (enumeration uses the real `guardPolicy` transport, `guard-descriptors.js:92`; the gate drops `prompts`, `completion-gate.js:971`). **Fix:** exercise the real chain against the stratum copy; assert confirmation-log counts.
12. **P2 — Stale references** (`:300`/`:334` swapped; C4 cache write at :431; `_testOnly_setGuardClient` is unrestricted). **Fix:** correct; cite stratum's guarded setter as precedent.
