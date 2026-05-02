# Agent Connectors

How Compose dispatches work to AI agents through a uniform connector interface.

Compose dispatches work to AI agents through a connector abstraction. All connectors implement the same async generator interface yielding typed message envelopes.

## Message Envelope

```js
{ type: 'system',    subtype: 'init' | 'complete', agent: string, model?: string }
{ type: 'assistant', content: string }
{ type: 'tool_use',  tool: string, input: object }
{ type: 'tool_use_summary', summary: string }
{ type: 'tool_progress', tool: string, elapsed: number }
{ type: 'result',    content: string }
{ type: 'error',     message: string }
```

## ClaudeSDKConnector

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` function. Default model: `claude-sonnet-4-6` (override via `CLAUDE_MODEL` env var). Runs in `acceptEdits` permission mode with full `claude_code` tool access.

Key behaviors:
- Strips `CLAUDECODE` env var to allow spawning nested Claude Code sessions
- Normalizes SDK messages (assistant content blocks, tool_use, deltas) into the shared envelope
- Supports `interrupt()` to abort the active query
- Schema injection via `injectSchema()` for structured output

## CodexConnector

Spawns the official OpenAI `codex` CLI (`codex exec --json --skip-git-repo-check --sandbox read-only`), locked to OpenAI Codex models. Install via `npm i -g @openai/codex` (or `brew install codex`). Auth via `codex login` (ChatGPT OAuth) or `OPENAI_API_KEY` env var. Reasoning effort is passed via `-c model_reasoning_effort=<effort>` when the model ID carries a `/low|medium|high|xhigh` suffix.

Supported models: `gpt-5.4`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex`, `gpt-5.1-codex-mini` (with `/low`, `/medium`, `/high`, `/xhigh` effort suffixes). Default: `gpt-5.4` (override via `CODEX_MODEL` env var).

## OpencodeConnector

Model-agnostic base for any non-Anthropic agent running through the OpenCode SDK. Manages a singleton `opencode serve` subprocess (one per process, shared across instances). Creates sessions, sends prompts, and streams SSE events.

## AgentConnector (base class)

Abstract base with `run()`, `interrupt()`, and `isRunning`. Subclasses must implement `run()` as an async generator. Also exports `injectSchema(prompt, schema)` which appends JSON Schema instructions to prompts.

## Agent Registry

The build runner maps agent names to connector factories:

```
claude -> ClaudeSDKConnector
codex  -> CodexConnector
```

The connector factory is injectable for testing via `opts.connectorFactory`.
