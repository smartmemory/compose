The tag filter is fixed: `node --test test/repro.test.js` now gives 1 pass, 0 fail. The only file changed is `src/store.js`, with 6 lines added and 2 removed.

**The bug:** saving a note lowercases its tags, so 'Travel' is stored as 'travel'. But `search()` compared the filter to the stored tag exactly (`t.tag = $tag`), so a filter of 'Travel' never matched. The same gap hits the other two ways tags get saved: `update()` and `importNotes()` keep tags as given. The seed data really does have 'Travel' and 'TRAVEL' on different notes, so a filter could only ever find one spelling.

**The fix:** tag matching in search now ignores case, whichever way the note was saved.
- The filter tag is trimmed and lowercased.
- The stored tag is lowercased by a small function, `tag_key`, added when the store opens. It lowercases the same way as the rest of the code. I didn't use SQLite's built-in `lower()` because it only handles plain English letters.
- Stored tags are not changed, and recall still returns each tag spelled the way it was saved.

**What I checked beyond the repro** (a one-off script on the seed notes and the store API, not a test file):
- Filters 'travel' and 'TRAVEL' both return all three seeded travel notes, whether tagged 'Travel' or 'TRAVEL'.
- ' boats ' (with spaces) finds the 'Boats' note.
- A non-matching tag returns nothing, and search without a tag is unchanged.
- A tag set through `update()` in mixed case is found by its lowercase form.

The repro is the only test file, so there was no wider suite to run. Running it creates `.test-log/repro.log`, which I left in place.

**ELI5:** Notes get their labels saved in lowercase, but the search compared your label letter-for-letter, so asking for "Travel" missed notes saved as "travel". Search now ignores upper and lower case on both sides, so any spelling of a label finds every note with that label.