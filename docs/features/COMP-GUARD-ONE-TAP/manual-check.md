# COMP-GUARD-ONE-TAP — manual checklist (owner, once, at ship)

The one thing tests cannot drive is the system authentication sheet. Everything below needs an
interactive terminal in the GUI session on this Mac (not SSH, not `tmux` unless `pam_reattach` is
installed). Run in order; note the result in the last column. Design §"Gate checkpoint" lists why each
item exists.

| # | Step | Expected | Result |
|---|---|---|---|
| 1 | `compose guard enrol` | Prints the install plan, then **two** Touch ID sheets (install, then the first signature); ends with `done`; `git status` in `stratum/` shows `ts/contracts/guard-signers.allowed` modified with a `ruze ssh-ed25519 …` line | PASS 2026-09-06 09:46 — password once (pam_tid installed by this run), then Touch ID; `done`; fingerprint `SHA256:oNNK2K…`; trust root line committed (stratum `1d25be6`) |
| 2 | `compose guard status` | `signing:` block shows backend `sudo`, installed ✓, rule `present` or `unknown`, presence `likely`, enrolled fingerprint, trust-root membership ✓, `current` generation verified | PASS — after the coverage fix (`d91d830`): backend sudo, installed yes, rule present, presence likely, fingerprint, `current` verified (0.17 s) |
| 3 | `compose guard sign` | **One** Touch ID sheet; one line `signed by ruze (SHA256:…), N descriptor(s), verified` | PASS — in the compose workspace `sign` was `fresh` (legacy pair adopted, 0 descriptors, no sheet by design); in a throwaway workspace: ONE sheet, `signed by ruze (SHA256:oNNK2K…), 0 descriptor(s), verified`, 3.2 s |
| 4 | `compose guard sign` again, immediately | Still one sheet (no credential reuse); `sudo -n -v` right after exits non-zero (`-k` seeded nothing) | PARTIAL — `cached admin credential: none` right after signing (the `sudo -n -v` check inside status); a second sheet cannot be forced while the generation is fresh |
| 5 | `compose guard sign`, then **cancel** the sheet | Refusal `signature_not_approved` with the hint; `readlink .compose/guard-upgrades/current` unchanged; no `.staging-*` directory left | |
| 6 | From an SSH session into this Mac: `compose guard sign` | Refusal `signature_not_approved` (no sheet can be shown); nothing written | |
| 7 | Backfill a registered legacy feature through the MCP tool or `POST …/lifecycle/backfill` while `current` is stale | One sheet appears from the compose server process; the backfill completes; a second backfill on the same checksum shows no sheet | |
| 8 | `echo '{}' \| STRATUM_GUARD_UPGRADE_DESCRIPTORS="$(realpath .compose/guard-upgrades/current)/descriptors.json" node node_modules/@smartmemory/stratum/dist/cli/stratum.js guard descriptors` | `signature: verified: signed by ruze (…)` | PASS — `signature: verified: signed by ruze (…)`, `group_or_world_writable: false` |

If item 1 shows no sheet for the second approval but item 3 run from the terminal does, `pam_tid` is
not reaching tty-less processes: record it here, keep the terminal path as the operator's one command,
and file the follow-up (design §"Gate checkpoint" item 1).
