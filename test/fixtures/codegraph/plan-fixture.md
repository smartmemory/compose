# Plan fixture for the STRAT-CODEGRAPH-1 reality-check golden

Names below are checked against the recorded bundles in this folder (compose/ and stratum/ts/ display prefixes).

## Tasks
- Reuse `checkOrInsert` from `compose/lib/idempotency.js` and keep `validateIdempotencyKey` (existing).
- The definition sits at `compose/lib/idempotency.js:144`; the engine calls `validateSpec:348`.
- Add `runGsd` (new) and call it from `buildTaskPrompt`.
- Read the active build from `compose/lib/active-build.js`.
- Mark `sanitizeWriterResult` (new) even though it already exists.
- Keep `fooBarMissing` (existing).
- Wire `compose/lib/codegraph/new-thing.js` into the writer.
- Plain words like `complete` and `gate` are prose, not names.

```js
notCounted();
```

## File Plan
| File | Action | Purpose |
|---|---|---|
| `compose/lib/codegraph/new-thing.js` | new | the new module |
| `compose/lib/idempotency.js` | edit | reuse |
