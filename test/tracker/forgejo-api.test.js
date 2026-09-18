import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ForgejoApi, FORGEJO_BASE_URL } from '../../lib/tracker/forgejo-api.js';
import { TrackerConfigError } from '../../lib/tracker/provider.js';

class FakeTransport {
  constructor(response = { status: 200, body: {}, headers: new Headers() }) {
    this.response = response;
    this.calls = [];
  }

  async request(method, url, body, options) {
    this.calls.push({ method, url, body, options });
    return this.response;
  }
}

function makeApi(response) {
  const transport = new FakeTransport(response);
  const api = new ForgejoApi({
    repo: 'smartmemory/compose',
    baseUrl: FORGEJO_BASE_URL,
    auth: { token: 'forgejo-test-token' },
  }, transport);
  return { api, transport };
}

function expectedCall(method, path, body) {
  return {
    method,
    url: `${FORGEJO_BASE_URL}/api/v1${path}`,
    body,
  };
}

describe('ForgejoApi', () => {
  test('getIssueResult returns the status-bearing response', async () => {
    const response = { status: 200, body: { index: 17, state: 'open' }, headers: new Headers() };
    const { api, transport } = makeApi(response);

    assert.strictEqual(await api.getIssueResult(17), response);
    assert.deepEqual(transport.calls[0], {
      ...expectedCall('GET', '/repos/smartmemory/compose/issues/17', undefined),
      options: {
        headers: {
          Authorization: 'Bearer forgejo-test-token',
          Accept: 'application/json',
        },
        redirect: 'manual',
      },
    });
  });

  test('updateStateResult PATCHes only the requested state', async () => {
    const response = { status: 200, body: { index: 17, state: 'closed' }, headers: new Headers() };
    const { api, transport } = makeApi(response);

    assert.strictEqual(
      await api.updateStateResult(17, { state: 'closed', labels: ['must-not-leak'] }),
      response,
    );
    assert.deepEqual(transport.calls[0], {
      ...expectedCall('PATCH', '/repos/smartmemory/compose/issues/17', { state: 'closed' }),
      options: {
        headers: {
          Authorization: 'Bearer forgejo-test-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        redirect: 'manual',
      },
    });
  });

  test('addLabelResult uses the additive issue-label endpoint', async () => {
    const response = {
      status: 200,
      body: [{ id: 3, name: 'roadmap-tracked' }],
      headers: new Headers(),
    };
    const { api, transport } = makeApi(response);

    assert.strictEqual(await api.addLabelResult(17, 'roadmap-tracked'), response);
    assert.deepEqual(transport.calls[0], {
      ...expectedCall(
        'POST',
        '/repos/smartmemory/compose/issues/17/labels',
        { labels: ['roadmap-tracked'] },
      ),
      options: {
        headers: {
          Authorization: 'Bearer forgejo-test-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        redirect: 'manual',
      },
    });
  });

  test('listIssueComments returns the status-bearing response', async () => {
    const response = {
      status: 200,
      body: [{ id: 9, body: 'Already tracked' }],
      headers: new Headers(),
    };
    const { api, transport } = makeApi(response);

    assert.strictEqual(await api.listIssueComments(17), response);
    assert.deepEqual(transport.calls[0], {
      ...expectedCall('GET', '/repos/smartmemory/compose/issues/17/comments', undefined),
      options: {
        headers: {
          Authorization: 'Bearer forgejo-test-token',
          Accept: 'application/json',
        },
        redirect: 'manual',
      },
    });
  });

  test('addIssueComment posts a body and returns the status-bearing response', async () => {
    const response = {
      status: 201,
      body: { id: 10, body: 'Tracked as COMP-17' },
      headers: new Headers(),
    };
    const { api, transport } = makeApi(response);

    assert.strictEqual(await api.addIssueComment(17, 'Tracked as COMP-17'), response);
    assert.deepEqual(transport.calls[0], {
      ...expectedCall(
        'POST',
        '/repos/smartmemory/compose/issues/17/comments',
        { body: 'Tracked as COMP-17' },
      ),
      options: {
        headers: {
          Authorization: 'Bearer forgejo-test-token',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        redirect: 'manual',
      },
    });
  });

  test('all methods return non-2xx responses without throwing', async (t) => {
    const cases = [
      ['getIssueResult', (api) => api.getIssueResult(404)],
      ['updateStateResult', (api) => api.updateStateResult(404, { state: 'closed' })],
      ['addLabelResult', (api) => api.addLabelResult(404, 'roadmap-tracked')],
      ['listIssueComments', (api) => api.listIssueComments(404)],
      ['addIssueComment', (api) => api.addIssueComment(404, 'comment')],
    ];

    for (const [name, invoke] of cases) {
      await t.test(name, async () => {
        const response = {
          status: 422,
          body: { message: 'validation failed' },
          headers: new Headers(),
        };
        const { api } = makeApi(response);
        assert.strictEqual(await invoke(api), response);
      });
    }
  });

  test('rejects a base URL whose origin differs from the pinned Forgejo origin', () => {
    assert.throws(
      () => new ForgejoApi({
        repo: 'smartmemory/compose',
        baseUrl: 'https://attacker.example',
        auth: { token: 'forgejo-test-token' },
      }),
      (error) => {
        assert.ok(error instanceof TrackerConfigError);
        assert.match(error.message, /origin must be https:\/\/git\.smartmemory\.ai/);
        assert.deepEqual(error.detail, {
          expectedOrigin: 'https://git.smartmemory.ai',
          actualOrigin: 'https://attacker.example',
        });
        return true;
      },
    );
  });
});
