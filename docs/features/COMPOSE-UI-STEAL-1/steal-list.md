# COMPOSE-UI-STEAL-1: what Compose can take from Orca

Status: ANALYSIS, 2026-10-29. Owner ask (via s1-chat): "what can we steal? we need compose UI to be
fully functional". Report: `smart-memory-ops/units/COMPOSE-UI-STEAL-1/report.md`.
Orca = github.com/stablyai/orca, MIT ("Copyright (c) 2026 Lovecast Inc."), v1.4.214, an Electron
desktop app (~42.5K files). Read via the GitHub API only; nothing from it was built or run.

## In one paragraph

Orca is good at the *workbench* half of agent work: each task gets its own git checkout, you
watch the agent in a real terminal, you read its diff and drop comments on lines that go straight
back to the agent. Compose is good at the *lifecycle* half (roadmap, gates, builds, graph) and has
almost none of the workbench: its agent bar works on the main checkout, it lost its terminal pane,
and its only diff view compares documents. So the steal is the workbench, ported into Compose's
existing slots. It does not fix Compose's own open wiring list (COMP-AUDIT-8..18,
COMP-COCKPIT-12/13, COMP-GATE-HEADLESS-1, ROADMAP.md:1332,1467-1468,1544-1554); those still
need doing.

## Steal list (ordered by leverage toward "fully functional")

| # | Orca piece | What Compose gets | Shape fit | Lift | Size |
|---|---|---|---|---|---|
| 1 | Visible worktree per task | own sandbox per feature/chat, in UI | spine ext | idea+types | M |
| 2 | Diff line notes -> agent | review code at the gate, notes go back | gate | copy+port | M |
| 3 | Terminal pane + agent status | watch/type into an agent; who needs me | agent bar | port | M |
| 4 | Agent launch catalog | start Claude/Codex/OpenCode interactively | adapter | copy data | S |
| 5 | Mobile diff review | read diffs, send notes from the phone | mobile PWA | port | S |
| 6 | Fan-out, pick winner | same prompt, N tries, merge the best | COMP-CONSENSUS | idea | M |
| 7 | SSH worktrees | run agents on a big remote box | DIST-EXEC adapter | idea | L |

License for every row: MIT, compatible with Compose's BSL 1.1 (`compose/LICENSE:1`). Any copied
file keeps Orca's notice: add it to `compose/NOTICE` (which already carries an MIT block).

### Row notes (evidence)

1. **Orca:** `WorktreeMeta` in `src/shared/worktree/meta-types.ts` (display name, linked issue/PR,
   comment, `diffComments`, host id); CLI `orca worktree create|list|show|rm|ps`
   (`src/cli/specs/core.ts`). **Compose today:** worktrees exist only inside a build
   (`pipelines/build.stratum.yaml:236` `isolation: worktree`, `server/worktree-gc.js`, COMP-GSD-3
   at ROADMAP.md:1284) and are never shown; the agent bar runs on the bound project root
   (`server/agent-workspace.js:191` `cwd: binding.targetRoot`) and `/api/agent/spawn` runs
   `claude -p` in `projectRoot` (`server/agent-spawn.js:58-64`). **Fit:** a feature is already the
   unit of work (feature.json); a worktree attaches to it. Rows 2 and 3 sit on this one.
2. **Orca:** `DiffComment` type (`src/shared/diff-comment-types.ts`: file, line range, body,
   `sentAt`, scope unstaged/staged/branch), the quote-safe prompt format
   (`src/shared/diff-comments-format.ts`: `File: / Line: / User comment: "..."`), UI in
   `src/renderer/src/components/diff-comments/`, and delivery as a bracketed paste into the
   agent's terminal (`src/renderer/src/lib/active-agent-note-send-delivery.ts`). **Compose today:**
   diff capture exists (`lib/gsd-diff-capture.js`), gates take one free-text revise comment
   (COMP-PARITY-1), `src/components/shared/ArtifactDiff.jsx:2` is a `diffLines` view of docs.
   **Fit:** the L4 Gate UI (ROADMAP.md:142): line notes become structured "Revise" feedback.
   Copy the type and formatter (two small files); port the UI with the `diff` package Compose
   already has (Orca's editor uses Monaco view zones, not worth pulling in).
3. **Orca:** xterm.js + node-pty (`package.json` deps `node-pty`, `@xterm/headless`,
   `@xterm/addon-serialize` for scrollback that survives restarts); status from hooks POSTing to a
   loopback server plus the OSC 7501 Program Status protocol read off the pty
   (`src/main/agent-hooks/README.md`, `src/shared/program-status/protocol.ts`: states idle, working,
   blocked, done, error; blocked kinds permission, question, auth; Claude Code sends it since
   2.1.295 per that README). **Compose today:** no terminal (no xterm/node-pty in
   `package.json`); its terminal server was removed (`src/components/vision/ChallengeModal.jsx:38`
   "/api/terminal/inject route died with terminal-server.js"); multi-session status is PLANNED
   (COMP-COCKPIT-12, ROADMAP.md:1467). **Fit:** the agent bar slot (COMP-UI-1, ROADMAP.md:269).
   Port the pattern only:
   Orca's pty layer is ~100 files of Windows/WSL/shell-ready handling (`src/main/pty/`,
   `src/main/providers/local-pty-*.ts`).
