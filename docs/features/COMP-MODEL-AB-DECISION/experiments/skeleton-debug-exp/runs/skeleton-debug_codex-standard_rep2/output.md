I’ll inspect the search code, then run the repro.
The repro fails. `src/store.js:84` only searches titles. I’ll add body matching with the same escaping and check filters and ordering.
Fixed `src/store.js:85` to search both title and body using the same escaped query.

- Added regression coverage in `test/search.test.js:6` for filtering, ordering, limits, case-insensitivity, literal wildcard matching, and MCP responses.
- Added `CHANGELOG.md:1`.
- Left `test/repro.test.js` unchanged.

Validation: the requested repro passes, `npm test` passes all 3 tests, and `git diff --check` passes.