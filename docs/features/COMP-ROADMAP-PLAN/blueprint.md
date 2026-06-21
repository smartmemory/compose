# COMP-ROADMAP-PLAN — Implementation Blueprint

**Status:** BLUEPRINT (Phases 4-5 — implementation plan + verification, not shipped code)
**Date:** 2026-06-21
**Feature:** COMP-ROADMAP-PLAN · complexity XL

## Related Documents

- Design: `docs/features/COMP-ROADMAP-PLAN/design.md` (Approach C, the two resolved open questions).
- Epic anchor: `docs/plans/2026-06-21-roadmap-planning-model-design.md`.
- Keystone: `docs/features/COMP-ROADMAP-MODES/` (the mode registry this extends).

## Approach recap (what we are building)

A real `compose plan "<intent>"` lifecycle, mode=`plan`, reusing the shipped seed graph `explore_design → plan → ship` (`lib/lifecycle-modes.js:117-138`). It produces build-ready `docs/features/<code>/{feature.json, design.md}` that `compose build <code>` consumes. The plan *session* is a non-`feature.json`-backed vision item (`tracksFeatureJson:false`); the produced features are separate PLANNED `feature.json`s.

## Corrections table (spec/design assumption vs verified reality)

| # | Assumption | Reality (file:line) | Consequence |
|---|---|---|---|
| C1 | `mode='plan'` needs wiring in runBuild | **Already wired** — `lib/build.js:640` derives `'plan'`; `cfg=getMode(mode).runner` `:642`; `resolveItemDir` honors `docs/plans` `:672-674`; `tracksFeatureJson:false` already skips IN_PROGRESS/COMPLETE writes (`:896,:1091,:2144-2189`) | No runBuild core change for mode plumbing; only the gaps below |
| C2 | Point `compose plan` at `new.stratum.yaml` | `new` step IDs (`research/brainstorm/roadmap/scaffold`) ≠ phaseOrder; phase tracking keys off `stepId` (`build.js:1200`) | **Must author new `pipelines/plan.stratum.yaml`** with step IDs `explore_design/plan/ship` |
| C3 | Plan flow inputs are `featureCode/description` | `planInputs:'plan'` envelope is `{projectName, intent}` (`build.js:4654-4658`) | plan.stratum.yaml declares `projectName`/`intent`; steps interpolate `$.input.projectName`/`$.input.intent` |
| C4 | `descriptionLoader:'plan'` routes the description | Dead config — switch only branches `'bug'` (`build.js:850-852`); plan falls through to `loadFeatureDescription` (one line) | `compose plan` **must always pass `opts.description`** (the CLI intent) so the loader never runs |
| C5 | Stamp `lifecycle.mode='plan'` is a read-side confirm | REST `_restEnsureFeatureItem` POSTs `type:'feature'` (`vision-writer.js:185`); `/lifecycle/start` derives `mode=typeToMode(item.type)`→`build` (`vision-routes.js:226,265`); body is only `{featureCode}` | REST path **misclassifies plan as build**; direct path (`_directEnsureFeatureItem:294`) already correct |
| C6 | Gate projection inside `projectFeatureStatus` | Helper signature carries no `mode` (`lifecycle-guard.js:162`); writes feature.json by code | **Gate at the 5 call sites** on `cfg.tracksFeatureJson` (start `:289`, advance `:361`, **skip `:401`**, kill `:445`, complete no-SHA `:565`) |
| C7 | Second write via `writeFeature` | `writeFeature` is local-only (`feature-json.js:68`); `persistFeatureRaw` is **replace-not-merge** at provider (`local-provider.js:77`, `github-provider.js:152`) and does **not** regen ROADMAP | **Extend `addRoadmapEntry` whitelist** (`feature-writer.js:124-138`) → one provider-backed write that regens ROADMAP |
| C8 | `profile` makes triage a no-op | Needs `profile` **and** `triageTimestamp` (`isTriageStale` `triage.js:255,269`); folder-file mtime > stamp re-triages | spec step writes `design.md` first, stamps `triageTimestamp` **last** |
| C9 | `compose new` is re-pointed in one line | `new` dispatches to `runNew`/`lib/new.js` (separate runner, full dispatch loop) | "Absorb" = thin alias delegating to the plan path; retire `lib/new.js`/`new.stratum.yaml` as a defined sub-unit |
| C10 | effort→complexity is clean | ideabox `effort` is `S|M|L` (no `XL`, `ideabox.js:249`); `impact` is `low|medium|high` — same vocab the **stale** complexity JSDoc wrongly claims (`feature-json.js:33`) | carry is lossy-upward-only; never name an impact field `complexity` |
| C11 | Pipeline `ensure` covers plan's evidence checks | REST `advance` runs `guardedTransition`→`ensureGuard`→`edgePredicates(_featureRelDir(...), mode)`; `_featureRelDir` hardcodes `docs/features` (`lifecycle-guard.js:246-250`) even though `edgePredicates`/`edgeEvidenceOf` are already mode-aware (`:99,:108`) | plan's `explore_design→plan` evidence looks in `docs/features/<code>`, not `docs/plans/<code>` → **guard fails** unless `_featureRelDir` is made mode-aware (**S7**) |
| C12 | Plan can reuse phase id `ship` freely | `runBuild` intercepts `stepId === 'ship'` and runs `executeShipStep` (git commit/audit path) (`build.js:1206-1207`, `:2488`) | plan's `ship` would try to stage+commit, not hand off → **gate the interception on mode** (**S8**) |
| C13 | `mode` on item-create persists | `store.createItem` has no `mode` field (`server/vision-store.js:150`) — an arbitrary `mode` on `/api/vision/items` is dropped | mode MUST travel on the `/lifecycle/start` body, not item-create (**S2**) |
| C14 | `triageTimestamp >= mtime(design.md)` suffices | `isTriageStale` scans **every** folder file incl. `feature.json` itself (`triage.js:263`); the just-written `feature.json` mtime ≥ stamp → can self-stale | exclude `feature.json` from the scan, or accept graceful degradation (triage re-runs) (**S4**) |

