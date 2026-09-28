# Compose Demo Runbook — zero to product in `testapp`

**The demo product:** a CLI that finds duplicate contacts in a CRM export and
reports merge candidates with confidence scores. Chosen because it contains a
real architectural fork (exact vs fuzzy matching) — so the design phase shows
thinking rather than ceremony — and because every CRM person recognises the
pain instantly, spending no attention on the product and all of it on Compose.

Written 2026-09-28 for a cold start: a fresh terminal, a fresh Claude Code
session, an empty folder. Assumes nothing from the session that produced it.

**Legend:** ✅ verified live on 2026-09-28 · ⚠️ known rough edge · ❓ rehearse before you rely on it

**Companion:** [`demo-runbook-claude-code.md`](./demo-runbook-claude-code.md) runs the
same story with no UI, no server and no CLI — one Claude Code session driving the
`/compose` lifecycle. Prefer it for a technical audience or a fragile stage setup.

---

## Step 0 — Reset the folder (do this tonight, not on stage)

```sh
rm -rf ~/reg/my/testapp/.compose ~/reg/my/testapp/docs
ls -la ~/reg/my/testapp        # expect: empty
```

⚠️ **Do not skip.** Leftover `.compose/data` makes the demo look half-started.

⚠️ `testapp` currently holds a `.compose/compose.json` from a workspace-anchoring
test on 2026-09-28. The reset above clears it.

---

## Step 1 — Start the Compose server (once, before anything)

```sh
cd ~/reg/my/forge/compose
npm run dev
```

Wait for all three lines: api on **4001**, agent on **4002**, vite on **5195**.
Open **http://localhost:5195**.

⚠️ Only one supervisor may run machine-wide. If it complains about ownership,
something else already owns it — stop that first. Don't kill ports blindly.

---

## Step 2 — Initialise the project

```sh
cd ~/reg/my/testapp
compose init
```

⚠️ **Why this must come first.** Workspace discovery walks *upward* for a
`.compose` / `.stratum.yaml` / `.git` marker. Neither `~/reg` nor `~/reg/my`
has one, but **`~/.compose` does** — so from a truly empty folder discovery
anchors on your home directory and scans it. `compose init` writes
`.compose/compose.json`, making `testapp` its own anchor. ✅

⚠️ **Never type `--help` on `init`.** `compose init --help` *runs init* rather
than printing help. It rewrites `.mcp.json` with machine-specific absolute
paths. (`compose new --help` is safe.)

---

## Step 2b — Drop in the demo data

```sh
cp ~/reg/my/forge/compose/docs/demo-assets/contacts.csv ~/reg/my/testapp/
```

24 synthetic contacts with planted duplicates at every confidence band, plus
four deliberate traps that must **not** merge (same name different employer,
same name different role, Michael vs Michelle, and a singleton). Full breakdown
in `docs/demo-assets/README.md`.

⚠️ Say "synthetic" once on stage — it pre-empts "is that real customer data?".
No real people or companies; all numbers in reserved `555` ranges.

✅ The traps are what make the demo land: anything can find an identical row.
They force the **threshold** question, which is the design decision worth
watching.

---

## Step 3 — Kick off the product

```sh
compose new "CLI that finds duplicate contacts in a CRM export and reports merge candidates with confidence scores"
```

This is the real zero-to-product on-ramp. It exists **only in the CLI** — the UI
never points at it.

### What it actually runs

A Stratum flow of three agent-driven steps, each producing a real artifact and
each **validated against explicit criteria** (on failure it re-dispatches a fix
prompt and retries). Gates pause between steps for your approval.

| Step | Writes | Must contain |
|---|---|---|
| research | `docs/discovery/research.md` | ≥2 prior-art entries, architectural patterns, risks |
| brainstorm | `docs/discovery/brainstorm.md` | ≥3 features with codes, user stories, ≥2 architecture options with trade-offs |
| roadmap | `ROADMAP.md` | feature table with status columns, organised into phases, all PLANNED |

✅ This is why the UI populates as it runs: the flow writes vision state that
the graph and dashboard read. A free-form chat would produce plausible markdown
and **nothing would appear on screen**. The terminal is the driver; the UI is
where you watch the machine work. That is the story to tell.

### Questionnaire vs `--auto` — decide after rehearsing

