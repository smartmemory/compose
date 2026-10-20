# Hidden material: `debug` archetype

Never copied into a candidate workspace before the oracle runs (`archetype-contract.json` `rules.hiddenNeverInWorkspace`).
Any change here bumps `version` in `lib/archetypes/debug.js`.

- `fixture.json`: the `{context, task, gold, task_type}` unit; `gold` is the answer key.
- `bug.patch`: unified diff that plants the bug in the notes server (`buildInput` applies it).
- `repro.test.js`: the failing repro. `buildInput` writes a copy to the workspace; the oracle runs THIS pristine copy.
- `suite/`: debug-specific hidden tests. The hidden full suite is these plus the notes server's golden suite (`gold.suites`).
