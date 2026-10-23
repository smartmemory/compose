I’ll inspect the tag flow, then run the repro unchanged.
`write` lowercases tags, but search compares case-sensitively (`src/store.js:40`, `src/store.js:125`). I’ll fix the comparison while preserving stored tags.
Fixed in `src/store.js:125` by adding `COLLATE NOCASE` to tag comparison. `Travel` now matches stored `travel` without altering stored tags.

- Left `test/repro.test.js` unchanged.
- Added regression coverage in `test/store.test.js:1` and updated `CHANGELOG.md:1`.
- Verified `node --test test/repro.test.js` passes.
- Verified `npm test`: all 4 tests pass.
- `git diff --check` passes.