## Work units (ordered slices)

### S1 — `plan` mode is runnable end-to-end (the spine)
- **`pipelines/plan.stratum.yaml`** (new). `version:"0.3"`; `workflow.name: plan`; `flows.plan` with `input: {projectName, intent}`; top-level step IDs **`explore_design` / `plan` / `ship`** (mirror `build.stratum.yaml:243-259` step shape: `id/agent/intent/inputs/output_contract/ensure/retries`, with gate steps as separate `function: gate` entries). Steps interpolate `$.input.projectName`/`$.input.intent`. Gates drive off `ensure: file_exists(...)` against `docs/plans/<code>/` paths (the `new.stratum.yaml:69,103,144,179` model), **not** server assess (server ArtifactManager is features-rooted).
  - `explore_design` step: frame + research + ideate prompts (absorb `new.stratum.yaml:54-111`), routes ideation to the ideabox; writes `docs/plans/<code>/design.md`.
  - `plan` step: converge + estimate + **spec** (see S4); writes `docs/plans/<code>/plan.md` and the per-feature `docs/features/<code>/{feature.json, design.md}`.
  - `ship` step: verify each produced feature is build-ready (handoff summary).
- **`lib/lifecycle-modes.js:136`** — flip `defaultTemplate: 'new'` → `'plan'` (data; belt-and-suspenders since the verb passes `template:'plan'`).
- **`bin/compose.js:568`** — add `'plan.stratum.yaml'` to `runInit`'s scaffold copy list (today only `build/build-quick/new`), which copies from the **package `pipelines/` source dir** (`:568,:571`). Add the source `pipelines/plan.stratum.yaml` to the package so `runInit` seeds it into the project's `pipelines/`, where `resolveTemplatePath` resolves it (project path first, `build.js:593-599`). Note `resolveTemplatePath`'s *bundled* fallback is `presets/<name>.stratum.yaml`, **not** package `pipelines/` — so for a no-init invocation either rely on `runInit` seeding (the chosen mechanism) or also drop a copy under `presets/`. Pick one; do not assume `resolveTemplatePath` reads package `pipelines/`.
- **`bin/compose.js`** — new `} else if (cmd === 'plan')` verb in the dispatch chain near `fix` (`:2120`). Mirror the fix block: parse `--cwd`/positional intent/`--abort`/`--resume`; auto-`runInit` checking `pipelines/plan.stratum.yaml`; then `runBuild(planCode, { template:'plan', mode:'plan', description:intent })`. Intent comes from the CLI arg (like `compose new :841`), so **always set `opts.description`** (satisfies C4). A `--resume` needs the cross-mode guard (`active.mode !== 'plan'` → refuse), mirroring `bin/compose.js:2213-2216`.
- **planCode derivation (required — `runBuild` uses it as the folder key, lifecycle featureCode, and resume key, `build.js:699,857,4661`).** `compose plan "<intent>"` derives a deterministic **`PLAN-<slug>`** code (slugified from the intent, dedup-suffixed if the `docs/plans/<code>/` folder exists), mirroring ideabox promote's `IDEA-<num>-<slug>` derivation (`bin/compose.js:2626`). Accept an explicit `compose plan <CODE> "<intent>"` form to override. Without this, `docs/plans/<slug>/`, item matching, and `--resume` are undefined.

