The repro now passes. `node --test` reports 1 pass and 0 failures, but the repro is the only test there, so nothing else was exercised.

**Cause:** `write()` lowercases tags before storing them, so `Travel` is saved as `travel`. `search()` compared the filter against the stored tag exactly, so `Travel` never matched `travel`. Tags saved through `update()` and `importNotes()` keep their original case, so stored tags could be a mix of cases.

**Fix:** I changed the tag join in `src/store.js` `search()` to `t.tag = $tag COLLATE NOCASE`. The tag filter now ignores case, whichever way the note was saved. Stored tags and the other code paths are unchanged, and I didn't touch the repro.

One side effect is that a filter of `travel` now also matches the seed notes tagged `Travel` and `TRAVEL`, which seems to be what you'd want.

**ELI5 TLDR:** The notes server lowercased tags when saving, but the tag search compared them exactly. A note saved as `Travel` was stored as `travel`, so searching `Travel` missed it. Tag search now ignores capitalization, so it finds the note.