# COMP-MCP-MIGRATION-1: Design

## Why

COMP-MCP-MIGRATION shipped enforcement.mcpForFeatureMgmt as prompt-only because audit appends are best-effort, the log is global, and build.js has no per-build correlation IDs. Adding correlation lets us detect agents that ignore the prompt and reject those edits at stage time. Tracked since 2026-05-04.

**Status:** DESIGN
**Date:** 2026-05-04

## Related Documents

<!-- Link to roadmap, dependencies, and related features -->

---

## Problem

<!-- Describe the problem this feature solves -->

## Goal

<!-- What does success look like? Scope and non-scope. -->

---

## Decision 1: <Title>

<!-- Describe the decision, options considered, and rationale -->

---

## Files

| File | Action | Purpose |
|------|--------|---------|
| | | |

## Open Questions

<!-- List unresolved questions -->