### S2 — plan session item carries mode=plan through REST
- **`lib/vision-writer.js:168-197`** (`_restEnsureFeatureItem`) — forward `mode` on the **`lifecycle/start` POST body, at BOTH call sites**: the existing-item repair path (`:175`) and the post-create path (`:192`). Patching only one leaves pre-existing (e.g. UI-created) plan items starting as build. Forward it on the start body, **not** the item-create body — `store.createItem` drops unknown fields (no `mode` param, `server/vision-store.js:150`), so item-create can't carry it (C13). (Direct path `:257-302` already stamps `resolveMode(mode)` at `:294` — no change.)
- **`server/vision-routes.js:265`** — prefer an explicit `req.body.mode` from the start payload over `typeToMode(item.type)` when deriving `const mode`. `typeToMode` (`:226`) stays as the fallback for non-plan items.

### S3 — projection skipped for `tracksFeatureJson:false`
- **`server/vision-routes.js`** — at each of the 5 `projectFeatureStatus` call sites (`:289,:361,:401,:445,:565`) wrap in `if (getMode(modeOf(item)).runner.tracksFeatureJson)` (or local `mode` at start `:265`). `modeOf(item)` is already in scope at advance/skip/kill/complete; `getMode` from `lib/lifecycle-modes.js`. Mirrors the existing `cfg.tracksFeatureJson` gate at `lib/build.js:896`.

### S4 — build-ready `feature.json` write (the handshake producer)
- **`lib/feature-writer.js:124-138`** — extend the `addRoadmapEntry` field whitelist to accept `profile`, `triageTimestamp`, `plannedBy`, `impact` (carried onto the persisted object). This keeps the write **provider-backed** (`createFeature` `:151`) and regenerates ROADMAP in one call. (Alternative if whitelist extension is rejected: `addRoadmapEntry` then read-modify-write `provider.persistFeatureRaw(code, {...existing, ...extra})` — must spread existing per C7.)
- The plan `spec` step (in `plan.stratum.yaml`, S1) calls this per chosen feature with `status:'PLANNED'`, `complexity` (S|M|L|XL), `profile`, `triageTimestamp` (stamped after `design.md` write — C8), `plannedBy:'<plan-slug>'`, and writes `docs/features/<code>/design.md`.
- **`lib/triage.js:242-277`** (`isTriageStale`) — exclude `feature.json` from the folder mtime scan (`:263`). Including it is circular: the timestamp it compares against *lives in* `feature.json`, so the just-written file's own mtime can self-invalidate the cache (C14). This is a correct, small fix that also helps normal triage; verify the normal-triage golden path still skips correctly after the change. **Graceful degradation:** if this fix is descoped, the only cost is triage re-running on a plan-produced feature (idempotent, not fatal) — so the handshake still works, just without the no-op optimization.

### S5 — `build` ratifies a plan-authored design (no clobber)
- **`lib/build.js:799-837`** (the in-memory `specYaml` mutation seam — `specYaml` read at `:799`, mutations applied `:805-837`). **The plannedBy-ratify mutation must NOT be nested inside the existing `if (buildProfile || vocabOn)` block (`:811`)** — that block is bypassed on `--skip-triage` / explicit-template builds. Instead: (a) load `feature.json` early (independent of the triage block) to read `plannedBy`; (b) apply the ratify mutation whenever `plannedBy` is set, refactoring so the `specObj` is parsed/stringified once and all mutation reasons (triage `skip_if`, vocab, ratify) share it. The mutation rewrites the `explore_design` step `intent` to "a plan-approved design exists at design.md; **read it fully and ratify** (refine only if needed), do not rewrite from scratch." The agent reads `design.md` via its own tools (no new `readFileSync`; avoids the static-prompt/`loadFeatureDescription`-one-line trap, C4). Tamper-hash compares against the original on-disk file (`:802`) so in-memory mutation is integrity-safe.

### S6 — complexity enum doc fix (in blast radius)
- **`lib/feature-json.js:33`** — correct the JSDoc from `low | medium | high` to `S | M | L | XL` (matches the enforced `COMPLEXITIES` set, `feature-writer.js:60`).

