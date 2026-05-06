/**
 * Tests for lib/roadmap-preservers.js — three pure functions used by
 * lib/roadmap-gen.js to preserve curated content during typed-writer regen.
 *
 * COMP-MCP-MIGRATION-2-1-1 T1 (revised Option A).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  readPhaseOverrides,
  readAnonymousRows,
  readPreservedSections,
  readPreservedSectionAnchors,
} from '../lib/roadmap-preservers.js';

// ---------------------------------------------------------------------------
// readPhaseOverrides
// ---------------------------------------------------------------------------

describe('readPhaseOverrides', () => {
  test('extracts override text after em-dash from phase headings', () => {
    const text = `# Roadmap

## Phase 1: Setup — COMPLETE

intro

## Phase 4: Agent Connector (Read-Write) — PARTIAL

intro

## Phase 5: Standalone App — SUPERSEDED by STRAT-1
`;
    const overrides = readPhaseOverrides(text);
    assert.equal(overrides.get('Phase 1: Setup'), 'COMPLETE');
    assert.equal(overrides.get('Phase 4: Agent Connector (Read-Write)'), 'PARTIAL');
    assert.equal(overrides.get('Phase 5: Standalone App'), 'SUPERSEDED by STRAT-1');
  });

  test('handles parenthetical sub-status patterns', () => {
    const text = `## COMP-DESIGN: Interactive Design Conversation — PARTIAL (1a–1d COMPLETE, 2 PLANNED)

## SKILL-PD: Progressive Disclosure for Skills — PARKED (Claude Code dependency)

## COMP-OBS-SURFACE: Step Detail Surface — PARTIAL (SURFACE-4 complete; SURFACE-1/2/3 planned)
`;
    const overrides = readPhaseOverrides(text);
    assert.equal(
      overrides.get('COMP-DESIGN: Interactive Design Conversation'),
      'PARTIAL (1a–1d COMPLETE, 2 PLANNED)'
    );
    assert.equal(
      overrides.get('SKILL-PD: Progressive Disclosure for Skills'),
      'PARKED (Claude Code dependency)'
    );
    assert.equal(
      overrides.get('COMP-OBS-SURFACE: Step Detail Surface'),
      'PARTIAL (SURFACE-4 complete; SURFACE-1/2/3 planned)'
    );
  });

  test('returns empty Map when no headings present', () => {
    const overrides = readPhaseOverrides('# Just a title\n\nsome prose\n');
    assert.equal(overrides.size, 0);
  });

  test('headings without em-dash override produce no entry', () => {
    const text = `## Phase 1: Bare Heading

## Phase 2: With Status — COMPLETE
`;
    const overrides = readPhaseOverrides(text);
    assert.equal(overrides.has('Phase 1: Bare Heading'), false);
    assert.equal(overrides.get('Phase 2: With Status'), 'COMPLETE');
  });

  test('ignores headings inside fenced code blocks', () => {
    const text = `## Phase 1: Real — COMPLETE

\`\`\`markdown
## Phase 2: Fake — PARTIAL
\`\`\`

## Phase 3: Real — PLANNED
`;
    const overrides = readPhaseOverrides(text);
    assert.equal(overrides.size, 2);
    assert.equal(overrides.get('Phase 1: Real'), 'COMPLETE');
    assert.equal(overrides.get('Phase 3: Real'), 'PLANNED');
    assert.equal(overrides.has('Phase 2: Fake'), false);
  });
});

// ---------------------------------------------------------------------------
// readAnonymousRows
// ---------------------------------------------------------------------------

describe('readAnonymousRows', () => {
  test('captures anon rows with predecessorCode set to prior typed feature', () => {
    const text = `## Phase 1: Mixed

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FEAT-1 | First | COMPLETE |
| 2 | — | Anon row after FEAT-1 | COMPLETE |
| 3 | FEAT-2 | Third | COMPLETE |
`;
    const anon = readAnonymousRows(text);
    const rows = anon.get('Phase 1: Mixed') ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rawLine, '| 2 | — | Anon row after FEAT-1 | COMPLETE |');
    assert.equal(rows[0].predecessorCode, 'FEAT-1');
  });

  test('predecessorCode is null when anon row is at table head', () => {
    const text = `## Phase 0: Bootstrap

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | — | First-row anon | COMPLETE |
| 2 | FEAT-1 | First typed | COMPLETE |
`;
    const anon = readAnonymousRows(text);
    const rows = anon.get('Phase 0: Bootstrap') ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].predecessorCode, null);
  });

  test('multiple anon rows preserve relative order via predecessor chain', () => {
    const text = `## Phase 0: Multi

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | — | Anon 1 | COMPLETE |
| 2 | — | Anon 2 | COMPLETE |
| 3 | FEAT-1 | Typed | COMPLETE |
| 4 | — | Anon 3 | COMPLETE |
`;
    const anon = readAnonymousRows(text);
    const rows = anon.get('Phase 0: Multi') ?? [];
    assert.equal(rows.length, 3);
    assert.equal(rows[0].predecessorCode, null);   // anon 1 at head
    assert.equal(rows[1].predecessorCode, null);   // anon 2 also at head (no typed predecessor yet)
    assert.equal(rows[2].predecessorCode, 'FEAT-1'); // anon 3 after FEAT-1
  });

  test('returns empty Map when no anonymous rows present', () => {
    const text = `## Phase 1: Clean

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | FEAT-1 | First | COMPLETE |
`;
    const anon = readAnonymousRows(text);
    assert.equal(anon.size, 0);
  });

  test('3-column anonymous-form table (# | Item | Status)', () => {
    const text = `## Phase 0: Bootstrap

| # | Item | Status |
|---|------|--------|
| — | Discovery and PRD | COMPLETE |
| — | Terminal embed | COMPLETE |
`;
    const anon = readAnonymousRows(text);
    const rows = anon.get('Phase 0: Bootstrap') ?? [];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].predecessorCode, null);
    assert.equal(rows[1].predecessorCode, null);
    assert.equal(rows[0].rawLine, '| — | Discovery and PRD | COMPLETE |');
  });
});

// ---------------------------------------------------------------------------
// readPreservedSections
// ---------------------------------------------------------------------------

describe('readPreservedSections', () => {
  test('captures balanced markers byte-equal', () => {
    const text = `# Roadmap

<!-- preserved-section: roadmap-conventions -->
## Roadmap Conventions

- a
- b

<!-- /preserved-section -->

## Phase 1: Real
`;
    const preserved = readPreservedSections(text);
    assert.equal(preserved.size, 1);
    const raw = preserved.get('roadmap-conventions');
    assert.ok(raw.startsWith('<!-- preserved-section: roadmap-conventions -->'));
    assert.ok(raw.endsWith('<!-- /preserved-section -->'));
    assert.ok(raw.includes('## Roadmap Conventions'));
    assert.ok(raw.includes('- a\n- b'));
  });

  test('captures multiple preserved sections', () => {
    const text = `<!-- preserved-section: a -->
content A
<!-- /preserved-section -->

middle stuff

<!-- preserved-section: b -->
content B
<!-- /preserved-section -->
`;
    const preserved = readPreservedSections(text);
    assert.equal(preserved.size, 2);
    assert.ok(preserved.get('a').includes('content A'));
    assert.ok(preserved.get('b').includes('content B'));
    assert.ok(!preserved.get('a').includes('middle stuff'));
  });

  test('unbalanced markers (open without close) excluded', () => {
    const text = `<!-- preserved-section: orphan -->
content with no close
`;
    const preserved = readPreservedSections(text);
    assert.equal(preserved.size, 0);
  });

  test('ignores markers inside fenced code blocks', () => {
    const text = `<!-- preserved-section: real -->
real content
<!-- /preserved-section -->

\`\`\`markdown
<!-- preserved-section: fake -->
fake content
<!-- /preserved-section -->
\`\`\`
`;
    const preserved = readPreservedSections(text);
    assert.equal(preserved.size, 1);
    assert.ok(preserved.has('real'));
    assert.ok(!preserved.has('fake'));
  });

  test('returns empty Map when no markers present', () => {
    const preserved = readPreservedSections('## Just a phase\n\ncontent\n');
    assert.equal(preserved.size, 0);
  });
});

// ---------------------------------------------------------------------------
// readPreservedSectionAnchors
// ---------------------------------------------------------------------------

describe('readPreservedSectionAnchors', () => {
  test('section before any phase has null anchor', () => {
    const text = `# Roadmap

<!-- preserved-section: top -->
## Top
- a
<!-- /preserved-section -->

## Phase 1: Real
`;
    const anchors = readPreservedSectionAnchors(text);
    assert.equal(anchors.get('top'), null);
  });

  test('section after a phase anchors to the most recent phase heading', () => {
    const text = `## Phase 1: First — COMPLETE

content

## Phase 2: Second — COMPLETE

content

<!-- preserved-section: middle -->
## Middle Section
content
<!-- /preserved-section -->

## Phase 3: Third — PLANNED
`;
    const anchors = readPreservedSectionAnchors(text);
    assert.equal(anchors.get('middle'), 'Phase 2: Second');
  });

  test('multiple sections anchor to their respective preceding phases', () => {
    const text = `## A — COMPLETE

<!-- preserved-section: a-anchored -->
content
<!-- /preserved-section -->

## B — COMPLETE

<!-- preserved-section: b-anchored -->
content
<!-- /preserved-section -->
`;
    const anchors = readPreservedSectionAnchors(text);
    assert.equal(anchors.get('a-anchored'), 'A');
    assert.equal(anchors.get('b-anchored'), 'B');
  });

  test('phase headings inside preserved-section text do NOT advance anchor', () => {
    const text = `## P1

<!-- preserved-section: x -->
## Some Heading Inside Preserved
text
<!-- /preserved-section -->

<!-- preserved-section: y -->
content
<!-- /preserved-section -->
`;
    const anchors = readPreservedSectionAnchors(text);
    // y's anchor should still be P1, not "Some Heading Inside Preserved"
    assert.equal(anchors.get('x'), 'P1');
    assert.equal(anchors.get('y'), 'P1');
  });
});
