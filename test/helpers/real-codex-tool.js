import { CodexConnector } from '../../../stratum/ts/dist/connectors/codex.js';

// Control SDK input only. The real connector creates every usage event, token
// split, duration, model/effort pair and price provenance consumed by Compose.
export function realCodexTool({ streamed = true, onResult, onCall } = {}) {
  return async ({ arguments: args }, _schema, request) => {
    onCall?.(args);
    let seq = 0;
    const producer = new CodexConnector({
      model: args.model ?? 'gpt-5.4', effort: args.effort ?? 'high', transport: 'sdk', env: {},
      sdkFactory: () => ({ startThread: () => ({ runStreamed: async () => ({
        events: (async function* () {
          yield { type: 'item.completed', item: { type: 'agent_message', text: '{"outcome":"complete","summary":"done"}' } };
          yield { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5, cached_input_tokens: 2, total_cost_usd: 0.2 } };
        })(),
      }) }) }),
      onEvent: event => {
        if (streamed) request.onprogress({ message: JSON.stringify({ schema_version: '0.2.8',
          step_id: '_agent_run', seq: seq++, ts: new Date().toISOString(), kind: event.kind,
          metadata: { ...event.metadata, stepId: '_agent_run' } }) });
      },
    });
    const result = await producer.run(args.prompt);
    onResult?.(result);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };
}
