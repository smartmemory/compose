I fixed the bug. The repro now passes, and so does a real call through the server: a note saved with `Travel` comes back when you search with `Travel`.

**Cause.** Tags are saved in two different ways:
- `write_note` lowercases every tag, so `Travel` is stored as `travel` (`normalizeTags`, `src/store.js`).
- `update()` and `importNotes()` keep the case they were given, so the seed notes are stored as `Travel` and `TRAVEL`.

The tag filter in `search()` compared the filter text to the stored tag exactly, with no case handling. A `Travel` filter therefore missed notes saved by `write_note`. Lowercasing only the filter wouldn't have been enough either: it would then have missed the imported `Travel` and `TRAVEL` notes.

**Fix** (`src/store.js`, 5 lines added, 2 removed):
- The tag filter is trimmed and lowercased.
- The stored tag is lowercased when compared, using the same JavaScript lowercasing that `write_note` uses. SQLite's built-in `lower()` only handles plain English letters, so an imported `ÉTÉ` would not have matched `été` with it.
- Stored tags are not changed, so `recall_note` and search results still show each tag exactly as it was saved.

**Checks:**
- `node --test test/repro.test.js` passes 1/1, and `npm test` passes (1 pass, 0 fail).
- On the seed notes plus a newly written note, the filters `Travel`, `travel`, `TRAVEL` and ` Travel ` each return all four travel notes. `boats` returns the one note tagged `Boats`, an unknown tag returns nothing, and no filter at all behaves as before.
- Searching with `été` finds a note tagged `ÉTÉ`.
- Through the server: `write_note` with `Travel`, then `search_notes` with `tag: "Travel"`, returns the note.

I didn't touch the repro. I deleted the `.test-log/` folder that the repro writes when it runs, so the working tree has only the `src/store.js` change.

**One thing for you to decide.** Tags are still saved inconsistently: lowercase through `write_note`, original case through update and import. Searching is now correct either way. Making them consistent would change what `recall_note` returns for existing notes, so I left it alone.

**ELI5 TLDR:** Saving a note quietly turned "Travel" into "travel", but searching looked for "Travel" letter for letter, so it found nothing. **Search now ignores upper and lower case**, so any spelling of the tag finds every matching note, and saved notes are unchanged. The open question is whether new notes should also keep their tags in the case you typed them.