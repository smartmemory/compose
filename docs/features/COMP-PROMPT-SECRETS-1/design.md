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

## Open questions for the design phase

1. **Where exactly is the choke point?** Is `lib/step-prompt.js` the single seam through which
   every provider-bound byte passes, or do the fanout, review and routing paths assemble
   prompts elsewhere? If there is more than one, this must be enforced at the connector
   boundary instead, or it is a partial control. **Answer this before designing anything else**
   — a scanner on one of three paths is worse than none, because it manufactures confidence.
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
