I’ll inspect the tag handling, then run the repro.
Writes lowercase tags, but searches compare case-sensitively (`src/store.js:40`, `src/store.js:127`). I’ll fix the comparison without changing stored tags, including imported and updated tags.
Fixed in `src/store.js:125`: tag filtering now uses SQLite `COLLATE NOCASE`, so `Travel` matches stored `travel` while preserving imported and updated tag values.

- Left `test/repro.test.js` unchanged.
- Added regression coverage in `test/store.test.js:1` for write/update/import paths, ordering, limits, duplicate matches, and literal search.
- Updated `CHANGELOG.md:1`.

Verified: the exact repro command passes, `npm test` passes all 3 tests, and `git diff --check` is clean.