`test/repro.test.js` now passes. It's the only test in the project, so nothing else was exercised. Beyond that, I only reasoned about the other paths.

**Cause:** `write()` lowercases tags before storing them, so `Travel` is saved as `travel`. `search()` compared the filter to the stored tag exactly, so the filter `Travel` never matched. `update()` and `importNotes()` store tags with their original case, which is why the seed data has `Travel`, `TRAVEL` and `food`.

**Fix** (`src/store.js`, in `search`): the tag filter now ignores case, and surrounding whitespace in the filter is trimmed. It compares `lower(t.tag)` to the lowercased filter, so notes written through any of the three paths are found whatever case they were saved in.

I did not change how tags are stored, so `recall` and `write` still return the same tags as before.

SQLite's `lower()` only handles ASCII letters. A tag with non-ASCII capitals, such as `Ünï`, would still not match its lowercased form.

**ELI5 TLDR**
Tags are saved in lowercase, but the search filter compared them exactly, so asking for "Travel" never matched a saved "travel". The search now ignores case when matching tags, and nothing else changed.