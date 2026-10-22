# oracle-fixes

Canned candidate fixes for the `debug` archetype, used only by `test/archetype-debug.test.js` to check the oracle offline (no model).
They are applied to the BUGGY `src/store.js` and never enter a candidate workspace.

- `gold.patch`: the full fix (reverses `hidden/debug/bug.patch`). Expected accuracy 1.
- `site-a-only.patch`: normalizes the query tag at search time and nothing else. Expected accuracy strictly between 0.3 and 0.7.

Regenerate when `hidden/debug/bug.patch` or the seed `src/store.js` changes. Delete when the debug archetype is retired.
