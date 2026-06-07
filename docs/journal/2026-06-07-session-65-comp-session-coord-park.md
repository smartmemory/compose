---
date: 2026-06-07
session_number: 65
slug: comp-session-coord-park
summary: Brainstormed + Codex-reviewed design for independent-claude-session file-clobber coordination; re-homed from a wrong coder-config placement to compose COMP-SESSION-COORD (PARKED).
feature_code: COMP-SESSION-COORD
closing_line: We set out to design a guard against sessions clobbering each other, and caught two of our own doing it live before we'd finished parking the spec.
---

# Session 65 — COMP-SESSION-COORD

**Date:** 2026-06-07
**Feature:** `COMP-SESSION-COORD`

## What happened

The human opened with an idea to brainstorm, not build: *can independently-launched `claude` instances in separate terminals know about each other so they stop clobbering each other's edits?* We ran it through the brainstorming flow. The scope narrowed fast and cleanly via a few choices — same-file grain (not feature/branch), warn+ask (not a hard mutex), and same machine / same working directory (so file-level collision is even possible). That last one matters: file clobbering only happens when sessions share files on disk, which makes the coordination registry a pure local-filesystem problem — no daemon, no network.

The key insight surfaced early: this is the *inverse* of compose's existing agent coordination. COMP-AGT-COORD coordinates agents compose spawns and owns (parent↔child); here nobody spawned the sessions, so there's no coordinator to lean on. The natural enforcement point is a Claude Code `PreToolUse` hook returning `permissionDecision:"ask"` — warn+ask falls out for free, no new UI.

We sent the written design through Codex for a design-level pass, and it earned its keep — it caught a real TOCTOU race (we checked for conflicts *before* recording our own claim), dismantled our too-glib heartbeat-lease justification (a false-stale isn't 'a missed nag' — it can be the very clobber the system exists to prevent), and flagged path-identity gaps (on macOS `Foo.js` and `foo.js` are the same inode). We folded those in: claim-then-check ordering, a recency rule that makes take-over self-resolving, hybrid pid+heartbeat liveness, canonical-path keys, a best-effort Bash-redirect heuristic, and an events.jsonl audit log.

Then the wrong turn. The human asked to convert it to a feature folder and park it. We reasoned our way to coder-config (it owns AI-tool hooks and even has a session activity-tracker on :3333) and scaffolded it there as CC-19. The human pushed back hard: 'wtf coder-config? it's independent of compose, we need it in compose.' Correct. We reverted coder-config entirely (it was uncommitted — clean), and re-homed the feature to compose as COMP-SESSION-COORD via `add_roadmap_entry`, rewriting the integration section to point at compose's own planned COMP-WORKSPACE-SESSIONS SessionManager instead of coder-config's service. Committed and pushed; the pre-push full suite came back green.

The punchline: while our push ran, `ps` revealed *another* session concurrently committing and pushing COMP-ROADMAP-GRAPH-1-1/-1-2 to this same repo — a live sighting of the exact multi-session collision COMP-SESSION-COORD is designed to catch. Our push won the race from the shared base; theirs will bounce non-fast-forward and need to integrate. We left it untouched and flagged it.

## What we built

- `docs/features/COMP-SESSION-COORD/design.md` (new) — full Phase-1 design, Codex-reviewed; standalone filesystem registry under `~/.claude/coord/<cwd-hash>/`, hybrid liveness, claim-then-check conflict detection, warn+ask flow, Bash heuristic, events.jsonl, testing plan, un-park open questions.
- `docs/features/COMP-SESSION-COORD/feature.json` (new) — status PARKED, complexity M, own phase 'COMP-SESSION-COORD: Independent Session Coordination'. Written by `add_roadmap_entry`.
- `ROADMAP.md` (modified) — regenerated with the new PARKED row + phase.
- Reverted: a wrong-headed coder-config `CC-19` placement (ROADMAP row + `docs/features/CC-19/`) — fully backed out, repo clean.
- Auto-memory updated to point at COMP-SESSION-COORD with the ownership lesson.

## What we learned

1. **Feature ownership = the product you work in, not the repo with the best-fitting infra.** coder-config technically had the closest plumbing (hook installer, activity-tracker), but the human works in compose and wants it there. Best-fit infra is a weak signal next to where the work actually lives; ask/confirm ownership before scaffolding, especially across product boundaries.
2. **Codex design-gate pays off on design docs, not just code.** Add a Status header so it critiques at the design level, then fix only design-actionable findings. It overturned a decision we'd defended twice (heartbeat-lease) with a sharper cost model — false-stale can be the clobber itself.
3. **Warn+ask collapses the hard part.** With no hard lock there's no deadlock, so liveness only affects signal quality — which is what let us choose a hybrid pid+heartbeat scheme without the deadlock-recovery machinery a true mutex would need.
4. **Claim-then-check needs an intent/edit split.** Recording our own claim before reading others (the TOCTOU fix) only coexists with a 'warn if someone edited more recently than me' rule if `claimedAt` (intent, pre-edit) and `lastEditAt` (completed, post-edit) are separate fields — which is why the design grew a PostToolUse hook.
5. **`add_roadmap_entry` returns the full ROADMAP and blows the MCP token cap.** The mutation still succeeds — verify on disk, do not retry. Bind the workspace (`set_workspace compose`) first, and pass an idempotency_key. Rows live in `compose/ROADMAP.md` (root), not `docs/ROADMAP.md`.
6. **We dogfooded the feature by accident.** Catching a concurrent push to the same repo mid-session is the clearest possible motivation for COMP-SESSION-COORD — and a reminder that the pre-push suite + non-fast-forward rejection are today's only (coarse, after-the-fact) guardrails against it.

## Open threads

- [ ] Un-park decision: integration path 1 (standalone FS registry) vs 1+2 (mirror conflicts into the compose UI via COMP-WORKSPACE-SESSIONS). Recommendation in the doc is 1 now, mirror later.
- [ ] Fallback heartbeat window default (15 min) — validate when pid capture is unavailable.
- [ ] Should the Bash heuristic eventually *record* intent for high-confidence single-target redirects, or stay detection-only?
- [ ] Is a `compose session-coord ls` (list active sessions across partitions) worth it, or scope creep?
- [ ] The concurrent session pushing COMP-ROADMAP-GRAPH-1-1/-1-2 will hit a non-fast-forward rejection (we advanced main) — it needs to fetch + integrate `c5a192f` before its push lands. Left untouched.

---

*We set out to design a guard against sessions clobbering each other, and caught two of our own doing it live before we'd finished parking the spec.*
