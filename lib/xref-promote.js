/** Forgejo issue promotion. No writes without apply === true; retries use persisted evidence. */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseRoadmap } from './roadmap-parser.js';
import { validateCode } from './feature-code.js';
import { addRoadmapEntry, getProvider, linkFeatures } from './feature-writer.js';
import { resolveFeaturesPath, resolveRoadmapPath } from './project-paths.js';
import { ForgejoApi, FORGEJO_BASE_URL } from './tracker/forgejo-api.js';

export const ACCEPTANCE_LABEL = 'Roadmap Tracked';

function checked(result, operation) {
  if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) {
    throw new Error(`${operation}: HTTP ${result?.status ?? 'unknown'}`);
  }
  return result.body;
}

async function readIssue(api, issue) {
  const body = checked(await api.getIssueResult(issue), 'read issue');
  if (body?.pull_request) throw new Error('Promotion refused: target is a pull request, not an issue');
  if (!body || typeof body.title !== 'string' || !Array.isArray(body.labels)
      || (body.body != null && typeof body.body !== 'string')) {
    throw new Error('Promotion refused: malformed issue response');
  }
  return body;
}

function readExisting(cwd, code, provenance) {
  const path = join(resolveFeaturesPath(cwd), code, 'feature.json');
  if (!existsSync(path)) return null;
  // Unlike readFeature, fail closed on corrupt JSON rather than treating it as absent.
  const feature = JSON.parse(readFileSync(path, 'utf8'));
  const from = feature?.promoted_from;
  if (feature?.code !== code || !from || Object.keys(provenance).some(k => from[k] !== provenance[k])) {
    throw new Error(`Promotion collision: ${code} already exists with absent or mismatched promoted_from`);
  }
  return feature;
}

async function hasComment(api, issue, marker) {
  let result = await api.listIssueComments(issue);
  const seen = new Set();
  for (;;) {
    const comments = checked(result, 'list issue comments');
    if (!Array.isArray(comments) || comments.some(c => typeof c?.body !== 'string')) {
      throw new Error('Malformed issue comments; refusing to post without an idempotency check');
    }
    if (comments.some(c => c.body.includes(marker))) return true;
    // T1 returns a single page. Follow only same-origin, same-issue pagination.
    const link = result.headers?.get?.('link') ?? result.headers?.link ?? result.headers?.Link ?? '';
    const next = link.split(',').find(part => /;\s*rel="?next"?(?:\s|;|$)/.test(part));
    if (!next) return false;
    const href = next.match(/<([^>]+)>/)?.[1];
    const url = new URL(href, FORGEJO_BASE_URL);
    const path = `/api/v1/repos/${api.repo}/issues/${issue}/comments`;
    if (!href || url.origin !== FORGEJO_BASE_URL || url.pathname !== path
        || url.username || url.password || seen.has(url.href) || seen.size >= 1000) {
      throw new Error('Unsafe or cyclic comment pagination; refusing to post');
    }
    seen.add(url.href);
    result = await api._req('GET', `${url.pathname.slice('/api/v1'.length)}${url.search}`);
  }
}

/**
 * Promote with real typed writers and an optionally injected Forgejo HTTP transport.
 * Returns a reviewable plan and ordered phase outcomes (planned/written/unchanged/failed).
 * Local failures throw with .promotion containing completed phases; remote failures
 * remain in errors, allowing the independent comment phase to proceed after label failure.
 */
