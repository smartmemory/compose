# @smartmemory/compose-mcp

Slim MCP stdio launcher for [`@smartmemory/compose`](https://github.com/smartmemory/compose). Installing this package transitively pulls the full compose runtime; the `compose-mcp` binary spawns the embedded MCP server.

## Install

```bash
npm install -g @smartmemory/compose-mcp
```

This installs both `@smartmemory/compose-mcp` and its peer `@smartmemory/compose`.

## Run

```bash
npx -y @smartmemory/compose-mcp
```

The launcher resolves the embedded MCP server (`@smartmemory/compose/mcp`) and spawns it with stdio inheritance — suitable for direct Claude Code / MCP client wiring.

## Wire into Claude Code

Add an entry to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "compose": {
      "command": "npx",
      "args": ["-y", "@smartmemory/compose-mcp"]
    }
  }
}
```

Restart Claude Code; the typed compose tools (roadmap, changelog, artifact linking, journal, completion) become available.

## Project layout requirement

The MCP tools mutate canonical compose artifacts (`ROADMAP.md`, `CHANGELOG.md`, `docs/features/<code>/`, `docs/journal/`). Run `compose-mcp` from inside a compose-initialized project — see [the compose README](https://github.com/smartmemory/compose#readme) for `compose init`.

## Why a slim wrapper?

Discovery: published as `io.github.smartmemory/compose-mcp` on the [official MCP registry](https://registry.modelcontextprotocol.io). Installing the slim package keeps `npx` startup fast while the full runtime is fetched transitively.

## License

MIT — same as the compose root.
