I fixed it, and the repro now passes. `node --test test/repro.test.js` and `npm test` both show `# pass 1  # fail 0`.

**Cause:** in `src/store.js`, `write()` lowercases tags before saving them, so `'Travel'` is stored as `'travel'`. But `search()` compared the filter exactly as typed (`t.tag = $tag`), so `'Travel'` never matched `'travel'`. There was a second side to it. `update()` and `importNotes()` save tags exactly as given, so the seed data holds `'Travel'`, `'TRAVEL'` and `'travel'` side by side. Only lowercasing the filter would have broken searches on those notes.

**Fix (`src/store.js`, 5 lines added, 1 changed):** the tag filter now ignores case on both sides. The store registers a small SQLite function, `tag_fold`, which trims and lowercases a tag the same way `write()` does, and the filter compares `tag_fold(t.tag) = tag_fold($tag)`. I didn't use SQLite's own `lower()` because it only handles plain A–Z letters. Stored tags are not changed, so recalled notes still show tags as they were saved.

**Checked beyond the repro (one-off script, not saved as a test):**
- With seed data plus a written note, the filters `Travel`, `travel` and ` TRAVEL ` each return all four travel notes.
- A tag that doesn't exist returns nothing.
- Search without a tag still returns all four matches.
- Matching across case works for accented letters too (`Ünïcode` vs `üNÏCODE`).
- `search_notes` called through the MCP `tools/call` handler with `tag: 'travel'` returns results.

The repo has no other tests, so these checks were all the regression coverage available.

Running the repro creates a `.test-log/` folder, which I left untracked.

**ELI5:** Notes saved through the normal path had their tags quietly turned to lowercase, but the search looked for the tag exactly as you typed it, so "Travel" never found "travel". Notes loaded from old exports kept their original capitals, so the search now ignores capitals on both sides. Nothing about stored notes changed.