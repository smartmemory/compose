/**
 * Connect `client` inside test `t` without leaking it when `t` has already ended.
 *
 * A test that times out runs its after-hooks at once, but its body keeps going. A client
 * that finishes connecting after that point is never closed, and its child process keeps
 * the whole test file alive until --test-timeout kills it as an apparent hang
 * (build-cancel-unit under load, 2026-10-12). Register the close in t.after BEFORE calling
 * this; this closes the late connection itself. Works for StratumMcpClient and a raw MCP Client.
 */
export async function connectForTest(t, client, ...args) {
  await client.connect(...args);
  if (t.signal?.aborted) {
    await client.close();
    throw t.signal?.reason ?? Error('test ended while connecting');
  }
  return client;
}