Plain `compose new` asks **six questions** first: refine the description,
project type (CLI / API / library / full-stack), language/runtime, scope
(small/medium/large), **whether to research prior art**, and any extra
constraints. Answers persist to `.compose/questionnaire.json` and become
defaults next time (`--ask` re-runs it with those defaults).

`--auto` skips **only those six questions**. It does not skip any of the three
steps or the gates.

### Answers to give it

| Question | Answer | Why |
|---|---|---|
| Refine the description | keep | it is already specific |
| What kind of project? | **CLI tool** | |
| Primary language/runtime? | your pick | Node or Python both fine |
| Scope? | **Small (1-3 features, single module)** | keeps the build short enough to demo |
| Research prior art? | **No** | ⭐ drops an entire agent step — the single biggest time saver |
| Additional context? | **Yes** → paste the fixture note below | |

Context worth pasting when it asks:

> Input is a CSV export with columns id, first_name, last_name, email, phone,
> company, title, created. Must handle nicknames (Robert/Bob), diacritics and
> transliteration (Müller/Mueller), punctuation (O'Connor/OConnor), phone
> formatting variance, and company legal-suffix noise (Ltd, SA, GmbH). Must NOT
> merge people who share a name but differ in employer or role. Output a merge
> candidate report with confidence scores and a threshold the user can tune.

❓ **Rehearse with the questionnaire once, and time it.**
- If it is short: **use it live.** Those six questions are a good beat — they
  show the system pinning down intent before it generates anything.
- If it drags: fall back to `--auto`.

⚠️ `--auto` is **not** automatically the safer choice. It locks in "research
prior art = yes", which is a whole extra agent step. Answering **no** to that
one question is the single biggest time saver available, and `--auto` gives it
away.

❓ This is the longest unscripted step. Rehearse it tonight, then reset via
Step 0.

## Step 4 — Point the UI at `testapp`

In the UI header, click the project name (top-left, next to "COMPOSE") and
switch to `testapp`.

✅ The graph, ideabox and design views re-scope correctly.

⚠️ **Switch once, at the start. Do not switch again mid-demo.** Several stores
still show the previous project until a reload (`COMP-WS-CLIENTSTATE-1`), and
`compose:designSession` is not namespaced per project — a design session
started before a switch will bleed through.

---

## Step 5 — Ideabox (your opening beat)

```sh
compose ideabox add "Tune the merge threshold from a config file"
compose ideabox add "Emit a CSV of merge pairs for bulk import back into the CRM"
compose ideabox add "Flag same-name-different-employer pairs as job changes, not duplicates"
compose ideabox list
```

✅ **The money shot: run these with the UI visible.** The sidebar count updates
**live, with no refresh** — the file watcher pushes `ideaboxUpdated` over the
websocket and the store rehydrates. Type in the terminal, let the screen move.

Then in the UI: **IDEABOX** tab → **Triage** → assign priorities → **Promote to
Feature** on the best one. That promotion is your bridge into the pipeline.

⚠️ **Never open the Ideabox with zero ideas.** Its empty state tells you to go
use the CLI, which undercuts the whole cockpit pitch (`COMP-UX-ONRAMP-1`).
Seed it in this step, always.

⚠️ The MCP has **no ideabox tools at all**. Ideas come from the CLI or the UI
only. Don't promise otherwise.

---

## Step 6 — Design

UI → **DESIGN** tab → **Product Design**.

✅ Starts **without needing a feature code**, so it works on a young project.
✅ Keyed by project root, so it remounts cleanly — one of the safest surfaces
to demo.

---

## Step 7 — Feature + build

From the promoted feature, or directly:

```sh
compose feature "Confidence score thresholding"
compose build --quick <FEATURE-CODE>
```

⚠️ **`/compose build` (the Claude Code skill) will NOT animate the cockpit.** It
runs the lifecycle in-session and does not write the active-build record, so
BUILDS and the bottom bar stay empty. Use the headless CLI above, or better,
the UI's own **Start Build** control (`POST /api/build/start` —
`StartBuildPopover` / `LaunchPopover`), which is the same `runBuild` path and
gives you the live phase + cost chip in the bottom bar.

Watch in the UI: **BUILDS** (cost and agent activity), **GRAPH** (the feature
appears), **GATES** (approvals land here).

