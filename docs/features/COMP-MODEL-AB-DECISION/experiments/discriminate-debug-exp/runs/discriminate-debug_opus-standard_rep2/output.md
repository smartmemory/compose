The repro passes now. The only change is in `src/store.js`.

**Cause:** `write()` stores tags in lowercase, so 'Travel' is saved as 'travel' (`normalizeTags`, store.js:45). `search()` then compared the filter to the stored tag exactly (`t.tag = $tag`), so a filter of 'Travel' never matched.

**The same bug in other places:** `update()` and `importNotes()` keep tags in the case they were given. All four seed notes come in through `importNotes()` with tags like 'Travel' and 'TRAVEL', so a filter of 'travel' would have missed them too. Lowercasing only the filter would have fixed the repro and broken those notes the other way.

**Fix:** a search now lowercases and trims both the filter and each stored tag before comparing them, using the same function `write()` already uses. I registered that function in SQLite as `tag_fold` instead of using SQLite's own `lower()`, because `lower()` only handles plain ASCII letters (unverified from docs; I didn't test `lower()` itself). Tags are still stored and returned exactly as before.

**Checks:**
- `node --test test/repro.test.js`: 1 pass, 0 fail. `npm test`: 1 pass, 0 fail.
- A one-off check with no files written:
  - With the seed notes, the filters 'Travel', ' travel ' and the MCP `search_notes` call with 'TRAVEL' each return all 3 travel notes.
  - 'boats' and 'WORK' find their one note, and an unknown tag returns nothing.
  - A note written with 'Été' is found by the filter 'ÉTÉ'.
  - A tag set to 'MixedCase' through `update()` is found by 'mixedcase'.
  - Searching without a tag filter works as before.
- I briefly saw `# fail 1` because I passed the `test/` folder to `node --test`, which Node 22 doesn't accept. It wasn't a test failure.
- The repro creates a `.test-log/` folder when it runs. I left it in place.

**ELI5 TLDR:** When you save a note, its tags are lowercased, but the tag search compared exactly, so 'Travel' never matched the saved 'travel'. Notes loaded through import or edit keep their capitals, so a lowercase search missed those too. **Tag search now ignores capitals and extra spaces on both sides, so every way a note gets its tags is covered.** Nothing else changed, and nothing is committed: say if you want a commit.