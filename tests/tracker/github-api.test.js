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
  it('addIssueComment then listIssueComments round-trips', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    await api.createIssue({ title: 'test', body: 'b', labels: [] });
    const comment = await api.addIssueComment(1, '<!--compose-event {"type":"status"}-->');
    expect(comment.id).toBe(1);
    expect(comment.body).toBe('<!--compose-event {"type":"status"}-->');
    const list = await api.listIssueComments(1);
    expect(list).toHaveLength(1);
    expect(list[0].body).toBe('<!--compose-event {"type":"status"}-->');
  });
  it('graphql returns {data, errors} envelope', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    const result = await api.graphql('mutation updateProjectV2ItemFieldValue($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }', { input: { projectId: 'P1', itemId: 'IT1', fieldId: 'F1', value: { singleSelectOptionId: 'O_PLANNED' } } });
    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.updateProjectV2ItemFieldValue?.projectV2Item?.id).toBe('IT1');
    expect(result.errors).toBeUndefined();
  });
  it('graphql surfaces errors array from GraphQL semantic errors', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    const result = await api.graphql('query { anything }', { __forceError: true });
    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toBe('boom');
    expect(result.data).toBeUndefined();
  });
  it('getContents 404 returns { text: "", sha: null }', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, makeGitHubFixture());
    const result = await api.getContents('ROADMAP.md', 'main');
    expect(result).toEqual({ text: '', sha: null });
  });
  it('getContents returns text and sha for an existing file', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const fixture = makeGitHubFixture();
    fixture.setFile('ROADMAP.md', '# Roadmap\n\nHello world\n');
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, fixture);
    const result = await api.getContents('ROADMAP.md', 'main');
    expect(result.text).toBe('# Roadmap\n\nHello world\n');
    expect(typeof result.sha).toBe('string');
    expect(result.sha).toBeTruthy();
  });
  it('putContents create then update round-trips correctly', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const fixture = makeGitHubFixture();
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, fixture);
    // Create: sha=null
    await api.putContents('CHANGELOG.md', '# Changelog\n', { sha: null, branch: 'main', message: 'init' });
    expect(fixture.getFile('CHANGELOG.md')).toBe('# Changelog\n');
    // Update with current sha
    const { sha } = await api.getContents('CHANGELOG.md', 'main');
    await api.putContents('CHANGELOG.md', '# Changelog\n\n## v1\n', { sha, branch: 'main', message: 'update' });
    expect(fixture.getFile('CHANGELOG.md')).toBe('# Changelog\n\n## v1\n');
  });
  it('putContents with stale sha throws with shaConflict = true', async () => {
    process.env.CTP_TEST_TOKEN = 'tok';
    const fixture = makeGitHubFixture();
    fixture.setFile('ROADMAP.md', '# Roadmap\n');
    const api = new GitHubApi({ repo: 'o/r', auth: { tokenEnv: 'CTP_TEST_TOKEN' } }, fixture);
    // Write with the correct sha first to advance the file
    const { sha: currentSha } = await api.getContents('ROADMAP.md', 'main');
    await api.putContents('ROADMAP.md', '# Roadmap updated\n', { sha: currentSha, branch: 'main', message: 'update' });
    // Now try to put with the OLD sha — should conflict
    let err;
    try {
      await api.putContents('ROADMAP.md', '# Roadmap stale\n', { sha: currentSha, branch: 'main', message: 'stale' });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.shaConflict).toBe(true);
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
