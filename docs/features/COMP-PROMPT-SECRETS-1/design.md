# COMP-PROMPT-SECRETS-1: Scan and redact assembled prompt bytes for credentials before any provider dispatch. lib/step-prompt.js concatenates every docs/context/*.md in full into the prompt and ships it to a paid provider; nothing in compose scans or redacts prompt CONTENT (stratum scrubs env vars only, ts/src/connectors/base.ts:16). A credential in any context doc silently leaves the machine. Needs a pre-dispatch scan of the final assembled bytes, redaction with a visible marker, and a loud local failure rather than a silent send. Sized S.

**Status:** PLANNED
**Created:** 2026-09-17

---

## Intent

Scan and redact assembled prompt bytes for credentials before any provider dispatch. lib/step-prompt.js concatenates every docs/context/*.md in full into the prompt and ships it to a paid provider; nothing in compose scans or redacts prompt CONTENT (stratum scrubs env vars only, ts/src/connectors/base.ts:16). A credential in any context doc silently leaves the machine. Needs a pre-dispatch scan of the final assembled bytes, redaction with a visible marker, and a loud local failure rather than a silent send. Sized S.

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._

---

## Related Documents

- `lib/step-prompt.js` — the assembly seam; ambient context is concatenated here
- `lib/local-claude-connector.js` — one dispatch seam
- `stratum/ts/src/connectors/base.ts:16`, `claude.ts:43` — the env-var scrub that already exists, and the reason it is not enough
- `docs/features/COMP-REVIEW-BUDGET-1/` — added a size budget on this same path; budget is not redaction
- `reference_codearbiter` — where the idea came from (AGPLv3 project, ideas only, no code reuse)

## The problem

`lib/step-prompt.js` loads every `.md` under `docs/context/` and concatenates it, in full,
into the assembled prompt (`:18` the loader, `:39` the read, `:120` the injection), which is
then dispatched to a paid provider. Nothing in `lib/`, `server/` or `bin/` scans or redacts
prompt **content**: a repository-wide grep for `redact|scrub` returns exactly one hit, and it
is a comment (`lib/stratum-mcp-client.js:528`).

The only sanitisation that exists anywhere is env-var scrubbing on connector spawn, in Stratum
(`SENSITIVE_ENV_VARS`, `SMARTMEMORY_SCRUB_VARS`). That protects the child process's
environment. It does nothing about bytes the parent deliberately puts into a prompt.

Consequence: a credential pasted into any `docs/context/*.md` — a runbook with a token in a
curl example, a pasted error containing a bearer header, an onboarding note with a connection
string — is transmitted verbatim to Anthropic or OpenAI on the next build, with no warning, no
record, and no way to recall it. Provider retention and training policy then govern it, not us.

This is a silent-egress failure, which is the worst shape: nothing fails, nothing is logged,
and the loss is invisible until it is someone else's incident.

## What COMP-REVIEW-BUDGET-1 did and did not do

`7e637db` measured the assembled prompt after schema injection and enforced
`COMPOSE_REVIEW_PROMPT_MAX_CHARS`, dropping ambient `docs/context` material first when over
budget. That establishes the exact seam this feature needs — the point where the final bytes
exist and are already being inspected — but it inspects **length only**. A small prompt with a
key in it passes the budget check and ships.

## Proposed shape

1. **Scan the final assembled bytes**, at the same seam the budget check uses, not the source
   files. Interpolation, fanout item serialization and schema injection all add content after
   the context files are read, so scanning inputs alone would miss it.
2. **Detect, then redact with a visible marker** (`[REDACTED:<rule>]`) rather than silently
   dropping, so the model sees that something was removed and the operator can find it.
3. **Fail loudly and locally on anything ambiguous.** Consistent with the budget precedent:
   failing before the dispatch is cheap, a wrong send is not recoverable.
4. **Record the detection**, not the secret. The audit trail should say a rule fired, in which
   file, at which build step. It must never quote the matched bytes.
5. **Configurable ruleset with a conservative default.** High-confidence provider key shapes
   and obvious credential syntax first. This must not become a general DLP engine.

## Grounding: question 1 is ANSWERED (2026-09-19)

**There is no single choke point. `lib/step-prompt.js` is one of roughly 30 paths, and it does
not even fully cover the ones it touches.** A read-only call-graph sweep (Codex `gpt-5.6-sol/high`,
run `8aab975267e0`) inventoried every path by which Compose-assembled bytes reach a provider.
Three of its load-bearing claims were independently re-verified before acceptance:

1. **The existing prompt budget covers far less than assumed.** `promptBudget` is passed only on
   consumer review items (`lib/build.js:1923-1928`, gated on `reviewOpts.reviewMode`). Ordinary
   review steps (`lib/build.js:5350-5372`) pass none. Confirmed by direct read.
2. **There are three separate direct Claude CLI spawns**, each building its own prompt with no
   shared helper: `server/agent-spawn.js`, `server/summarizer.js`, `server/vision-utils.js:116`.
   Confirmed: three independent `child_process.spawn` sites.
3. **Codex's scrub list omits `OPENAI_API_KEY` by design** (`stratum/ts/src/connectors/codex.ts:66`)
   — correct, since Codex needs it, but it means the scrub lists are provider-specific and cannot
   be reasoned about as one policy.

### What this changes

The feature as filed assumed a seam that does not exist. `lib/step-prompt.js` only feeds the
ordinary step path, and even there the bytes it produces are added to afterwards: JSON schema
injection happens downstream (`lib/result-normalizer.js:399-418`, `lib/inject-schema.js:11-20`),
so a scanner placed at prompt assembly misses schema-derived and interpolated content.

Compose is also not the only owner. The final provider-specific bytes for most dispatches are
assembled in **Stratum**, after Compose has handed off: `stratum/ts/src/connectors/claude.ts:131-137`,
and for Codex after a sandbox preamble is prepended at `stratum/ts/src/connectors/codex.ts:263-281`.
Stratum-native fanout appends contract and prior-failure text at `engine.ts:3672-3688`. Two further
sibling services (Maya, SmartMemory) receive Compose-originated content and dispatch it themselves.

### The hard limit, which must be stated in the feature's own claim

**Tool-result turns cannot be covered from these repositories.** On any agentic path, the SDK or
CLI transmits later turns itself; Compose and Stratum observe tool events only after the query has
begun (`stratum/ts/src/connectors/claude.ts:137-173`, `server/agent-hooks.js:45-62`). There is no
pre-send boundary in our source for those bytes.

So this feature must claim **initial-prompt scanning**, never "every provider-bound byte". Claiming
the latter would be the exact false-confidence failure the feature was filed to avoid.

### Revised shape: a seam set, not a seam

Compose-owned seams: `lib/result-normalizer.js:399-442` (after schema injection, where the budget
already runs), `server/agent-workspace.js:201-202` (HTTP-body prompts, which never touch
`step-prompt.js`), the three CLI argv sites above, the Maya/SmartMemory HTTP bodies, and MCP result
serialization at `server/compose-mcp.js:207-243`.

Stratum-owned seams: the two connector send points and the direct OpenAI judge
(`stratum/ts/src/judge/judged.ts:78-89`).

That answers question 4 below as well: **both repos**, with a split by who holds the final bytes.
It likely wants a shared scanner module with two call sites rather than one feature in one repo,
and a companion `STRAT-*` row for the Stratum half.

Full inventory in the run stream: `~/.stratum/ts/agent_runs/8aab975267e0/stream.jsonl`.

## Open questions for the design phase

1. ~~Where exactly is the choke point?~~ **ANSWERED above: there isn't one.** Superseded by
   the seam-set question: which seams ship in v1, and does the Stratum half block the Compose half?
2. **Redact or refuse?** Redaction keeps the build moving and risks a mangled prompt; refusal is
   safer and noisier. The budget path chose refusal for the unfixable case and silent-with-
   warning degradation for the fixable one. The same split may apply here.
3. **False positives on legitimate content.** Compose builds tools that handle credentials, so
   a design doc may legitimately discuss key formats. Need an explicit allowlist mechanism that
   is per-repository and reviewable, not a `# noqa`-style inline escape an agent can add itself.
4. **Does this belong in Compose or Stratum?** Stratum owns connector spawn and already owns
   env scrubbing, so a scan there would cover every Stratum consumer, not just Compose. Compose
   owns prompt assembly and therefore the context. Deciding this wrong means building it twice.
5. **Retroactive exposure.** If a secret has already shipped, this feature does not un-ship it.
   Is a one-off scan of existing `docs/context/` in scope, or a separate operational task?

## Explicit non-goals

- Not a general DLP or compliance product. High-confidence credential shapes only.
- Not repository-wide secret scanning; this is about bytes leaving for a provider, and `git`
  pre-commit hooks are the right control for bytes entering the repo.
- Not a replacement for the env-var scrub in the Stratum connectors, which stays as-is.
- No change to prompt budgeting, review semantics, or provider failure classification.

## Origin

Filed 2026-09-17 after a teardown of `arbiterForge/codeArbiter`, whose `/ca:preview` performs a
read-only secret scan before work starts and whose opt-in network feature sends "byte-capped,
secret-redacted task context". That project is AGPLv3 with commercial rights reserved: it is an
idea source only. No code, spec text or prompt wording may be copied from it.
