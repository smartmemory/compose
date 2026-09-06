# Version Sync (compose, compose-mcp, stratum)

Three packages ship from this monorepo. Two constraints bind their versions, and
both are enforced by `test/version-sync.test.js` — not by anyone remembering this file.

## The constraints

1. **`@smartmemory/compose-mcp` carries the SAME version as `@smartmemory/compose`,
   exactly**, and depends on `^<that version>`.
2. **`@smartmemory/compose` and `@smartmemory/stratum` share the same MINOR.**
   Patches move independently: compose `0.4.0` with stratum `0.4.5` is correct;
   compose `0.4.0` with stratum `0.5.1` is not.

So a release train looks like `compose 0.4.0` + `compose-mcp 0.4.0` + `stratum 0.4.x`.

## Why

**compose-mcp is a four-file shim** whose only job is to resolve
`@smartmemory/compose/mcp` and spawn it. It has no independent feature surface, so
an independent version number carries no information — it only creates the question
"which compose does this wrapper front?", which a shared number answers on sight.
Measured cost of the old scheme: the wrapper sat pinned to `^0.1.5-beta` for nine
compose releases without anyone noticing, because nothing tied the two together.

**Compose and stratum are one product split across two repos.** Compose calls
stratum's MCP surface directly, and a surface change lands as a stratum minor. A
shared minor makes "does this compose work with that stratum?" answerable from the
version alone, rather than by reading a compatibility matrix nobody maintains.

## How to apply

- **Bumping compose's minor obliges a stratum minor** at or before the same release,
  and vice versa. If only one side has real changes, the other still moves — a
  no-change minor bump is cheaper than a compatibility question.
- **Never bump compose-mcp by itself.** It moves when compose moves, or not at all.
- Update all four sites in one commit: `package.json`, `compose-mcp/package.json`
  (version *and* the compose dep), `compose-mcp/server.json` (top-level version *and*
  `packages[0].version`).
- `npm run test` fails on any violation, so a mismatched bump cannot reach a tag.

## What this rule does NOT say

It says nothing about *when* to bump, only that the three move together. Choosing
patch vs minor is still a judgement call about the change.

## Origin

Owner directive 2026-09-06, at the compose `0.4.0` release. Prompted by discovering
`compose-mcp` had shipped its first-ever npm release depending on `^0.1.5-beta` while
compose was at `0.3.8`, and by compose `0.3.x` / stratum `0.4.x` drifting apart with
no stated relationship between them.
