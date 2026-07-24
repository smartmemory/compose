---
date: 2026-07-24
session_number: 98
slug: canon-guard-prevention-slice
summary: COMP-CANON-GUARD S1+S4 — the canon registry and the write-time hook that finally blocks raw edits to judgment canon
feature_code: COMP-CANON-GUARD
closing_line: The guard that exists to stop unattributed writes almost shipped its own unverified bypass — twice — before the loop caught it.
---

# Session 98 — COMP-CANON-GUARD

**Date:** 2026-07-24
**Feature:** `COMP-CANON-GUARD`

## What happened

We resumed a clean session and picked COMP-CANON-GUARD — the enforcement half of the judgment layer. The epic had already burned five design-gate rounds and shipped S0 (log mode) and S3 (the judgment writer, carved out as COMP-JUDGMENT-WRITER). Its own Scope Verdict was blunt: the remaining slices were specced against a build-correlation model that turned out dead (all 777 real events carry build_id: null), so 'do not build S1-S6 against the current assumptions.' We split the remaining work into two piles — a clean pile buildable now (S1 registry + S4 hook, which operate on tool-calls and paths, untouched by the dead correlation model) and a tangled pile needing a re-spec (S5/S6). The user chose the prevention slice.

We grounded hard before writing code — this feature's entire history is design-by-assertion being wrong about once per claim, and we did not want to become the sixth example. That grounding immediately paid: the design's literal-set assumption was already stale, docs/judgment/** turned out to be tracked records plus generated projections (not just markdown), .claude/settings.json is git-tracked (so hook registration is a real project default, not a machine-local flag), and the whole thing surfaced the one load-bearing design decision — a shared registry must NOT imply shared coverage.

We built S1 (registry, ship behavior byte-preserved), gated it with Codex (approved the central claim via a 351-case equivalence check; two findings fixed), and committed. Then S4 (the hook + CLI), which took two adversarial Codex rounds. The most instructive bug: our first fix for a macOS firmlink bypass was itself wrong — realpath does NOT collapse /System/Volumes/Data firmlinks, so we had to strip the prefix by hand. Round two then found a symlink-plus-.. root cause (resolve() collapsing .. before symlinks resolve). We fixed the realistic vectors, documented the exotic ones as accepted (Bash-bucket), and stopped the loop at two rounds rather than chase the unbounded adversarial tail the Scope Verdict warned about.

## What we built

S1: lib/canon-registry.js (single source of truth: path pattern -> writer -> tools -> enforcedBy), lib/mcp-enforcement.js refactored to consume only the registry's 'ship' subset (behavior byte-preserved, pinned by test/canon-registry-contract.test.js), vestigial _internals shim deleted. S4: lib/canon-guard.js (pure decideCanonGuard + realpathCanonicalize + settings install/uninstall/status transforms), .claude/hooks/canon-guard.mjs (PreToolUse runtime wrapper emitting the deny envelope), compose guard install|uninstall|status in bin/compose.js, test/canon-guard.test.js. The guard is installed live in compose's own .claude/settings.json. docs/features/COMP-CANON-GUARD/blueprint-s1-s4.md carries the grounded corrections table and the full review ledger. Committed @27551dd (S1) and @2e83fbe (S4); full suite 4830 pass / 0 fail.

## What we learned

1. One registry does not imply one coverage. The shared canon registry guards judgment at the write-time hook while leaving ROADMAP/feature.json ship-only — because those have legal mutations no tool covers yet (Decision 2 lockout). A per-entry `enforcedBy` field makes the coverage gap explicit DATA rather than a hidden assumption, which is exactly the 'looks enabled, enforces nothing' trap the design feared. This was the whole design of the slice.
2. macOS firmlinks are not symlinks to realpath. realpathSync.native('/System/Volumes/Data/Users/x') returns itself unchanged even though it is the same inode as /Users/x. Any path-containment guard that trusts realpath alone has a silent alias bypass on every Mac. Strip /System/Volumes/Data by hand; realpath handles symlinks and case but not firmlinks.
3. resolve() before realpath is a bug. resolve() collapses `..` lexically, so `symlink/../real` mis-normalizes before the symlink resolves. Walk up the RAW path to the longest existing prefix and realpath THAT.
4. Grounding is the cheapest gate. Every load-bearing surprise (stale literal sets, tracked-vs-gitignored settings, records-vs-projections) came from reading the real code before writing, not from review after. The review then caught what grounding could not — the aliasing edges.
5. Stop the review loop deliberately. Two rounds closed every realistic vector; round-two's residuals were the unbounded adversarial tail. CLEAN is a cap, not a target — we documented the accepted limits and shipped.

## Open threads

- [ ] S5: non-feature-scoped ship scan for docs/judgment/** + pre-commit git hook + build-independent attestation — needs the dead build-correlation model re-specced first (build_id is always null).
- [ ] S6: content-attestation hash chain (closes the interleaved tool-call-plus-hand-edit bypass).
- [ ] Override protocol (canon_override_grant, ledger-first token) — deferred; only needed once ROADMAP/feature.json become hook-registered (which needs update_feature_fields + open_preserved_section per Decision 2).
- [ ] The guard is Claude-runtime only — Codex-dispatched and Bash edits still bypass; that is the S5/S6 runtime-neutral backstop.
- [ ] Commits are local; pushing is the user's call.
- [ ] .compose/data/settings.json is back to {} — S0's log mode is off again on this machine (gitignored, machine-local); a tracked project default is an open S2-inventory item.

---

*The guard that exists to stop unattributed writes almost shipped its own unverified bypass — twice — before the loop caught it.*