### S7 — guard evidence path is mode-aware (so plan transitions pass under the guard)
- **`server/lifecycle-guard.js:246-252`** (`_featureRelDir`) — make it mode-aware **without regressing build**. Build's `artifactRoot` is the *token* `'features'`, and `_featureRelDir` deliberately reads `.compose/compose.json` `paths.features` for project overrides (`:249-250`). So mirror `resolveItemDir`'s exact branch (`build.js:670-674`): **when `getMode(mode).runner.artifactRoot === 'features'`, keep the existing config-backed `paths.features` resolution** (build unchanged); **only for the literal roots (`docs/bugs`/`docs/plans`) use `${artifactRoot}/${featureCode}`**. `edgePredicates` (`:99`) and `ensureGuard` (`:280`) already thread `mode` and use `edgeEvidenceOf(mode)` (`:108`) — only `_featureRelDir` is blind to mode. Thread `mode` into `_featureRelDir` at the `ensureGuard` call site (`:289`). After this, plan's `explore_design→plan` evidence resolves `docs/plans/<code>/design.md` while build still honors `paths.features` (C11). This is the *guard-side* slice of the deferred "server-side mode-owned root resolution" — un-deferred because the guard blocks `advance` without it. (The `ArtifactManager` assess path stays features-rooted and deferred; plan doesn't depend on it — gates also have pipeline `ensure`.)

### S8 — plan's `ship` phase hands off, not commits
- **`lib/build.js:1206-1207`** — the `if (stepId === 'ship')` interception runs `executeShipStep` (git stage/commit/audit, `:2488`), which is build/fix-specific. Gate it on **`mode !== 'plan'`** (or an explicit build/bug allowlist). **Do NOT gate on `cfg.tracksFeatureJson`** — fix mode is `tracksFeatureJson:false` (`lifecycle-modes.js`) yet bug-fix *depends* on the `ship` interception, so that predicate would break bug-mode ship. For `plan`, `ship` executes as a normal agent step (the handoff/verify in `plan.stratum.yaml`). (If plan's deliverables should be committed, that is a plan-specific commit in the `ship` step's own agent intent, not `executeShipStep`.)

## Boundary Map

