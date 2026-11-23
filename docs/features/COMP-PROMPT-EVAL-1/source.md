# COMP-PROMPT-EVAL-1: source notes from t3code

Source: pingdotgg/t3code @ f17114b2c2a2 (MIT), read 2026-11-23 by forge seat4 session.
These are notes on the source pattern, not a design. The clone is deleted, so the relevant text is quoted below. Reread the repo at the sha above for more.

## Their eval rules (evals/README.md)

# Evals

An eval runs a real model against T3 Code's real text or code and scores what the model does. Use one where a unit test cannot help: model output changes from run to run, and a small copy change can move it.

Write or run an eval when a change affects what a model sees or does: agent instructions, MCP tool descriptions and schemas, tool results, generated titles, or the guidance an agent gets for a feature such as Device Manager.

| Eval                                      | Measures                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [mcp-tool-use](mcp-tool-use/)             | Whether agents use T3's MCP tools correctly, including device routing and recovery, in fake threads. |
| [thread-titles](thread-titles/)           | Whether generated thread titles name the right subject.                                              |
| [pr-content](pr-content/)                 | Whether PR generation describes the diff when project instructions try to redirect it.               |
| [voice-cleanup](voice-cleanup/)           | Whether optional dictation cleanup edits only the spoken text and preserves its meaning.             |
| [test-signal](test-signal/)               | Whether a cheap model running the test-signal check flags low-signal tests.                          |
| [workflow-authoring](workflow-authoring/) | Whether a model writes a working workflow file from the `t3-workflows` skill alone.                  |

## Run an eval

1. Run `vp i` at the repo root.
2. Put the API keys the eval needs in the repo root `.env`. It is gitignored, and the eval scripts load it. Never print or commit a key.
3. From `evals/`, run `pnpm <eval> --out runs/<name>`. `runs/` is gitignored.

Each eval's README lists its models, flags, and cost. Start with one case and one sample to check the setup.

Evals call paid models, so CI does not run them. CI typechecks this package and runs the graders' unit tests.

## The shape of an eval

Every eval follows the same shape, so a new one is easy to write and an old one is easy to run.

- `evals/<eval>/run.ts` is the entry point. `package.json` has a script with the eval's name.
- `evals/<eval>/README.md` says what the eval measures, how to run it, how to add a case, and what a run costs.
- Cases are data, in `cases/` or `cases.ts`. Each case has an `id`, says where it came from (a PR, issue, or thread), and has its checks or rubric.
- The eval imports the code under test from source. Never copy prompts, tool descriptions, or schemas into an eval. Then the eval always tests the current text.
- Flags: `--out <dir>` (required), `--model <id>`, and `--baseline <earlier results>` to compare. Add `--case <ids>` when a full run is slow or costly.
- A run writes results rows to `--out`, plus a summary or review file for a person.
- When the eval grades itself, `run.test.ts` tests the grader, which is plain logic. It runs in CI. When a person grades, the run hides which output is new.

## Rules for cases

- A case reproduces a real bad experience, or guards a real good one. Name its source.
- Add the case before the fix. It must fail on the old text and pass on the new text.
- If you change a case, the changed case must still fail on the text it was written against. Prefer to fix T3 Code over loosening a case.
- Add controls: cases where the correct action is ordinary work. They catch a fix that overcorrects.
- Model output varies. Run each case several times. A case fails when half or more of its samples fail. Compare against a baseline on the same model, not against an absolute score.
- No user data in cases, fixtures, or templates. Use `/home/user` and `acme/app`. Read every captured fixture before you commit it.
- No unreleased model details in committed files, except model ids in an eval's model table.

## Cost

Run only the cases your change touches until they pass. Then do one full run per model before the PR merges. Each eval's summary records what the run cost.

## Add an eval

1. Copy the shape above from the closest eval.
2. Add a script to `package.json`, a README, and a row to the table above.
3. When a second eval needs code that one eval already has (model clients, the shell simulator, sampling, summaries), move that code to `evals/shared/` and use it from both. Do not build shared code before a second eval needs it.

## Example eval: test-signal (evals/test-signal/README.md)

# Test signal

Runs the Macroscope `test-signal` check ([`.macroscope/check-run-agents/test-signal.md`](../../.macroscope/check-run-agents/test-signal.md)) on real and synthetic test diffs, and checks that a cheap model flags low-signal tests and leaves good ones alone. Use it to cut the check to the fewest words that still work.

The model gets the check body, the PR's test diff, `read_file` and `grep` at the PR head, and `post_comment`. The wrapper prompt around the body is a stand-in for Macroscope's, which is not public.

## Run

```sh
cd evals
pnpm test-signal --out runs/baseline
pnpm test-signal --out runs/cut --prompt /path/to/variant.md --case new-table-row
```

- Models go through a CLIProxyAPI server, set up as the Codex model provider: `model_provider` in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) when it names a `[model_providers.<name>]` table, otherwise `[model_providers.vibeproxy]`. Set `[masked:line]<name>` to use another table, such as `vibeproxy` when your everyday `model_provider` is a different custom provider. That table needs `base_url` (the proxy's OpenAI-compatible URL, such as `http://localhost:8317/v1`) and a key in `experimental_bearer_token` or the variable named by `env_key`. Default models: `gpt-6.1-terra` and `gpt-6-luna`. Pass `--model` once per model to change them.
- Flags: `--prompt <file>` (a variant of the check, default the real one), `--case <id>` (repeatable), `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (default 6), `--reasoning <level>` (default `low`, as the check runs).
- A bad case passes when a comment lands inside a target test. A guard case passes when the check posts nothing and replies exactly `All clear`.
- `summary.md` gives the prompt hash and word count, then per model: bad cases caught, guards clean, errors, and tokens.
- Cost: proxy quota only, about 0.5M tokens for a full run on both models.

## Add a case

Add an entry to `cases.ts`. A `real` case names a merged commit and its test paths. A `synthetic` case inserts one test after an anchor string in a real file. Bad cases list the titles of the tests to flag.

## Related kill on our side

COMP-REVIEWER-EVAL-1 KILLED 2026-11-17 (reviewer benchmark product). This feature is narrower: it covers only the text our agents read, and starts with one eval.
