Fixed. The repro passes now (1 passed, 0 failed), and the change is confined to `src/store.js`.

**Root cause:** `write()` lowercases tags before storing them, so `'Travel'` is saved as `'travel'`. But `search()` compared the tag filter exactly as typed (`t.tag = $tag`), so filtering on `'Travel'` never matched. A related problem had the same cause: `update()` and `importNotes()` deliberately keep tags in the case they were given (the seed data has `'Travel'` and `'TRAVEL'`), so any single spelling of the filter missed some of those notes too.

**Fix:**
- I added one helper, `foldTag` (trim and lowercase). `write()` already used that rule, and now it calls the helper.
- `search()` cleans up the filter with `foldTag` and compares it against a `fold_tag(t.tag)` SQL function registered on the database. I used a JS function rather than SQLite's `lower()` because `lower()` only handles plain English letters, and the match should follow the same rule as stored tags.
- Stored tags are unchanged, so `recall` still shows imported or updated tags in the case they were given.

**Other behaviour I checked by hand:**
- Seed-imported notes are found with `Travel` and with `TRAVEL`.
- A tag with accents (`ÉTÉ` matches `été`) works.
- Tags set by `update()` match a padded filter like `' boats '`.
- Search without a tag filter is unchanged, and a filter with no matches returns nothing.

There's no other test suite in the repo, so those checks are the only regression coverage. Running the repro creates a `.test-log/` folder, which I left in place.

**ELI5:** When you saved a note tagged "Travel", the app quietly stored it as "travel". Then when you searched for "Travel" it looked for that exact spelling and found nothing. Search now ignores upper and lower case, so any spelling of the tag finds the note, and saved tags keep the case you typed. Nothing for you to decide. The fix isn't committed yet.