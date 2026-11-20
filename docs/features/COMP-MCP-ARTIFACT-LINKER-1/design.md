# COMP-MCP-ARTIFACT-LINKER-1

**Status** COMPLETE · **Date** 2026-11-20

[Roadmap](../../../ROADMAP.md#phase-7-mcp-writers--complete) · [Changelog](../../../CHANGELOG.md#unreleased)

## Problem

`link_artifact` advertised four types outside the [feature schema](../../../contracts/feature-json.schema.json) and accepted them on write. A `finding` linked to COMP-MODEL-ROUTE-1 failed the pre-push schema check and was relabeled `report` in `8f5e33f`.

## Goal and decision

Every advertised type must pass schema validation. A scan of 388 current feature records found zero uses of the four extra types, so the schema enum stays as written. The [tool definition](../../../server/mcp-tool-defs.js) and [writer](../../../lib/feature-writer.js) use that enum. The writer returns `ARTIFACT_TYPE_INVALID` with the allowed values before writing, and continues to require a valid ledger line for `incident`.
