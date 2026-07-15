# Journaling Rule

Compose's developer journal (`docs/journal/`) tells the story of how Compose was built. Milestone sessions contribute a chapter.

**DEMOTED (2026-07-15):** every-code-session → milestone sessions only. The routine working record lives in CHANGELOG.md, epic ledgers (`docs/plans/*-progress.md`), and git history; the journal is the curated narrative layer on top.

## When to journal

Journal only on milestone sessions — before the session ends:

- A feature, epic phase, or migration slice reaches COMPLETE (or is killed/superseded)
- A decision-heavy session: an adjudication, reversal, or architecture decision future sessions must not re-litigate
- A session whose lessons would otherwise be lost — a novel failure mode, a postmortem-worthy debugging arc, a wrong turn worth remembering

Routine code sessions do NOT journal. If a session is borderline, fold its story into the next milestone entry instead of writing a thin chapter now.

When journaling:

1. **Write or update a journal entry** in `docs/journal/YYYY-MM-DD-session-N-<slug>.md`
2. **Update the journal index** in `docs/journal/README.md` with the new entry

## What goes in an entry

Follow the established format (see existing entries for reference):

- **What happened** — Narrative of the session. What was the human's ask? What did we discover? What broke? What was the fix? Tell the story, don't just list changes.
- **What we built** — File manifest: new and modified files with brief descriptions.
- **What we learned** — Numbered insights. Not just "what" but "why it matters." These are the reusable lessons.
- **Open threads** — Checkbox list of unfinished work, unanswered questions, things to test.

## Voice and tone

- First person plural ("we") — the human and the agent building together
- Honest about failures and wrong turns — the journal captures the real process, not the idealized version
- Technical but readable — someone unfamiliar with the codebase should follow the narrative
- The closing line of each entry should be a one-liner that captures the session's character

## Session numbering

Sessions are numbered **globally and monotonically** across the entire journal — not per date. The next session number is `max(existing) + 1`. Numbers never reset and gaps are never refilled. The `write_journal_entry` MCP tool computes this for you under an advisory lock; do not hand-pick a number.

## Why this matters

The journal is both the story of Compose and a distillation corpus — entries a future version of Compose could learn to generate from session transcripts. Milestone entries keep that corpus high-signal: the chapters worth learning from are the ones with a real arc, not routine status.
