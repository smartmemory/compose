/**
 * github-integration.test.js
 *
 * Integration tests that drive PRODUCTION entry points (writers) with a
 * GitHub-configured project via the fixture transport injected through
 * factory.setTestTransport().
 *
 * These tests exercise the SEAM — not the provider directly — so they
 * would have FAILED before the fixes in this branch:
 *   - FIX A: GitHubProvider.getChangelog / putChangelog did not exist →
 *     changelog-writer would throw NotImplemented when calling those methods.
 *   - FIX B: safeAppendEvent routed through feature-events.js directly →
 *     no <!--compose-event--> comments on issues, no Projects v2 mirror.
 *   - FIX D: factory.setTestTransport() did not exist → could not inject
 *     fixture transport without modifying production config loading.
 *
 * Test-transport injection mechanism:
 *   factory.setTestTransport(fixture) injects a fixture transport that
 *   providerFor() merges into cfg.github when building GitHubProvider.
 *   This is a module-level hook — test-only, documented in factory.js,
 *   has ZERO effect in production (undefined by default).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { setTestTransport, clearTestTransport } from '../../lib/tracker/factory.js';
import { makeGitHubFixture } from './fixtures/github-server.js';

// Production entry points under test
import { addRoadmapEntry, setFeatureStatus } from '../../lib/feature-writer.js';
import { recordCompletion } from '../../lib/completion-writer.js';
import { addChangelogEntry } from '../../lib/changelog-writer.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const REPO = 'o/r';

/**
 * Create a temp project directory configured for the github tracker.
 * Returns { cwd, fixture } — fixture is the in-process recorder.
 */
function makeGitHubProject() {
  process.env.CTP_TEST_TOKEN = 'tok';

  const cwd = mkdtempSync(join(tmpdir(), 'ctp-integ-'));
  mkdirSync(join(cwd, '.compose'), { recursive: true });

  const trackerConfig = {
    tracker: {
      provider: 'github',
      github: {
        repo: REPO,
        projectNumber: 1,
        branch: 'main',
        auth: { tokenEnv: 'CTP_TEST_TOKEN' },
      },
    },
  };
  writeFileSync(join(cwd, '.compose/compose.json'), JSON.stringify(trackerConfig, null, 2));

  const fixture = makeGitHubFixture(REPO);
  setTestTransport(fixture);

  return { cwd, fixture };
}

