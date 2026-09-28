# Compose Demo Runbook — zero to product in `testapp`

Written 2026-09-28 for a cold start: a fresh terminal, a fresh Claude Code
session, an empty folder. Assumes nothing from the session that produced it.

**Legend:** ✅ verified live on 2026-09-28 · ⚠️ known rough edge · ❓ rehearse before you rely on it

---

## Step 0 — Reset the folder (do this tonight, not on stage)

```sh
rm -rf ~/reg/my/testapp/.compose ~/reg/my/testapp/docs
ls -la ~/reg/my/testapp        # expect: empty
```

⚠️ **Do not skip.** Leftover `.compose/data` makes the demo look half-started.

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

## Step 3 — Kick off the product

```sh
compose new "Markdown table to CSV converter CLI" --auto
```

- `--auto` skips the questionnaire. **Drop `--auto` only if you want to show
  the questionnaire** — rehearse its length first. ❓
- This is the real zero-to-product on-ramp: research → brainstorm → roadmap →
  scaffold. It exists only in the CLI; **the UI never points at it.**

❓ **Rehearse this once tonight.** It is the longest unscripted step and the one
most likely to surprise you on stage. Then reset with Step 0.

---

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
compose ideabox add "Support piped stdin input"
compose ideabox add "Emit TSV as well as CSV"
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
compose feature "CSV output formatting"
compose build <FEATURE-CODE>
```

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

## MCP ↔ UI — the one thing that will bite you

**The MCP's workspace binding is independent of what the UI is pointed at.**
If they disagree, MCP writes land in a different project and **nothing appears
on screen** — which looks exactly like a crash.

- The MCP discovers workspaces by anchoring on the directory the **session
  started in**. ✅ So: **start Claude Code inside `~/reg/my/testapp`**, not
  inside `forge`. That is what makes `testapp` visible to it at all.
- Confirm before demoing: `get_workspace` → `current.root` must be
  `/Users/ruze/reg/my/testapp`. If not: `set_workspace({workspaceId: "testapp"})`.
- Useful MCP tools that show up in the UI: `get_roadmap`, `scaffold_feature`,
  `add_roadmap_entry`, `get_pending_gates`, `approve_gate`, `validate_feature`,
  `write_journal_entry`, `get_feature_lifecycle`.
- ⚠️ No ideabox tools. See Step 5.

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

Steps 0–2 done beforehand. Then: **ideabox add (live update) → triage →
promote → DESIGN → build → gate.** Everything else is optional.
