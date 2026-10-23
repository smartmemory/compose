The repro now passes: `node --test` reports 1 pass, 0 fail.

**Cause:** `write()` lowercases tags before storing them. `update()` and `importNotes()` keep the tag's case as given, and so do the seed rows. The tag filter in `search()` compared the filter against the stored tag exactly, so `'Travel'` never matched `'travel'` (what `write` stores).

**Fix:** in `src/store.js`, the tag join in `search()` now compares case-insensitively (`COLLATE NOCASE`) and trims the filter. I chose this over lowercasing at write time because tags that were stored through `update` or import still match, and the tags you get back keep their stored case.

`node --test` found only the repro, so nothing else was exercised. The change is only in the `search()` tag filter, so other server behaviour should be unaffected.

**ELI5 TLDR:** Searching by tag was case-sensitive, but saving a note quietly lowercased its tag, so "Travel" never matched. Tag searches now ignore capitalisation, so "Travel", "travel" and "TRAVEL" all find the same notes. Nothing for you to decide.