❓ Rehearse one real `compose build` end to end. It is the most impressive beat
and the most likely to run long. Know its duration before you commit to it live.

---

## Step 8 — Gates

UI → **GATES**, or:

```sh
compose gates
```

Approve from the UI — the bottom bar exposes a gate reviewer with a pager.

---

## Step 9 — The MCP beat (Claude Code driving the UI)

The pitch: **ask for something in plain English, watch the UI change while you
are still talking.** Two surfaces, one state.

✅ Verified 2026-09-28: an MCP write reached the running UI over the
file-watcher websocket, rendered in place, **no page reload**.

### Use these — they produce visible changes

| Ask Claude Code for | Tool | Shows up in |
|---|---|---|
| "scaffold a feature for confidence-score thresholding" | `scaffold_feature` | **GRAPH** (new node), ITEMS, DOCS |
| "add it to the roadmap" | `add_roadmap_entry` | roadmap views |
| "mark it in progress" | `set_feature_status` | GRAPH node colour, DASHBOARD |
| "what gates are pending?" | `get_pending_gates` | GATES + bottom gate bar |

**`scaffold_feature` is the one to demo live.** It is forgiving, and a new node
appearing on the graph mid-sentence is the clearest possible proof.

⚠️ **Do not demo `write_journal_entry` live.** It requires four exact sections
(`what_happened`, `what_we_built`, `what_we_learned`, `open_threads`) plus
`summary_for_index` and `date`, and it surfaces them **one validation error at
a time** — five consecutive failures before it accepted the call. It works, but
typing it live is a death spiral.

### Pre-flight, every time

```
get_workspace        → current.root MUST be /Users/ruze/reg/my/testapp
```

If it disagrees with the UI, your writes land somewhere invisible and it looks
like a crash. See the section below.

---

## MCP ↔ UI — the one thing that will bite you

**The MCP's workspace binding is independent of what the UI is pointed at.**
If they disagree, MCP writes land in a different project and **nothing appears
on screen** — which looks exactly like a crash.

- The MCP discovers workspaces by anchoring on the directory the **session
  started in**. ✅ So: **start Claude Code inside `~/reg/my/testapp`**, not
  inside `forge`. That is what makes `testapp` visible to it at all.
- ✅ **Proven, not theoretical.** A session started in `forge`, after running
  `compose init` in `testapp`, still got
  `WorkspaceUnknown: Unknown workspaceId: testapp` from `set_workspace`. The
  MCP could not reach it at all. Anchoring is fixed at session start; no amount
  of config fixes it afterwards.
- Confirm before demoing: `get_workspace` → `current.root` must be
  `/Users/ruze/reg/my/testapp`. If not: `set_workspace({workspaceId: "testapp"})`.
- Useful MCP tools that show up in the UI: `get_roadmap`, `scaffold_feature`,
  `add_roadmap_entry`, `get_pending_gates`, `approve_gate`, `validate_feature`,
  `write_journal_entry`, `get_feature_lifecycle`.
- ⚠️ No ideabox tools. See Step 5.
- ⚠️ Avoid `write_journal_entry` live. See Step 9.

---

## Known rough edges — avoid on stage

| Edge | Avoid by |
|---|---|
| Empty-state CTA says "Create your first feature" before any idea exists (`COMP-UX-ONRAMP-1`) | Seed the ideabox in Step 5; never demo a blank project |
| Ideabox zero-state points at the CLI | Same |
| Stale stores on project switch (`COMP-WS-CLIENTSTATE-1`) | Switch once, in Step 4, then never again |
| Auth reads/writes the startup project (`COMP-WS-ISOLATION-1`) | Don't demo device pairing |
| `compose init --help` runs init | Don't type `--help` on `init` |

---

## Five-minute cut

Steps 0–2 done beforehand, and `compose new` already run (its three steps are
too long for a five-minute slot). Then: **ideabox add (live update) → triage →
promote → DESIGN → scaffold via MCP → gate.** Everything else is optional.

The MCP scaffold (Step 9) is worth keeping even in the short cut — it is the
clearest single moment where talking to Claude Code visibly moves the UI.

If you have twenty minutes, put `compose new` back in as the opener — it is the
strongest demonstration that the pipeline is real, because every artifact it
writes is validated and shows up in the UI as it lands.
