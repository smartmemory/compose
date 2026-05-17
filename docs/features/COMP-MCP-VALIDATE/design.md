# COMP-MCP-VALIDATE — Cross-Artifact Validator: Finding-Kind Catalog

`validate_feature(cwd, code)` / `validate_project(cwd, options)` in
`lib/feature-validator.js` cross-check ROADMAP.md rows, vision-state.json
items, feature.json, feature-folder contents, linked artifacts, and
cross-references, returning structured findings:

```
{ severity: 'error' | 'warning' | 'info', kind, feature_code?, detail, source? }
```

The pre-push hook runs `compose validate --scope=project --block-on=error`:
`error` blocks the push; `warning`/`info` print but exit 0.

## Catalog — 32 kinds

The original 27 cross-artifact kinds (status/phase drift, schema violations,
dangling refs, orphan folders, CHANGELOG/journal drift, …) are unchanged.

### COMP-MCP-XREF-VALIDATE (#16) — read-only external-reference kinds (5)

External references are carried two ways and normalized to one `ExternalRef`:
1. **roadmap citation** — an HTML comment in a ROADMAP row description cell:
   `<!-- xref: <provider> <target> [expect=…] [note="…"] -->` (anon rows
   included; scanned independently of the strict-code `roadmapByCode` map).
2. **feature.json link** — a `links[]` entry with `kind:"external"`.

Providers: `github` and `local` are resolvable; `url` plus the reserved
`jira|linear|notion|obsidian` are **url-class** (recorded, never resolved in
v1). Resolution is **read-only** — no issue/file is ever written.

| Kind | Severity | Trigger |
|---|---|---|
| `XREF_DRIFT` | warning | Resolved state contradicts the citation. Explicit `expect=` is authoritative (`expect=open` but issue closed, or vice-versa; local: resolved status ≠ `expect`). Absent `expect=` → derived from the citing row's status, drift only on a *blatant* contradiction (COMPLETE/SUPERSEDED row citing an open issue / still-PLANNED feature; PLANNED/IN_PROGRESS row citing a closed issue). |
| `XREF_TARGET_MISSING` | **error** | GitHub issue 404; local target absent (no feature.json and no ROADMAP row); local repo token not a valid sibling directory. Real drift — blocks pre-push. |
| `XREF_MALFORMED` | warning | A `<!--xref:…-->` comment matched the anchor but failed the grammar (`ParseError` from `lib/xref-citation.js`). |
| `XREF_RESOLUTION_SKIPPED` | warning | Could not resolve and this is **not** real drift: gate off (no `--external`/`COMPOSE_XREF_ONLINE=1`/`xref.prePushOnline`), no GitHub token, offline/fetch-reject, HTTP ≥500, unparseable 2xx body, or rate-limited. **Never `error`, never aborts the run.** |
| `XREF_URL_UNCHECKED` | info | A url-class ref (`url` or reserved `jira|linear|notion|obsidian`). Recorded for visibility; never resolved, never drift, no network. `expect=` on url-class is parsed but ignored. |

## Gating & degrade contract (spec §6)

GitHub network resolution is **off by default**. It turns on only when
`options.external === true` (CLI `compose validate --external`, MCP
`validate_project {external:true}`), `COMPOSE_XREF_ONLINE=1`, or
`.compose/compose.json` `xref.prePushOnline: true`. With the gate off,
`provider:local`, `XREF_MALFORMED`, and `XREF_URL_UNCHECKED` still surface;
`provider:github` refs emit `XREF_RESOLUTION_SKIPPED` with no network call.

Degrade matrix (all map to `XREF_RESOLUTION_SKIPPED` warning except 404):

| Condition | Behavior |
|---|---|
| No token (`TrackerConfigError {detail.missing:'token'}`) | one **aggregate** skip; remaining github refs skipped silently |
| Offline / fetch reject | per-ref skip, continue |
| Rate-limited (`e.rateLimit`) | one **aggregate** skip; remaining github refs short-circuited silently (local/url still resolve) |
| HTTP ≥500 / unparseable 2xx | per-ref skip, continue |
| HTTP 404 | `XREF_TARGET_MISSING` (**error**) — real drift, not a degrade |

Per-ref isolation: one bad ref never poisons siblings; an outer backstop in
`validateProject` guarantees the staleness pass can never abort the run.

`validateProject` is **extended in place** (not forked): `runExternalRefChecks`
runs after the existing project-level checks. `github-api.js` gains exactly
one read-only method, `getIssueResult()` (status-returning sibling of
`getIssue()`, modeled on `getRepo()`); `getIssue()` is untouched.