| Symbol | Kind | Slice | Disposition | Producer → Consumer |
|---|---|---|---|---|
| `LIFECYCLE_MODES.plan.runner.defaultTemplate` | const | S1 | modify (`'new'`→`'plan'`) | from S1 → consumed by `runBuild` template resolution (`build.js:794`) |
| `runBuild` | function | S1 | untouched (exists, `lib/build.js:626`) | consumes `mode:'plan'` (already wired, C1) |
| `resolveMode` | function | S2 | untouched (exists, `lib/lifecycle-modes.js:147`) | consumed by `_directEnsureFeatureItem` + `getMode` |
| `getMode` | function | S3 | untouched (exists, `lib/lifecycle-modes.js:155`) | consumed at S3 projection gate |
| `_restEnsureFeatureItem` | function | S2 | modify (forward `mode`, `vision-writer.js:168`) | from S2 → REST item-create/start payload |
| `typeToMode` | const | S2 | untouched (stays the fallback, `vision-routes.js:226`); the edit is the start handler's mode-derivation at `:265` | consumed by start handler `:265` |
| `projectFeatureStatus` | function | S3 | untouched signature (exists, `lifecycle-guard.js:162`) | call-site-gated by S3 |
| `addRoadmapEntry` | function | S4 | modify (extend whitelist, `feature-writer.js:99`) | from S4 → provider `createFeature` → `feature.json` + ROADMAP |
| `persistFeatureRaw` | provider method | S4 | untouched (iface `lib/tracker/provider.js:25`; impls `local-provider.js:76`, `github-provider.js:149`; fallback path only) | replace-not-merge; consumes pre-spread object |
| `loadFeatureDescription` | function | S5 | untouched (exists, `build.js:4823`; bypassed for plan via C4) | n/a for plan path |
| `isTriageStale` | function | S4 | modify (exclude `feature.json` from scan, `lib/triage.js:242`) | consumed by `runBuild` triage-skip (`build.js:753`) |
| `_featureRelDir` | function | S7 | modify (mode-aware; keep config path when `artifactRoot==='features'`, `lib/lifecycle-guard.js:246`) | from S7 → `edgePredicates` → guard evidence |
| `edgePredicates` | function | S7 | untouched (already mode-aware, `lifecycle-guard.js:99`) | consumes `_featureRelDir(mode)` + `edgeEvidenceOf(mode)` |
| `ensureGuard` | function | S7 | modify (pass `mode` into `_featureRelDir`, `lifecycle-guard.js:280,289`) | from S7 → guarded transitions |
| `executeShipStep` | function | S8 | untouched (exists, `build.js:2488`; gated by S8 on `mode !== 'plan'`) | called for build/bug (incl. fix's `tracksFeatureJson:false`), NOT plan |
| `createItem` | function | S2 | untouched (exists, `server/vision-store.js:150`; mode not a field) | mode bypasses it, travels on `/lifecycle/start` |

Invariants (prose, not Boundary Map rows): plan.stratum.yaml flow input is `{projectName,intent}` (not `featureCode/description`); plan-session feature-status projection is suppressed; produced features stay `PLANNED`; `triageTimestamp >= mtime(design.md)`.

## Verification table (Phase 5 — every anchor checked against disk)

| Claim | Anchor | Verified |
|---|---|---|
| plan runner + `defaultTemplate:'new'` | `lib/lifecycle-modes.js:117-138`, `:136` | ☑ verified |
| mode='plan' derived; cfg; resolveItemDir docs/plans | `lib/build.js:640,642,672-674` | ☑ verified |
| tracksFeatureJson gates skip feature.json writes | `lib/build.js:896,1091,2144-2189` | ☑ verified |
| descriptionLoader switch only branches 'bug' | `lib/build.js:850-852` | ☑ verified |
| planInputs plan envelope `{projectName,intent}` | `lib/build.js:4654-4658` | ☑ verified |
| fix verb dispatch template | `bin/compose.js:2120-2231` | ☑ verified |
| typeToMode bug-only; start derives mode at :265 | `server/vision-routes.js:226,265` | ☑ verified |
| 5 projectFeatureStatus call sites | `server/vision-routes.js:289,361,401,445,565` | ☑ verified |
| _directEnsureFeatureItem stamps resolveMode(mode) | `lib/vision-writer.js:294` | ☑ verified |
| addRoadmapEntry whitelist (no profile/triageTimestamp) | `lib/feature-writer.js:124-138` | ☑ verified |
| persistFeatureRaw replace-not-merge; no renderRoadmap | `lib/tracker/local-provider.js:77`, `github-provider.js:149-163` | ☑ verified |
| isTriageStale needs triageTimestamp + mtime check | `lib/triage.js:242-277` | ☑ verified |
| explore_design static intent; specYaml mutation seam | `pipelines/build.stratum.yaml:244-259`, `lib/build.js:799-837` | ☑ verified |
| complexity enum mismatch | `lib/feature-writer.js:60` vs `lib/feature-json.js:33` | ☑ verified |
| guard: edgePredicates/ensureGuard mode-aware; `_featureRelDir` hardcodes docs/features | `server/lifecycle-guard.js:99,108,246-250,280,289` | ☑ verified |
| ship interception → executeShipStep | `lib/build.js:1206-1207,2488` | ☑ verified |
| mutation block gated by `buildProfile \|\| vocabOn` | `lib/build.js:811` | ☑ verified |
| createItem has no `mode` field | `server/vision-store.js:150` | ☑ verified |
| runInit copy list (build/build-quick/new only) | `bin/compose.js:568` | ☑ verified |

## Risks / constraints

- **mtime ordering (C8):** the spec step must write `design.md`, then stamp `triageTimestamp` at/after that write, else build re-triages. Verify whether `isTriageStale` includes `feature.json` itself in the folder scan (if so, tolerance/ordering needs care).
- **persistFeatureRaw clobber (C7):** if the whitelist-extension route is not taken, the fallback must read-then-spread or it wipes `addRoadmapEntry`'s fields.
- **Static step prompt (S5):** Stratum step `intent` cannot branch on input; the `specYaml` mutation route is the only in-codebase mechanism.
- **`compose new` absorption (C9):** thin-alias delegation is the v1 plan; the questionnaire/`--from-idea` enrichment of `compose new` is preserved-or-deferred at Phase 6.

## Deferred (kept out of v1 to stay narrow-but-real)

- Estimation **carry-through from the ideabox** (effort/impact → feature.json on promote, `bin/compose.js:2637`, `ideabox-routes.js:189`) — v1's spec step sets `complexity` from the converge/estimate step itself; the promote-path carry is a follow-up.
- First-class `idea/decision/question/thread` vision items + connection graph.
- The structural `build-from-plan` skip-to-blueprint template (natural ratify handoff ships v1).
- Server-side **ArtifactManager** mode-owned root resolution (the *assess/scaffold* path). The *guard* path is now in-scope (S7) because it blocks `advance`; the ArtifactManager assess path is not on plan's critical path (gates also have pipeline `ensure`), so it stays deferred.
