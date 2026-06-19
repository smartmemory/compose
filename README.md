# Compose

Compose is a CLI that drives a product idea from intent to shipped code. It runs YAML-defined multi-step pipelines on top of [Stratum](https://github.com/smartmemory/stratum), dispatching each step to an AI agent (Claude or Codex), checking postconditions, and pausing at human gates between phases. Output: a feature folder with design, blueprint, plan, code, tests, review trail, and an updated `ROADMAP.md` — auditable end-to-end.

![Compose Cockpit Shell](Screenshot.png)

## Pitch

- **Gates everywhere** — every phase transition (design, plan, ship) is approve/revise/kill. Human or Codex review at any point.
- **Stratum-backed** — pipelines are declarative `.stratum.yaml` specs with typed contracts, `ensure` postconditions, and retry/`on_fail` routing. Specs are editable.
- **Multi-agent** — Claude (via the Anthropic Agent SDK) and Codex (via the OpenAI CLI) plug in through a uniform connector interface; reviews can run on a different model than implementation.

## 30-second example

```bash
compose new "REST API for managing team todo lists"
  -> questionnaire (interactive)
  -> research (claude) -> brainstorm (claude)
  -> [gate] approve / revise / kill
  -> roadmap (claude) -> [gate] -> scaffold (claude)
  -> done: feature folders + ROADMAP.md ready

compose build TODO-1
  -> design (claude) -> [gate]
  -> blueprint (claude) -> verification (claude)
  -> plan (claude) -> [gate]
  -> decompose + parallel execute (worktree isolation)
  -> claude review lenses + codex review + coverage sweep
  -> docs + ship -> [gate]
  -> done: feature implemented, reviewed, tested, documented
```

## Quick install

Prerequisites: Node.js 18+ and `stratum-mcp` on PATH (`pip install stratum-mcp`, requires Python 3.11+). Codex steps additionally need the OpenAI `codex` CLI. Full prereqs in [docs/install.md](docs/install.md).

The package is published to npm as `@smartmemory/compose`. Pick one install style:

**Option A — npm (recommended for users):**

```bash
npm install -g @smartmemory/compose
compose setup                # install bundled skills + register stratum-mcp (alias: compose sync)
```

**Option B — git clone (for development):**

```bash
git clone https://github.com/smartmemory/compose.git && cd compose && npm install
npx @smartmemory/compose setup   # or: node bin/compose.js setup
ln -s "$(pwd)/bin/compose.js" ~/bin/compose && chmod +x ~/bin/compose   # optional: bare `compose` command
```

Then in your project:

```bash
cd /path/to/your/project
compose init                 # writes .compose/, registers MCP, scaffolds ROADMAP, pipeline specs, contracts/vocabulary.yaml
compose new "what you want to build"
```

Add an isolated feature to an existing project:

```bash
compose feature AUTH-1 "JWT middleware with refresh tokens"
compose build AUTH-1
```

## Upgrading

One command — auto-detects whether compose was installed via npm or git clone:

```bash
compose update
```

For npm installs, this runs `npm install -g @smartmemory/compose@latest`. For git clones, it runs `git pull --ff-only && npm install`. Either way it then refreshes the global skill and (if invoked from inside a Compose project) re-runs `compose init` to refresh `.mcp.json` and pipeline templates. Use `compose update --force` to bypass the dirty-tree check on git clones.

Check what you're running:

```bash
compose --version
```

## Bundled skills

`compose setup` (alias `compose sync`) mirrors compose-owned skills into your agent skill dirs (`~/.claude/skills/`, shared with Codex). Re-run it after a `compose update` or after editing skills locally — it's idempotent.

- **`/compose`** — the build/fix lifecycle orchestrator (idea → design → blueprint → implement; or triage → fix → verify).
- **`/context-budget`** — read-only audit of the session-start loaded surface (agents, skills, rules, MCP tool schemas, CLAUDE.md chain). Estimates per-component token cost, classifies each into always / sometimes / rarely needed, and prints a ranked cut list with estimated reclaim. Never auto-applies cuts.

`compose update` fetches a newer compose (npm or git) and then runs setup for you; use `compose sync` when there's no new version to pull — you just changed skills locally.

## Tracker providers

Compose can persist feature data to different backends via the `tracker` block in `.compose/compose.json`.

**Default (local) — zero configuration required:**

```json
{ "tracker": { "provider": "local" } }
```

`local` is the default when no `tracker` block is present. All writes go to the filesystem exactly as before — no behavior change.

**GitHub provider:**

```json
{
  "tracker": {
    "provider": "github",
    "github": {
      "repo": "owner/repo",
      "projectNumber": 42,
      "branch": "main",
      "roadmapPath": "ROADMAP.md",
      "changelogPath": "CHANGELOG.md",
      "cacheTtlSeconds": 300,
      "auth": { "tokenEnv": "GITHUB_TOKEN" }
    }
  }
}
```

The GitHub provider syncs features to **Issues** (one per feature), **Projects v2** (`Status` custom field), and **Contents API** (roadmap + changelog files). Requires a token in the named env var (or `gh auth login` fallback) with `repo` and `project` scopes.

CLI verbs:

```bash
compose tracker status   # show provider health + pending op-log + conflict ledger
compose tracker sync     # reconcile op-log against remote provider
```

See [docs/configuration.md](docs/configuration.md) for the full `tracker` config reference.

## Remote access (mobile PWA from anywhere)

The mobile cockpit at `/m` can be reached from outside localhost — bring your own tunnel, compose handles auth and pairing:

```bash
npm run build                                  # remote serves the built PWA from the API server
COMPOSE_REMOTE_AUTH=enabled compose start --host=0.0.0.0
compose remote pair --public-host=https://your-tunnel-host   # prints a QR — scan it with your phone
compose remote status                          # bind, devices, tunnel reachability
```

How it works: binding beyond `127.0.0.1` refuses to start unless `COMPOSE_REMOTE_AUTH=enabled` is set. In remote mode every request needs a credential — there is deliberately **no IP-based trust** (tunnel daemons connect from loopback). Phones pair once via QR (5-minute single-use code) and stay authenticated for 30 days through rotating refresh tokens + 15-minute access JWTs; reuse of a rotated refresh token revokes the device. Devices are listable and revocable (`compose remote list|revoke`, or the cockpit's "Pair mobile" modal). Only port 4001 needs to be exposed — agent-server traffic is proxied through it.

Tunnel layer is yours: Tailscale (serve/funnel), Cloudflare Tunnel, or a reverse proxy on your own VPS+domain all work — the last is the most reliable from restrictive networks (e.g. mainland China, where `trycloudflare.com`/ngrok domains are commonly blocked; plain TLS on 443 to an unremarkable domain travels best). Pair the device *before* traveling: pairing needs a live round-trip, while an already-paired phone only needs refresh.

`compose remote rotate-secret --yes` invalidates every paired device (post-leak hammer).

## Documentation

Topic-scoped reference:

- [docs/install.md](docs/install.md) — prerequisites, `compose init`, `compose setup`, `~/bin` symlink, `compose install` compatibility shim.
- [docs/cli.md](docs/cli.md) — every subcommand (`new`, `import`, `feature`, `build`, `pipeline`, `init`, `setup`, `doctor`, `start`).
- [docs/cockpit.md](docs/cockpit.md) — web UI shell: zones, graph view, context panel, ops strip, agent bar, persistence.
- [docs/pipelines.md](docs/pipelines.md) — kickoff and build pipelines, sub-flows, contracts, `on_fail` routing, Stratum IR v0.3.
- [docs/agents.md](docs/agents.md) — agent connectors, message envelope, Claude/Codex/Opencode connectors, registry.
- [docs/lifecycle.md](docs/lifecycle.md) — questionnaire, gate system, validation, recovery, progress logging, vision tracker, result normalization.
- [docs/configuration.md](docs/configuration.md) — `.compose/*.json`, pipeline specs, `.mcp.json`, `ROADMAP.md`, environment variables.
- [docs/mcp.md](docs/mcp.md) — MCP server tool list (vision, lifecycle, gates, iteration loops).
- [docs/examples.md](docs/examples.md) — worked workflows and the full `compose pipeline` editing reference.
- [docs/command-flows.md](docs/command-flows.md) — mermaid flow diagrams for every CLI verb (`build`, `fix`, `gsd`, `new`, `import`, `feature`, `roadmap`, `triage`, `qa-scope`, `pipeline`, `init`/`setup`/`update`/`doctor`).

### Specs and design

- [docs/PRD.md](docs/PRD.md)
- [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md)
- [docs/ROADMAP.md](docs/ROADMAP.md)
- [docs/taxonomy.md](docs/taxonomy.md)
- [docs/compose-one-pager.md](docs/compose-one-pager.md)
