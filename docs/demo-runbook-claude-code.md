# Compose Demo Runbook — Claude Code only

**The demo product:** Compose's own Usage statistics page (`COMP-OBS-STATS-1`) — a
cross-build cost and token dashboard, built live, in the Compose repo, by Compose.

**What makes this runbook different.** The companion runbook
([`demo-runbook.md`](./demo-runbook.md)) demos the full product: a web UI on :5195, a
server on :4001, and the `compose` CLI, with the terminal driving and the browser
showing the machine work. This one strips all of that away. **No `npm run dev`, no
browser, no `compose` binary.** One Claude Code session in a terminal, the `/compose`
skill, and the repo.

Written 2026-09-28.

**Legend:** ✅ verified on disk 2026-09-28 · ⚠️ known rough edge · ❓ rehearse before you rely on it

---

## Why this version exists

Three reasons to reach for it:

1. **Nothing to go wrong on stage.** The full demo has three processes, a port, a
   browser, and a machine-wide supervisor that only one instance may own. This has a
   terminal.
2. **It is the honest surface for a technical audience.** Compose's value is the
   lifecycle discipline — design gate, blueprint verification, TDD per task, the Codex
   review loop, the ship gate. None of that lives in the UI. The UI watches it happen.
3. **It dogfoods.** You are building a real Compose feature, in Compose's own repo,
   with Compose. If it works here it works anywhere, and the audience can check the
   commit afterwards.

⚠️ **The cost of dropping the UI:** you lose the moment where the graph populates as the
flow runs. That is the most visually compelling 30 seconds of the other demo. Do not run
this version for a non-technical audience.

---

## Step 0 — What you need running

Nothing. ✅

The `compose` MCP server is a **stdio** server (`server/compose-mcp.js`, 277 lines) that
reads and writes the repo directly. Verified: it contains no reference to a port, to
`localhost`, or to `fetch` — it does not talk to the :4001 server and does not need it to
be up. Claude Code launches it per `.mcp.json` when the session starts.

⚠️ If the :4001 server happens to be running from earlier work, that is harmless — but do
not start it for this demo, and do not kill it if someone else owns it.

---

## Step 1 — Open the session

```sh
cd ~/reg/my/forge/compose
claude
```

Show the audience the working tree is clean before you start. Everything that appears
from here on was written during the demo.

```sh
git status -sb
git log --oneline -3
```

✅ This is worth 15 seconds. The single most common objection to any AI-build demo is
"that was already there."

---

## Step 2 — Show the feature already has a home

```
/roadmap
```

`COMP-OBS-STATS-1` is already on the roadmap as `PLANNED`, under the phase
"COMP-OBS-STATS: Usage statistics", with a design doc at
`docs/features/COMP-OBS-STATS-1/design.md`.

**This is the point of the whole demo and it is easy to rush past.** The feature was not
invented by a prompt. It was filed, given a code, placed in a phase, linked to its parent
(`COMP-OBS-COST-4`), and designed — and the design names its own open questions and the
two schema gaps that block later slices. Read one of the open questions aloud.

⚠️ The roadmap is **generated**. Never hand-edit a row on stage; if you need to add
something, that is `add_roadmap_entry`.

---

## Step 3 — Run the lifecycle

```
/compose build COMP-OBS-STATS-1 --through execute
```

`--through execute` stops the run after the implementation gate rather than carrying on
into report, docs and ship. For a demo you want to end on working code, not on paperwork.

### What actually happens, in order

| Phase | Produces | Gated? |
|---|---|---|
| 1 Explore & Design | reads the existing `design.md`, does not rewrite it | yes |
| 2 PRD | `prd.md` | yes |
| 3 Architecture | `architecture.md` | yes |
| 4 Blueprint | `blueprint.md` — the file-by-file implementation spec | yes |
| 5 Blueprint verification | checks the blueprint's paths and signatures against the real codebase | yes |
| 6 Plan | task breakdown | yes |
| 7 Execute | TDD per task, then the review loop | yes |

**Every one of those is a gate.** Agent proposes, you decide: approve, revise, or kill.
That is the demo. Approve most of them fast; **stop and use "revise" at least once**, out
loud, so the audience sees the human is actually in the loop and not clicking OK.

### Where to slow down

- **Phase 5, blueprint verification.** This is the phase nobody else has. It takes the
  blueprint's claimed file paths and function signatures and checks them against the
  codebase *before* anything is written. Say plainly what it prevents: a plan that
  compiles in the model's head and not on disk.
