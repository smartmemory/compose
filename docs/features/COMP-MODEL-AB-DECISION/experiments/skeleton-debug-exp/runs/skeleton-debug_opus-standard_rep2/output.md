I fixed the bug and the repro now passes: `node --test test/repro.test.js` gives 1 pass, 0 fail.

**Cause:** in `src/store.js`, `search()` built its WHERE clause as `(n.title LIKE $p ...)` and never checked the body. A note that only mentioned the query in its body could never come back.

**Fix:** I added one condition, `OR n.body LIKE $p ESCAPE '\'`, inside the existing parentheses. Keeping it inside them means the tag filter still applies to both title and body matches. The body check uses the same pattern as the title check, so `%` and `_` are still matched as literal characters.

**Checked with a quick script:**
- Title and body matches come back together, newest first.
- The tag filter still narrows the results.
- Searching for `%` only matches a note that really contains a `%`.
- `limit` is still applied.
- A query that matches nothing returns an empty list.

The repro is the only test file in the repo, so I couldn't run a wider suite. The checks above stand in for it. The repro also creates a log folder, `.test-log/`, which is not tracked by git; I left it in place.

**ELI5 TLDR:** Search only ever looked at note titles and skipped the text inside. **Now it looks at both**, and the other search options behave as before. Nothing is left for you to decide.