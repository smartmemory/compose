# COMP-CODEX-PROVIDER-1: Compose has no first-class Codex lifecycle provider path: COMP-HOST-PORTABILITY-1 measured BOTH lifecycle hosts spawning only Claude via @anthropic-ai/claude-agent-sdk (lib/local-claude-connector.js), with Codex present only as the OUTER driver on host B, never as an implementation child. There is no lib/local-codex-connector.js; existing Stratum Codex support alone is insufficient, and COMP-CODEX-IMPL (COMPLETE) flips build-step agents in a spec variant rather than supplying a Compose-side provider. Implement or choose a first-class Compose Codex connector, route every phase, repair, gate and review through it, and supply host-neutral prompts and real install targets (Codex currently shares Claude skill paths; custom agents and plugin management stay Claude-oriented). Sized L and BLOCKS a genuinely Codex-executed lifecycle. Prerequisites G1-G4 (gate addressing, failed-phase resume, review prompt size and bounded provider recovery, authoritative lifecycle state bridge) are all M, all BLOCKS-level, and all still unfiled. Acceptance is the report's pilot test: design through ship, real Codex dispatch evidence per required phase, gates controlled without a web UI, verification and dependencies preserved, and resume from a deliberately failed review with recorded cost and provenance. Gap G5.

**Status:** PLANNED
**Created:** 2026-09-17

---

## Intent

Compose has no first-class Codex lifecycle provider path: COMP-HOST-PORTABILITY-1 measured BOTH lifecycle hosts spawning only Claude via @anthropic-ai/claude-agent-sdk (lib/local-claude-connector.js), with Codex present only as the OUTER driver on host B, never as an implementation child. There is no lib/local-codex-connector.js; existing Stratum Codex support alone is insufficient, and COMP-CODEX-IMPL (COMPLETE) flips build-step agents in a spec variant rather than supplying a Compose-side provider. Implement or choose a first-class Compose Codex connector, route every phase, repair, gate and review through it, and supply host-neutral prompts and real install targets (Codex currently shares Claude skill paths; custom agents and plugin management stay Claude-oriented). Sized L and BLOCKS a genuinely Codex-executed lifecycle. Prerequisites G1-G4 (gate addressing, failed-phase resume, review prompt size and bounded provider recovery, authoritative lifecycle state bridge) are all M, all BLOCKS-level, and all still unfiled. Acceptance is the report's pilot test: design through ship, real Codex dispatch evidence per required phase, gates controlled without a web UI, verification and dependencies preserved, and resume from a deliberately failed review with recorded cost and provenance. Gap G5.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