export async function promoteIssue(cwd, opts = {}) {
  const { provider, repo, issue, code, phase } = opts;
  if (provider !== 'forgejo') throw new Error('promote-issue requires --provider forgejo');
  validateCode(code);
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('--issue must be a positive integer');
  if (typeof phase !== 'string' || !phase.trim() || /[\r\n\x00-\x1f\x7f]/.test(phase)) {
    throw new Error('--phase must be a nonempty single line');
  }
  const api = new ForgejoApi({ repo, auth: opts.forgejoAuth }, opts.forgejoTransport);
  const source = await readIssue(api, issue); // PR guard precedes all local work.
  const description = source.title.replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '').replace(/\s+/g, ' ').trim();
  if (!description) throw new Error('Promotion refused: empty normalized issue title');

  // Promotion keeps feature.json canonical. A remote canonical provider can write
  // during initialization; reject it before even constructing one in a dry-run.
  const configPath = join(cwd, '.compose', 'compose.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  if (config.tracker?.provider && config.tracker.provider !== 'local') {
    throw new Error('promote-issue requires a local canonical tracker');
  }
  const provenance = { provider, repo, issue };
  let existing = readExisting(cwd, code, provenance);
  const link = { kind: 'external', ...provenance, push: true, derive_expect: true, expect_labels: [ACCEPTANCE_LABEL] };
  const marker = `<!-- compose-promotion:${code} -->`;
  const roadmap = relative(cwd, resolveRoadmapPath(cwd)).split('\\').join('/');
  const comment = `Accepted onto the roadmap as **${code}**. Track progress in \`${roadmap}\` (feature \`${code}\`).\n\n${marker}`;
  const apply = opts.apply === true;
  const result = {
    ok: true, apply, code,
    plan: { feature: { code, phase, description, status: 'PLANNED', promoted_from: provenance, notes: source.body ?? '' }, link, label: ACCEPTANCE_LABEL, comment },
    phases: [], errors: [],
  };
  const record = (phase, changed) => result.phases.push({ phase, status: changed ? (apply ? 'written' : 'planned') : 'unchanged' });
  let localPhase = 'feature';
  try {
    const needsCreate = !existing;
    const needsNotes = !existing || !Object.hasOwn(existing, 'notes');
    const roadmapPath = resolveRoadmapPath(cwd);
    const needsRoadmap = Boolean(existing) && (!existsSync(roadmapPath)
      || !parseRoadmap(readFileSync(roadmapPath, 'utf8')).some(row => row.code === code));
    if (apply) {
      if (needsCreate) await addRoadmapEntry(cwd, result.plan.feature);
      existing = readExisting(cwd, code, provenance);
      if (needsRoadmap) await (await getProvider(cwd)).renderRoadmap();
      if (needsNotes) {
        const local = await getProvider(cwd);
        await local.putFeature(code, { ...existing, notes: source.body ?? '' });
        existing = readExisting(cwd, code, provenance);
      }
    }
    record('feature', needsCreate || needsNotes || needsRoadmap);
    localPhase = 'link';
    const attached = existing?.links?.find(l => l.kind === 'external' && l.provider === provider && l.repo === repo && l.issue === issue);
    // Do not silently declare a changed/disabled link complete or overwrite user intent.
    if (attached && (attached.push !== true || attached.derive_expect !== true || !attached.expect_labels?.includes(ACCEPTANCE_LABEL))) {
      throw new Error('Promotion link exists with conflicting intent; refusing to overwrite');
    }
    if (apply && !attached) await linkFeatures(cwd, { from_code: code, ...link });
    record('link', !attached);
  } catch (error) {
    result.ok = false;
    result.errors.push({ phase: localPhase, reason: error.message });
    result.phases.push({ phase: localPhase, status: 'failed', featurePersisted: existsSync(join(resolveFeaturesPath(cwd), code, 'feature.json')) });
    error.promotion = result;
    throw error;
  }
  for (const phaseName of ['label', 'comment']) {
    try {
      let missing;
      if (phaseName === 'label') {
        const live = await readIssue(api, issue); // fresh labels, never replace a human's set
        missing = !live.labels.some(l => (typeof l === 'string' ? l : l?.name) === ACCEPTANCE_LABEL);
        if (apply && missing) checked(await api.addLabelResult(issue, ACCEPTANCE_LABEL), 'add acceptance label');
      } else {
        missing = !(await hasComment(api, issue, marker));
        if (apply && missing) checked(await api.addIssueComment(issue, comment), 'post acceptance comment');
      }
      record(phaseName, missing);
    } catch (error) {
      result.ok = false;
      result.errors.push({ phase: phaseName, reason: error.message });
      result.phases.push({ phase: phaseName, status: 'failed' });
    }
  }
  return result;
}
