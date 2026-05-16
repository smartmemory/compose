import { describe, it, expect } from 'vitest';
import { GitHubApi } from '../../lib/tracker/github-api.js';
import { makeGitHubFixture } from './fixtures/github-server.js';

describe('GitHubApi', () => {
  it('resolves token from configured env var', () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    expect(api.token).toBe('tok');
  });
  it('throws TrackerConfigError when token missing', () => {
    delete process.env.NOPE_MISSING_TOKEN;
    expect(() => new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'NOPE_MISSING_TOKEN' }, _noGhFallback: true }, makeGitHubFixture()))
      .toThrow(/token/i);
  });
  it('throws TrackerConfigError on bad repo shape', () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    expect(() => new GitHubApi({ repo: 'not-a-repo', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture()))
      .toThrow(/owner\/name|repo/i);
  });
  it('createIssue round-trips through transport', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    const issue = await api.createIssue({ title: '[X] d', body: 'b', labels: ['compose-feature'] });
    expect(issue.number).toBe(1);
    const got = await api.getIssue(1);
    expect(got.number).toBe(1);
    const found = await api.searchFeatureIssues();
    expect(found.length).toBe(1);
  });
  it('fixture parameterized by repo: acme/widgets round-trips independently', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const fx = makeGitHubFixture('acme/widgets');
    const api = new GitHubApi({ repo: 'acme/widgets', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, fx);
    const issue = await api.createIssue({ title: 'widget task', body: 'details', labels: [] });
    expect(issue.number).toBe(1);
    const got = await api.getIssue(1);
    expect(got.number).toBe(1);
    expect(got.title).toBe('widget task');
  });
  it('updateIssue patches title/body and bumps updated_at', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    const created = await api.createIssue({ title: 'orig', body: 'orig-body', labels: [] });
    expect(created.updated_at).toBe('t1');
    const updated = await api.updateIssue(1, { title: 'new-title', body: 'new-body' });
    expect(updated.title).toBe('new-title');
    expect(updated.body).toBe('new-body');
    expect(updated.updated_at).not.toBe('t1');
    const fetched = await api.getIssue(1);
    expect(fetched.title).toBe('new-title');
    expect(fetched.updated_at).toBe(updated.updated_at);
  });
  it('403 with no rate-limit headers is not misclassified as rate-limit', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    // Stub transport that returns a plain 403 with no rate-limit headers (auth failure shape).
    const stubTransport = {
      async request() { return { status: 403, body: { message: 'Bad credentials' }, headers: { get: () => null } }; },
    };
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, stubTransport);
    // Should NOT throw a rate-limit error — _req returns the response object as-is.
    const result = await api._req('GET', '/repos/o/r/issues/1');
    expect(result.status).toBe(403);
    expect(result.body.message).toBe('Bad credentials');
  });
});
