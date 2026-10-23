The repro now passes. `node --test` over the whole `test/` directory gives 1 pass and 0 fail, but that directory holds only the repro, so no other tests were run.

**Cause:** `write` lowercases tags before storing them, so `Travel` was saved as `travel`. The tag filter in `search` compared with exact equality, so the filter `Travel` never matched. `update` and `importNotes` store tags in their original case, so the seed data has `Travel`, `TRAVEL` and `travel` side by side. An exact match would also have missed some of those depending on the case you typed.

**Fix:** in `src/store.js`, `search` now matches tags case-insensitively: `lower(t.tag) = lower($tag)`. I left the storing code alone, so `write` still lowercases and `update` and `importNotes` still keep the case they were given.

**In plain terms:** a note tagged "Travel" was saved as "travel", and the search compared the two exactly, so it found nothing. The search now ignores capitalisation, so "Travel", "TRAVEL" and "travel" all find the same notes.