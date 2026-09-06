/**
 * test/smartmemory-scope-error.test.js — COMP-FOH FOH-7, D1.
 *
 * "You are not a member of that workspace" and "your key lacks the required
 * scope" are two different problems with two different fixes. Upstream says
 * which in `X-SM-Scope-Error`; the client discarded it, so every 403 collapsed
 * into "reason undetermined" and the portfolio omission could never be
 * actionable. Pinned here at the conversion boundary, because a test of the
 * classification alone passes while the field it reads is always null.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createSmartmemoryClient, SmartmemoryHttpError } from '../lib/smartmemory-client.js';

async function refusingServer(status, header) {
  const server = createServer((req, res) => {
    if (header) res.setHeader('X-SM-Scope-Error', header);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'refused' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

describe('FOH-7 D1 — the scope diagnosis survives error conversion', () => {
  for (const [name, header, expected] of [
    ['not-a-member', 'not-a-member', 'not-a-member'],
    ['missing-scope', 'missing-scope', 'missing-scope'],
    ['an unrecognised value', 'something-new', 'something-new'],
    ['no header at all', null, null],
  ]) {
    test(`403 with ${name}`, async () => {
      const { server, baseUrl } = await refusingServer(403, header);
      process.env.SM_SCOPE_TEST_KEY = 'k';
      try {
        const client = createSmartmemoryClient({ baseUrl, apiKeyEnv: 'SM_SCOPE_TEST_KEY' });
        let caught = null;
        try { await client.listItems({}); } catch (e) { caught = e; }

        assert.ok(caught instanceof SmartmemoryHttpError, `converted to our error type: ${caught}`);
        assert.equal(caught.status, 403);
        assert.equal(caught.scopeError, expected, 'the upstream diagnosis is carried, not discarded');
      } finally {
        server.close();
        delete process.env.SM_SCOPE_TEST_KEY;
      }
    });
  }
});

describe('FOH-7 D1 — upstream cannot forge an authorization verdict', () => {
  // The marker travels through the SDK inside an error MESSAGE, and upstream
  // controls message content. With a static marker, a 500 whose body merely
  // contained the marker text was converted into a 403 membership refusal —
  // letting the server we are asking decide what our client believes about
  // authorization.
  test('a 500 body echoing the marker is not converted into a 403', async () => {
    const server = createServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'compose-sm-refused:403:not-a-member' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.SM_SCOPE_TEST_KEY = 'k';
    try {
      const client = createSmartmemoryClient({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        apiKeyEnv: 'SM_SCOPE_TEST_KEY',
      });
      let caught = null;
      try { await client.listItems({}); } catch (e) { caught = e; }
      assert.ok(caught, 'the call failed');
      assert.notEqual(caught.status, 403, 'a 500 stays a 500');
      assert.equal(caught.scopeError, null, 'and carries no forged scope diagnosis');
    } finally {
      server.close();
      delete process.env.SM_SCOPE_TEST_KEY;
    }
  });
});