4. **Orca:** `TuiAgentConfig` table (`src/shared/tui-agent-config-types.ts`,
   `src/shared/tui-agent-config.ts`): detect command, launch command, how the prompt is injected
   (argv, flag, stdin), draft-prompt flag, pre-trusting the folder. **Compose today:** Stratum
   connectors are headless (`stratum/ts/src/connectors/{claude,codex,devin}.ts`). **Fit:** adapter.
   Every launch must go through the Stratum session door (SESSION-MGMT-1 U13,
   `stratum/docs/features/SESSION-MGMT-1/plan.md:421`), so copy the table shape, not the launcher.
5. **Orca:** `mobile/src/session/mobile-diff-comments.ts` and `MobileDiffCommentLineRow.tsx`.
   **Compose:** mobile PWA has Agents/Builds/Ideas/Roadmap tabs only (`src/mobile/tabs/`). Needs 2.
6. **Orca:** README "Fan one prompt across five agents ... compare the results and merge the
   winner". **Compose:** parallel dispatch splits different tasks; `BranchComparePanel.jsx` compares
   lineage; COMP-CONSENSUS is PLANNED (ROADMAP.md:1056). Lands there, not as a new mechanism.
7. **Orca:** `src/main/ssh/` (471 files), `ssh2` dep, known_hosts checks
   (`docs/site/content/docs/ssh.mdx`). **Compose:** COMP-DIST-EXEC PLANNED
   (`docs/features/COMP-DIST-EXEC/design.md:16-26`). Idea only; the remote executor is that unit.

## Not worth stealing

- **Phone relay** (`cloud/apps/relay`, NaCl box pairing in `src/shared/e2ee-crypto.ts`):
  COMP-MOBILE-REMOTE already decided not to run a relay (`design.md:38`); Compose uses a
  bring-your-own tunnel plus QR pairing (`src/mobile/pages/PairPage.jsx`).
- **Account switcher and usage tracking** (`src/main/claude-accounts`, `codex-accounts`,
  `rate-limits`): seats, quota and admission belong to SESSION-MGMT-1 and `usage_watch.py`. A
  second switcher would bypass the door.
- **Browser pane / design mode** (`src/renderer/src/components/browser-pane/`, 866 files under
  `src/main/browser`): needs Electron webviews; Compose is a web app. Large, off the critical path.
- **Plugin system** (`docs/reference/plugin-authoring.md`): Compose has presets and templates.
- **Electron shell, i18n, GitHub/Linear/Jira browsers, computer use**: scope, not function.
- **Telemetry**: Orca ships PostHog (`posthog-node` dep; opt out with `ORCA_TELEMETRY_DISABLED=1`).

## Recommendation

Plain English: **build the three workbench pieces into Compose (option a).** First give every
feature and every agent chat its own visible checkout (row 1). Then let the reviewer read that
checkout's code diff at the gate and click lines to leave notes that go back to the agent as the
"revise" message (row 2). Then put a real terminal in the agent bar with a status light per agent
(row 3). With those, a person can run, watch, review and correct an agent without leaving Compose.

Not (b), Orca as the front end: Orca's only agent interface is "a CLI in a terminal"
(README "if it runs in a terminal, it runs in Orca"; `TuiAgentConfig`), so Compose's gates,
roadmap and builds would not appear in it without writing an Orca plugin panel; and Orca starts
agents itself with its own account switcher, which skips the Stratum admission door. Using Orca
by hand next to Compose is possible today at no build cost, but it is a personal-tool choice, not
a Compose design. Not (c) for the same reason.

Precise order: row 1 (M) then rows 2 and 3 in parallel (M each); row 4 (S) rides with row 3;
row 5 after row 2. Rows 6-7 attach to COMP-CONSENSUS and COMP-DIST-EXEC when those are picked.
Sizes are judgment, not `estimate.py` output (no data for this kind of unit). This is three or
more units across server and UI, so the owner picks the shape before it is mapped
(`shape-before-mapping.md`).
