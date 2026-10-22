`search_notes` now returns a note when the query matches its body, and `node --test test/repro.test.js` passes. I haven't run the server itself.

**Cause:** the `WHERE` clause in `NotesStore.search` (`src/store.js`, around line 84) only checked `n.title LIKE $p`, so body text was never searched.

**Fix:** I added `OR n.body LIKE $p ESCAPE '\\'` to that clause. It uses the same escaped pattern as the title match. The tag filter, limit validation, ordering and `DISTINCT` are unchanged.

My first full `node --test test/` run showed a failure. It ran in parallel with the edit, so it probably ran before the change landed. The re-run of the repro passed. The repro is the only test file in `test/`, so nothing else was exercised.

**ELI5 TLDR:** Search was only looking at note titles and ignoring what was written inside the notes. I made it look at both, and the repro passes.