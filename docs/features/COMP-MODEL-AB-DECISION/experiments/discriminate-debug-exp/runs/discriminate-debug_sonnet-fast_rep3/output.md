The repro now passes. `search_notes` with a tag filter of `Travel` finds the note written with `Travel`.

**Cause:** `write` lowercases tags before storing them, so `Travel` is saved as `travel`. `search` then compared the stored tag to the filter exactly, so `Travel` never matched `travel`. `update` and `importNotes` keep tag case as given, so the seed data holds both `Travel` and `TRAVEL`. Any exact-match filter would miss some of those too.

**Fix:** in `src/store.js`, `search` now lowercases both sides of the tag comparison (`lower(t.tag) = $tag`) and trims and lowercases the filter value. Stored tags are unchanged, so what `recall` returns is the same as before. The change is one line in `search`, plus one line for the filter value. Searches without a tag filter run the same query as before.

I ran only the repro, with `node --test test/repro.test.js`. The `test/` directory contains only `repro.test.js`, so there was no other suite to run. `node --test test/` errors with "Cannot find module .../test" because it treats the directory as a file path. That error is unrelated to the change.

**In plain terms:** the server saved tags in lowercase but compared your filter exactly as typed, so `Travel` never matched `travel`. The filter now ignores case.