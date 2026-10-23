# Hidden material: `debug` archetype

Never copied into a candidate workspace before the oracle runs (`archetype-contract.json` `rules.hiddenNeverInWorkspace`).
Any change here bumps `version` in `lib/archetypes/debug.js`.

- `fixture.json`: the `{context, task, gold, task_type}` unit; `gold` is the answer key.
- `bug.patch`: unified diff that plants the bug in the notes server (`buildInput` applies it). Oracle version 3 (version 2 with a reworded planted comment, same checks and weights): a two-site defect. Site A: `search` compares the raw query tag. Site B (the real invariant): `update` and `importNotes` store tags with `trimTags` (no lower-casing) while `write` lower-cases, and the seed data carries mixed-case rows.
- `repro.test.js`: the failing repro. `buildInput` writes a copy to the workspace; the oracle runs THIS pristine copy.
- `suite/`: debug-specific hidden tests. The hidden full suite is these plus the notes server's golden suite (`gold.suites`).
  Every hidden test name starts with `[check-id]`; the oracle scores accuracy = checks passed / total over `repro`, `golden`, `search-unchanged`, `tag-filter-written`, `tag-filter-update`, `tag-filter-seeded`, `tag-normalized` and `hygiene` (nothing changed outside `src/` and `test/`). A failing repro gates every other check to 0.
- `../../oracle-fixes/`: canned candidate fixes (`gold.patch`, `site-a-only.patch`) used only by offline oracle tests; never copied into a workspace.
