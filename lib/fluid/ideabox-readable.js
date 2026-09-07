/**
 * lib/fluid/ideabox-readable.js — ONE readability check, for every caller.
 *
 * COMP-IDEABOX-MIGRATE-DIALECT FU-2.
 *
 * The original bug was a parse that failed being read as "this file has no
 * ideas", after which the next projection write replaced the file with a
 * projection that did not contain them — 18 ideas destroyed by one command.
 * The fix for that bug put the readability check in the MIGRATION GATE. That
 * guarded the destructive path but not the parse: every other caller of
 * `parseIdeabox` still read failure as absence.
 *
 * This module is the check itself, extracted so there is one implementation
 * instead of one per caller. It is a LEAF on purpose: it takes an already
 * parsed document and knows nothing about providers, stores or files.
 * `lib/ideabox.js` (the parser) has to be able to import it, and
 * `ideabox-migrate.js` already imports `parseIdeabox` FROM `lib/ideabox.js` —
 * so keeping the assertion in the gate and wiring it into `readIdeabox` would
 * close an import cycle. Hence its own module, re-exported from
 * `ideabox-migrate.js` so existing importers are unaffected.
 */

export class IdeaboxUnreadable extends Error {
  constructor(unread, ideaboxPath) {
    super(
      `compose: the ideabox at ${ideaboxPath} declares ${unread.length} idea(s) this version cannot ` +
      `read: ${unread.join(', ')}. Refusing rather than proceeding, because continuing would treat ` +
      `them as absent and the next write would overwrite this file with a projection that does not ` +
      `contain them. This usually means the file is in a dialect newer or older than this install, ` +
      `or is partly converted. Nothing has been changed. Back the file up, then either upgrade ` +
      `compose or convert the entries by hand.`
    );
    this.name = 'IdeaboxUnreadable';
    this.code = 'IDEABOX_UNREADABLE';
    this.unread = unread;
  }
}

/**
 * Throw unless the parse actually understood the document.
 *
 * @param {object} parsed a `parseIdeabox` result
 * @param {string} ideaboxPath named in the error, for the human who has to fix it
 * @returns {object} the same `parsed`, so callers can `return assertIdeaboxReadable(...)`
 */
export function assertIdeaboxReadable(parsed, ideaboxPath) {
  const inMarkdown = [...(parsed.ideas ?? []), ...(parsed.killed ?? [])].map((i) => i.id);

  // READABILITY BEFORE SEMANTICS.
  //
  // Every caller reads `inMarkdown` as a statement about what the user has.
  // That is only true if the parse actually understood the file. When it did
  // not, an id vanishes from `inMarkdown` and every branch silently reads its
  // absence as consent — "no ideas here" — and the next write projects over it.
  // That is not a hypothetical: it destroyed 18 ideas in one command
  // (COMP-IDEABOX-MIGRATE-DIALECT).
  //
  // So compare what the file DECLARES against what the parser PRODUCED, and
  // stop on any gap. This deliberately catches more than the empty parse that
  // motivated it: a half-converted file yields some ideas and hides the rest,
  // which every count-based check (`inMarkdown.length === 0`) waves straight
  // through while it is just as destructive.
  // What the parse could see but not read. Taken from the parser itself, not
  // from a second scan of the same text: two readers of one document is the
  // exact shape that produced this bug and three of its follow-ons.
  const unread = [...new Set(parsed.unconsumed ?? [])].filter((id) => !inMarkdown.includes(id));
  if (unread.length) throw new IdeaboxUnreadable(unread, ideaboxPath);

  // The same id declared twice is the half-converted document: the parser reads
  // one copy, so the check above is satisfied while the other — routinely the
  // older, richer one — is invisible and would be deleted by the next render.
  const seen = new Set();
  const duplicated = [...new Set([
    ...[...inMarkdown, ...(parsed.unconsumed ?? [])].filter((id) => seen.size === seen.add(id).size),
    // An umbrella named after an idea that also exists here as a real idea:
    // the half-converted document, where the richer original survives only as
    // the heading the parser turned into a cluster.
    ...(parsed.collisions ?? []),
  ])];
  if (duplicated.length) throw new IdeaboxUnreadable(duplicated, ideaboxPath);

  return parsed;
}
