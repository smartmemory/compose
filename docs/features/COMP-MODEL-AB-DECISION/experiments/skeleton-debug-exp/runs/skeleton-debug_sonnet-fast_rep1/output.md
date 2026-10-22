`search_notes` now finds notes by words in the body, and `node --test test/repro.test.js` passes.

The query in `search` (`src/store.js`) only checked `n.title LIKE $p`. I added `OR n.body LIKE $p` with the same literal-escaping. The tag filter, ordering and limit are unchanged.

`repro.test.js` is the only test in the repo, so no other tests cover the rest of the server's behaviour. My one run of `node --test test/` failed, but I didn't look into why. It was probably how Node handles a directory argument. Running the file directly passes.

**ELI5 TLDR:** Search was only looking at note titles and ignoring what was written inside the notes. I made it look at both. Nothing needs deciding.