- **Phase 7's Codex review loop.** Implementation is reviewed by a *different vendor's
  model*, and the loop re-runs until it returns `REVIEW CLEAN` (max 5 iterations; hitting
  the max means the spec is wrong, and it escalates to you rather than shipping). Findings
  are graded `must-fix` / `should-fix` / `nit` with a confidence score against
  `contracts/review-result.json`.

⚠️ **Time.** The full chain is long. If you have under 20 minutes, use:

```
/compose build --quick COMP-OBS-STATS-1
```

`--quick` collapses to design → implement → ship with a **single** design gate, omitting
PRD, architecture, blueprint, blueprint-verification, plan and report. It keeps every
Phase-7 enforcement: TDD per task, verification-before-completion, the review loop, the
coverage sweep. Say that explicitly — the shortcut drops ceremony, not enforcement.

❓ Rehearse whichever of the two you intend to run. Do not decide on stage.

---

## Step 4 — Show the artifacts, not the chat

When the run stops, leave the conversation and look at the repo. This is the difference
between Compose and a chat window, and it only lands if you show files.

```sh
ls docs/features/COMP-OBS-STATS-1/
git status --short
git diff --stat
```

Then open one artifact and one test:

```sh
cat docs/features/COMP-OBS-STATS-1/blueprint.md
```

✅ The line to say: *a chat gives you an answer; this gives you a paper trail you can
review, diff, and reject.*

---

## Step 5 — Prove the code runs

```sh
node --test test/usage-stats*.test.js
```

Then show the aggregate coming out of real data — the substrate is a file that already
exists, with 16 real builds in it going back to 2026-08-15:

```sh
wc -l .compose/data/build-history.jsonl
```

⚠️ **Do not claim a number you have not just printed.** The repo has a pre-push gate
(`bin/receipts-gate.js`) that blocks commits stating a measurement without one, which is
a good thing to mention and a bad thing to violate on stage.

---

## Step 6 — The honest close

Show the design doc's own open questions:

```sh
sed -n '/Open questions/,/Slices/p' docs/features/COMP-OBS-STATS-1/design.md
```

Three things the feature does **not** do, written down before it was built: it covers one
workspace not all, most of its cost history has **no provenance record at all** (54 of 76
dispatches carry no `usd_source`, so the headline number is permanently qualified), and it
will understate your true spend because it only sees dispatches Compose made.

There is a fourth thing worth showing if the audience is the right one: the doc contains
a section headed **"Correction: this design initially named the wrong substrate."** The
first draft proposed the wrong data file and declared a feature impossible that was
already implemented elsewhere in the repo. Review caught it, and the reversal is recorded
in the document rather than quietly edited out.

✅ **This is the strongest moment available to you.** Every AI demo claims completeness.
Ending on a written list of what the system knows it cannot do is the thing the audience
will remember, and it is the difference between a tool that reports and a tool that
markets.

---

## Failure modes, and what to say

| If this happens | Do this | Say this |
|---|---|---|
| A gate proposal is wrong | Choose **revise**, state why in one line | "That is the gate working." |
| Codex review loop hits 5 iterations | Let it escalate; stop there | "It refuses to ship past a review it cannot satisfy — the spec is wrong, not the code." |
| A phase takes too long | Ctrl-C, restart with `--quick` | Rehearse this transition; do not improvise it. |
| `stratum_agent_run` is unavailable | The skill falls back to a `general-purpose` agent against the same review contract | Only mention if asked. |
| The suite is red from unrelated work | Stop. Do not demo on a red tree. | Check before you start (Step 1). |

⚠️ **Never type `compose init --help` in this repo.** It *runs* init and rewrites
`.mcp.json` with machine-specific absolute paths — which in this demo would break the
MCP server you depend on. (`compose new --help` is safe.) This runbook does not use the
CLI at all, which is one more reason to prefer it.

---

## What this runbook deliberately does not show

Being straight about this matters if you ever demo both versions to the same people.

- **The web UI** — the graph, the dashboard, the ops strip's live cost counter, the
  context panel. All real, all covered by the other runbook.
- **`compose new`** — the zero-to-product on-ramp that turns a one-sentence goal into
  research, brainstorm and a roadmap. It exists **only in the CLI**, so it is out of
  scope here by construction. If someone asks "how does a project start?", that is the
  answer, and it is the other demo.
- **A greenfield project.** This builds into an existing 409-feature repo. That is a
  *harder* demo, not an easier one, and worth saying so.
