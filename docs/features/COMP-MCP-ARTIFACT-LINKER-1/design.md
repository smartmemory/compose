# <Feature Name>: Design


## Why

Contract mismatch between the MCP tool and the persisted schema. `server/mcp-tool-defs.js:440` describes `artifact_type` as e.g. "journal", "snapshot", "finding", "report-supplement", "link", "external", but `contracts/feature-json.schema.json:82` constrains `artifacts[].type` to `design|prd|architecture|blueprint|plan|report|journal|snapshot`. The tool accepts and writes the non-enum values, so the write succeeds and the failure surfaces later in the pre-push gate: `test/feature-json-schema-external.test.js:141` failed against the real `COMP-MODEL-ROUTE-1/feature.json` after a `finding` artifact was linked (2026-09-15). Workaround applied in compose `8f5e33f`: relabel to `report`. Fix options: (a) validate `artifact_type` against the schema enum at the tool boundary and correct the description, or (b) extend the schema enum to the advertised set. Either way the two must be generated from or tested against one source. Complexity S.

**Status:** DESIGN
**Date:** <date>

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