function cleanup(cwd) {
  clearTestTransport();
  rmSync(cwd, { recursive: true, force: true });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('GitHub integration: production seam — would have FAILED pre-fix', () => {
  let cwd;
  let fixture;

  beforeEach(() => {
    ({ cwd, fixture } = makeGitHubProject());
  });

  afterEach(() => {
    cleanup(cwd);
  });

  // ── FIX A: changelog low-level primitives ────────────────────────────────

  it('addChangelogEntry (production fn) round-trips to remote CHANGELOG.md (proves FIX A)', async () => {
    // Pre-fix: provider.getChangelog() threw NotImplementedError on GitHubProvider
    // → addChangelogEntry was dead-on-arrival under provider:"github".
    // Post-fix: GitHubProvider implements getChangelog/putChangelog → works.
    await addChangelogEntry(cwd, {
      code: 'TEST-CL',
      date_or_version: '2026-05-17',
      summary: 'integration test entry',
      sections: { added: ['A changelog via the production seam'] },
    });

    // The fixture should now have the remote CHANGELOG.md populated.
    const remote = fixture.getFile('CHANGELOG.md');
    expect(remote).not.toBeNull();
    expect(remote).toContain('### TEST-CL');
    expect(remote).toContain('integration test entry');
    expect(remote).toContain('A changelog via the production seam');
  });

  it('second addChangelogEntry call is idempotent on remote (proves FIX A atomicity)', async () => {
    await addChangelogEntry(cwd, {
      code: 'TEST-IDEM',
      date_or_version: '2026-05-17',
      summary: 'idempotent test',
    });

    const firstContent = fixture.getFile('CHANGELOG.md');
    expect(firstContent).toContain('### TEST-IDEM');

    // Second call with same code+date → should be a no-op (not duplicate the entry).
    const result = await addChangelogEntry(cwd, {
      code: 'TEST-IDEM',
      date_or_version: '2026-05-17',
      summary: 'idempotent test',
    });
    expect(result.idempotent).toBe(true);

    // File should not have changed (idempotent).
    const secondContent = fixture.getFile('CHANGELOG.md');
    expect(secondContent).toBe(firstContent);
  });

  // ── FIX B: event routing through provider.appendEvent ────────────────────

  it('setFeatureStatus posts <!--compose-event--> comment on issue (proves FIX B)', async () => {
    // First scaffold a feature via addRoadmapEntry (also exercises production seam).
    await addRoadmapEntry(cwd, {
      code: 'TEST-EVT',
      description: 'event routing test',
      phase: 'P1',
    });

    // Now flip status via the production setFeatureStatus.
    // Pre-fix: event was written to local feature-events.jsonl only — no GitHub comment.
    // Post-fix: routes through provider.appendEvent → _postEvent → issue comment.
    await setFeatureStatus(cwd, {
      code: 'TEST-EVT',
      status: 'IN_PROGRESS',
    });

    // Find the issue (first created issue in fixture).
    const issue = fixture._issues.get(1);
    expect(issue).toBeDefined();

    const comments = fixture._comments.get(issue.number) ?? [];
    const eventComments = comments.filter(c => c.body.includes('<!--compose-event'));
    expect(eventComments.length).toBeGreaterThan(0);

    // The status event comment should have set_feature_status tool and from/to.
    const statusComment = eventComments.find(c => c.body.includes('set_feature_status'));
    expect(statusComment).toBeDefined();
    expect(statusComment.body).toContain('IN_PROGRESS');
  });

  it('setFeatureStatus mirrors status to Projects v2 (proves FIX B Projects v2 path)', async () => {
    await addRoadmapEntry(cwd, {
      code: 'TEST-PV2',
      description: 'projects v2 test',
      phase: 'P1',
    });

    await setFeatureStatus(cwd, {
      code: 'TEST-PV2',
      status: 'IN_PROGRESS',
    });

    // The fixture should have recorded a Projects v2 field update.
    expect(fixture._projectUpdates.length).toBeGreaterThan(0);
    const update = fixture._projectUpdates[fixture._projectUpdates.length - 1];
    expect(update).toMatchObject({
      projectId: 'P1',
      fieldId: 'F1',
    });
    // The singleSelectOptionId should correspond to IN_PROGRESS option.
    expect(update.value?.singleSelectOptionId).toBe('O_IN_PROGRESS');
  });

  it('recordCompletion posts completion event comment on issue (proves FIX B completion path)', async () => {
    await addRoadmapEntry(cwd, {
      code: 'TEST-REC',
      description: 'completion event test',
      phase: 'P1',
    });

    // Pre-fix: recordCompletion's audit event went to local file only.
    // Post-fix: routes through provider.appendEvent → issue comment.
    await recordCompletion(cwd, {
      feature_code: 'TEST-REC',
      commit_sha: 'a'.repeat(40),
      tests_pass: true,
      files_changed: [],
      set_status: false, // avoid status flip to keep test focused
    });

    const issue = fixture._issues.get(1);
    expect(issue).toBeDefined();

    const comments = fixture._comments.get(issue.number) ?? [];
    const eventComments = comments.filter(c => c.body.includes('<!--compose-event'));
    expect(eventComments.length).toBeGreaterThan(0);

    const completionComment = eventComments.find(c => c.body.includes('record_completion'));
    expect(completionComment).toBeDefined();
  });

  // ── FIX A + B combined: addRoadmapEntry produces issue + ROADMAP + event ──

  it('addRoadmapEntry creates issue and pushes ROADMAP.md to remote', async () => {
    const result = await addRoadmapEntry(cwd, {
      code: 'TEST-RME',
      description: 'roadmap entry test',
      phase: 'P1',
    });

    expect(result.code).toBe('TEST-RME');

    // Issue should have been created in fixture.
    expect(fixture._issues.size).toBeGreaterThanOrEqual(1);
    const issue = [...fixture._issues.values()].find(i => i.title.includes('TEST-RME'));
    expect(issue).toBeDefined();

    // ROADMAP.md should be in the fixture remote.
    const roadmap = fixture.getFile('ROADMAP.md');
    expect(roadmap).not.toBeNull();
    expect(roadmap).toContain('TEST-RME');
  });
});
