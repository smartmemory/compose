1. **P1 — A local YAML without its sidecar can ship a blocking repair decision.**
   Locations: `lib/build.js:1534`, `lib/build.js:946`, `presets/team-fable-astra.profiles.json:7`, `docs/team-presets.md:70`.
   Reproduction: run `node /tmp/slice4-runtime.mjs missing` (adapts `test/helpers/build-wave-golden-fixture.js` to the unmodified bundled YAML, real `runBuild`, real Stratum MCP/engine and fake Codex).
   Copy only the YAML into the fixture's `pipelines/team-fable-astra.stratum.yaml`; retain its `execute_merge: skip` / `assess_gate: skip` policies and seeded adapter defect.
   The local resolver wins, `loadPipelineProfiles` returns `{}`, and `preflightPipelineProfiles` returns `ok: true` with every `modelID: null`.
   Recorded assess output is `action: repair`, `blocking: true`, `open_count: 1`, with a repair task; nevertheless `assess_gate` approves, no REPAIR worker runs, and ship commits the broken adapter with flow status `completed`.
   Evidence: `/tmp/slice4-missing.json` (`audit.steps.assess.output`, `audit.events`, `audit.steps.ship`, `pids`); `/tmp/slice4-missing.log` contains the preflight result.
   The omitted sidecar removes output-driven decisions, tier routing, ownership/checkpoint configuration and the ceiling. `docs/team-presets.md:70` says to copy both files but describes no degradation; `docs/pipelines.md:126` permits missing sidecars without disclosing that repair/blocked decisions lose authority.
   Fix: require the adjacent sidecar when loading this preset, before planning, and document that refusal.

2. **P2 — The documented space-separated cost override is rejected with `--team`.**
   Locations: `lib/team-flag.js:40`, `bin/compose.js:2625`, `bin/compose.js:2671`, `docs/cli.md:180`.
   Reproduction: from `/tmp/slice4-cli-project`, run `node /Users/ruze/reg/my/forge/compose/bin/compose.js build X --team fable-astra --cost-ceiling-usd 200`.
   Actual: exit 1, `Error: --team cannot be used with batch builds (--all or multiple features)`; no build starts. Evidence: `/tmp/slice4-cli.log`.
   `parseTeamFlag` counts `200` as a second feature before the CLI extracts the ceiling. This breaks the `<amount>` spelling explicitly advertised in `docs/cli.md:180` and the preset override guidance in `README.md:88`, `docs/pipelines.md:157` and `docs/team-presets.md:66`; the inline `--cost-ceiling-usd=200` spelling avoids this parser error.
   Fix: extract value-taking build flags before the team parser counts positional feature codes, preserving rejection of actual multi-feature builds.
