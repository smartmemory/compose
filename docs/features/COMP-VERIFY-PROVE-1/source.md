# COMP-VERIFY-PROVE-1: source notes from t3code

Source: pingdotgg/t3code @ f17114b2c2a2 (MIT), read 2026-11-23 by forge seat4 session.
These are notes on the source pattern, not a design. The clone is deleted, so the relevant text is quoted below. Reread the repo at the sha above for more.

## Our gap

`pipelines/bug-fix.stratum.yaml:126-134`: the reproduce step says "The test must fail before any fix is applied", but its ensure is only `result.outcome == 'complete'`, so failing on base is self-reported.

## Their pattern (docs/internals/15_testing.md, Scenarios)

```


Scenarios are [e2e](https://e2e.com/docs) tests in [`scripts/scenarios`](../../scripts/scenarios) (`*.e2e.ts`) that drive the real app (server, HTTP/WS, web browser or pooled iOS simulator) using the free `Replay (dev)` agent. Use one as real-app proof for a user-reproducible bug fix:

```sh
vp run scenarios                                                  # run all
vp run scenarios:prove scripts/scenarios/<name>.e2e.ts --base main --upload-command "ghdrop upload"
```

- One test per file (`WEB` from `./t3.ts` or `IOS` from `./t3-mobile.ts`). Seed projects and threads via `t3.project` / `t3.thread` before calling `t3.open(...)` so the app does not land on first-run setup.
- Navigate directly with `t3.open(thread)` or `t3.open("/settings/...")` rather than clicking sidebar text; let `t3.open` complete pairing before other navigation.
- Put `expect` assertions only on the behavior the bug breaks, and take `app.screenshot("label")` where the bug shows so `scenarios:prove` pairs base and head captures. Never call `agent.act` or `agent.assert` (no model is configured).
- The app starts with a minimal env (`PATH`, `HOME`, temp dir); pass extra env vars via `T3_SCENARIO_INHERIT_ENV='VAR,PREFIX_*'`. Run one scenario run at a time per checkout.
- `scenarios:prove` exits `0` only when the test fails on base and passes on head (`1` = did not prove, `2` = app failed to start, `3` = scenario failed before its assertion). iOS scenarios lease a Simlock simulator and require `SIMLOCK_AGENT_DEVICE_URL` and `AGENT_DEVICE_DAEMON_AUTH_TOKEN`.
- Scenarios cannot cover desktop shell/IPC, Android, provider-specific protocol behavior (replay speaks generic ACP), or timing/perf regressions.
```

## Their script header (scripts/prove-scenario.ts)

```ts
#!/usr/bin/env node
// Runs one scenario with `e2e run` on a base and a head commit and says whether it fails on
// base and passes on head. See docs/internals/15_testing.md#scenarios.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { run, ScenarioError } from "./scenarios/shell.ts";

/** The parts of e2e's report.json (schema/report-v1.schema.json) a proof reads. */
const E2EReport = Schema.Struct({
  run: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        titlePath: Schema.Array(Schema.String),
        attempts: Schema.Array(
          Schema.Struct({
            status: Schema.optional(Schema.String),
            steps: Schema.Array(
              Schema.Struct({
                api: Schema.String,
                label: Schema.optional(Schema.String),
                status: Schema.String,
              }),
            ),
            error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
            artifacts: Schema.optional(
              Schema.Array(
                Schema.Struct({ kind: Schema.String, path: Schema.optional(Schema.String) }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});
type E2EReport = typeof E2EReport.Type;
const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(E2EReport));
const encodeProof = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export interface SideResult {
  readonly sha: string;
  /** `error`: the scenario could not run, which says nothing about the behavior. */
  readonly status: "passed" | "failed" | "error";
  readonly title: string;
  readonly message?: string;
  /**
   * For `error`, what stopped: `app` when the app did not start or no test ran, `scenario` when
   * the app ran and the scenario stopped before its assertion, such as on a control it did not find.
   */
  readonly stopped?: "app" | "scenario";
  readonly steps: ReadonlyArray<{ readonly step: string; readonly status: string }>;
  /** Capture paths under the run's results directory, in the order the scenario took them. */
  readonly captures: ReadonlyArray<string>;
  readonly videos: ReadonlyArray<string>;
}

/** Only a failed expectation shows the bug. A missing control or a dead app shows nothing. */
export function readSide(
  sha: string,
  resultsDir: string,
  report: E2EReport | undefined,
): SideResult {
  // The report also lists the tests the run did not select, with no attempts.
  const executed = report?.run.results.filter((candidate) => candidate.attempts.length > 0) ?? [];
  // One scenario is one test: with several, a pass in the first could hide a failure in another.
  const result = executed.length === 1 ? executed[0] : undefined;
  const attempt = result?.attempts.at(-1);
  if (result === undefined || attempt === undefined) {
    const message =
      executed.length > 1
        ? `the scenario file ran ${executed.length} tests; a proof needs exactly one`
        : "e2e wrote
```
