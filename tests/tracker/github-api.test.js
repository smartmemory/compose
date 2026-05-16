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
});
