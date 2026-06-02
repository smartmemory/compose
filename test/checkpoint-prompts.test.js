/**
 * COMP-RESUME S6 + S11-render — pure string functions.
 *
 * scribePrompt / reconcilePrompt build agent prompts; renderCheckpoint renders
 * a checkpoint to markdown for human inspection. All pure: no fs/git/network.
 *
 * Spec: docs/features/COMP-RESUME/blueprint.md (S6, S11-render),
 *       design.md Decisions 1, 2, 4, 5.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scribePrompt, reconcilePrompt } from '../lib/checkpoint/prompts.js';
import { renderCheckpoint } from '../lib/checkpoint/render.js';

const SAMPLE_FINGERPRINT = {
  capturedAt: '2026-06-02T10:00:00.000Z',
  git: {
    head: 'abc1234def5678901234567890abcdef12345678',
    branch: 'comp-resume',
    dirty: true,
    dirtyHash: 'deadbeefcafebabe',
  },
  phaseArtifacts: {
    design: 'docs/features/COMP-RESUME/design.md',
    blueprint: 'docs/features/COMP-RESUME/blueprint.md',
    plan: null,
    implementFiles: ['lib/checkpoint/prompts.js'],
    contracts: ['contracts/checkpoint.schema.json'],
  },
  testRef: '.compose/data/test-output-latest.txt',
  buildStreamSeq: 42,
  flowId: 'flow-xyz',
};

const PRIOR_CHECKPOINT = {
  id: 'cp-prior',
  featureCode: 'COMP-RESUME',
  phase: 'implement',
  createdAt: '2026-06-02T09:00:00.000Z',
  trigger: 'phase-transition',
  fingerprint: SAMPLE_FINGERPRINT,
  soft: {
    goal: 'Ship the checkpoint prompt builders',
    nextStep: 'Implement reconcilePrompt next',
    risks: ['scribe may hallucinate verdicts'],
  },
};

describe('scribePrompt', () => {
  it('instructs the agent to return ONLY a JSON object with the soft fields', () => {
    const out = scribePrompt({ fingerprint: SAMPLE_FINGERPRINT });
    assert.equal(typeof out, 'string');
    // return-only-JSON instruction
    assert.match(out, /ONLY/);
    assert.match(out, /JSON/);
    // the exact soft shape must be described
    assert.match(out, /"goal"/);
    assert.match(out, /"nextStep"/);
    assert.match(out, /"risks"/);
    // "nothing else" style guard
    assert.match(out, /nothing else/i);
  });

  it('forbids asserting results/verdicts and points at the fingerprint testRef instead', () => {
    const out = scribePrompt({ fingerprint: SAMPLE_FINGERPRINT });
    // anti-verdict instruction
    assert.match(out, /do NOT claim tests pass/i);
    assert.match(out, /testRef/);
    // every factual claim must reference a fingerprint anchor
    assert.match(out, /anchor/i);
  });

  it('interpolates the fingerprint git head, branch and dirty flag', () => {
    const out = scribePrompt({ fingerprint: SAMPLE_FINGERPRINT });
    assert.match(out, /abc1234def5678901234567890abcdef12345678/);
    assert.match(out, /comp-resume/);
    // dirty flag surfaced
    assert.match(out, /dirty/i);
  });

  it('interpolates the priorCheckpoint goal and nextStep when present', () => {
    const out = scribePrompt({
      fingerprint: SAMPLE_FINGERPRINT,
      priorCheckpoint: PRIOR_CHECKPOINT,
    });
    assert.match(out, /Ship the checkpoint prompt builders/);
    assert.match(out, /Implement reconcilePrompt next/);
  });

  it('interpolates the journalTail when provided', () => {
    const out = scribePrompt({
      fingerprint: SAMPLE_FINGERPRINT,
      journalTail: 'JOURNAL_TAIL_SENTINEL_LINE',
    });
    assert.match(out, /JOURNAL_TAIL_SENTINEL_LINE/);
  });

  it('omits the prior-checkpoint section gracefully when priorCheckpoint is null', () => {
    const out = scribePrompt({ fingerprint: SAMPLE_FINGERPRINT, priorCheckpoint: null });
    assert.equal(typeof out, 'string');
    // should not blow up or render "undefined"/"null" goal text
    assert.doesNotMatch(out, /undefined/);
  });
});

describe('reconcilePrompt', () => {
  const STALE = PRIOR_CHECKPOINT;
  const LIVE = {
    ...SAMPLE_FINGERPRINT,
    git: {
      head: 'fff9999000111222333444555666777888999aaa',
      branch: 'comp-resume',
      dirty: false,
      dirtyHash: null,
    },
  };

  it('states the environment is ground truth and the checkpoint is advisory', () => {
    const out = reconcilePrompt({ staleCheckpoint: STALE, liveFingerprint: LIVE });
    assert.equal(typeof out, 'string');
    assert.match(out, /ground truth/i);
    assert.match(out, /advisory/i);
  });

  it('instructs returning ONLY JSON with soft, confidence (0..1) and resumeAction', () => {
    const out = reconcilePrompt({ staleCheckpoint: STALE, liveFingerprint: LIVE });
    assert.match(out, /ONLY/);
    assert.match(out, /JSON/);
    assert.match(out, /"soft"/);
    assert.match(out, /"confidence"/);
    assert.match(out, /"resumeAction"/);
    // confidence range described
    assert.match(out, /0\b.*1\b/);
  });

  it('interpolates the stale checkpoint goal and the live fingerprint head', () => {
    const out = reconcilePrompt({ staleCheckpoint: STALE, liveFingerprint: LIVE });
    // stale checkpoint intent
    assert.match(out, /Ship the checkpoint prompt builders/);
    // live fingerprint head (env ground truth)
    assert.match(out, /fff9999000111222333444555666777888999aaa/);
  });

  it('interpolates the env scan and asks to reconcile divergence + lower confidence when uncertain', () => {
    const out = reconcilePrompt({
      staleCheckpoint: STALE,
      liveFingerprint: LIVE,
      envScan: 'ENV_SCAN_SENTINEL',
    });
    assert.match(out, /ENV_SCAN_SENTINEL/);
    assert.match(out, /diverg/i);
    assert.match(out, /lower.*confidence/i);
  });
});

describe('renderCheckpoint', () => {
  it('renders a heading with featureCode, phase and createdAt', () => {
    const md = renderCheckpoint(PRIOR_CHECKPOINT);
    assert.equal(typeof md, 'string');
    assert.match(md, /^#/m); // a markdown heading
    assert.match(md, /COMP-RESUME/);
    assert.match(md, /implement/);
    assert.match(md, /2026-06-02T09:00:00\.000Z/);
  });

  it('renders the Intent section with goal/nextStep/risks for a narrative checkpoint', () => {
    const md = renderCheckpoint(PRIOR_CHECKPOINT);
    assert.match(md, /Intent/);
    assert.match(md, /Ship the checkpoint prompt builders/);
    assert.match(md, /Implement reconcilePrompt next/);
    assert.match(md, /scribe may hallucinate verdicts/);
  });

  it('renders the anchor marker when soft is null', () => {
    const anchor = { ...PRIOR_CHECKPOINT, soft: null };
    const md = renderCheckpoint(anchor);
    assert.match(md, /\(anchor — no narrative\)/);
    // must not leak narrative text
    assert.doesNotMatch(md, /Ship the checkpoint prompt builders/);
  });

  it('renders an Environment section with short git head, branch, dirty flag and present artifacts', () => {
    const md = renderCheckpoint(PRIOR_CHECKPOINT);
    assert.match(md, /Environment/);
    // short head (first 7+ chars of the sha), full sha not required
    assert.match(md, /abc1234/);
    assert.match(md, /comp-resume/);
    assert.match(md, /dirty/i);
    // present phaseArtifacts surfaced
    assert.match(md, /design\.md/);
    assert.match(md, /checkpoint\.schema\.json/);
  });

  it('renders a confidence line when present', () => {
    const synced = { ...PRIOR_CHECKPOINT, confidence: 0.42 };
    const md = renderCheckpoint(synced);
    assert.match(md, /[Cc]onfidence/);
    assert.match(md, /0\.42/);
  });

  it('omits the confidence line when not present', () => {
    const md = renderCheckpoint(PRIOR_CHECKPOINT);
    assert.doesNotMatch(md, /[Cc]onfidence/);
  });
});
