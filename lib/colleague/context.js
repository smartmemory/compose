/**
 * lib/colleague/context.js — COMP-FOH FOH-6 S2: the per-turn channel_context
 * composer, and the FIRST PRODUCTION CONSUMER of the FOH-3/4/5 capabilities
 * (`challengeIdea`, `convictionOf`, `contradictionsOf` had zero production
 * call sites until here — an acceptance criterion, not a side effect).
 *
 * Compose does the memory reasoning; Maya gets the findings as per-turn
 * `channel_context: [{author, text}]` blocks with explicit provenance authors
 * (`compose:idea IDEA-42`, `compose:conviction`, …). Contracts (design §3):
 *
 *   - Sections are DECLARED-capability-derived (`provider.has(CAP.X)`).
 *     Absence is structural (the panel's capability strip owns it), not an
 *     omission.
 *   - Findings are fetched CONCURRENTLY with a per-capability deadline; a
 *     section that fails is omitted AND NAMED — never a turn failure, and
 *     never a silent hole.
 *   - Maya token-caps the block upstream (CHANNEL_CONTEXT_MAX_TOKENS), so the
 *     composer enforces its own priority BEFORE sending: contradictions >
 *     conviction > challenge > record body (truncated to headline first) >
 *     discussion (dropped first). Every drop is named in `omissions`, so the
 *     owner never mistakes a truncated turn for a clean one.
 */

import {
  findIdea, challengeIdea, convictionOf, contradictionsOf, IdeaboxNotFound,
} from '../fluid/ideabox-ops.js';
import { CAP, KIND } from '../fluid/provider.js';

/** Sum small enough that the priority sections survive Maya's own token cap. */
export const DEFAULT_BYTE_BUDGET = 8000;
/** Safety net over the client-level deadlines (challenge's LLM path caps at 30s). */
export const CAPABILITY_TIMEOUT_MS = 35000;

const MAX_CONTRADICTIONS = 5;
const MAX_CONFLICTS = 5;
const MAX_DISCUSSION = 5;
const MAX_HISTORY = 3;
const MAX_CORPUS_IDEAS = 10;

const bytes = (block) => Buffer.byteLength(block.author) + Buffer.byteLength(block.text);

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function headline(idea) {
  const bits = [`status: ${idea.status ?? 'open'}`];
  if (idea.priority) bits.push(`priority: ${idea.priority}`);
  return `[${idea.handle}] ${idea.title} (${bits.join(', ')})`;
}

function recordText(idea) {
  const body = String(idea.body ?? '').trim();
  return body ? `${headline(idea)}\n${body}` : headline(idea);
}

function convictionText(idea, c) {
  const recent = (c.history ?? []).slice(-MAX_HISTORY).map((h) =>
    `"${h.conflictingFact ?? 'unrecorded fact'}" (${h.oldConfidence}→${h.newConfidence}, ${h.reason})`,
  );
  const head = `Conviction for ${idea.handle}: confidence ${c.confidence}`
    + ` (challenged ${c.challengeCount}x${c.lastChallengedAt ? `, last ${c.lastChallengedAt}` : ''})`;
  return recent.length ? `${head}. Recent decays: ${recent.join('; ')}` : head;
}

function contradictionsText(idea, hits) {
  const shown = hits.slice(0, MAX_CONTRADICTIONS);
  const lines = shown.map((h) => `[${h.handle}] ${h.record?.title ?? ''} — ${String(h.record?.body ?? '').slice(0, 200)}`);
  return `Records contradicting ${idea.handle} (${hits.length}):\n${lines.join('\n')}`;
}

function challengeText(idea, result) {
  if (!result.conflicts?.length) return `Challenge scan for ${idea.handle}: no conflicts detected.`;
  const shown = result.conflicts.slice(0, MAX_CONFLICTS);
  const lines = shown.map((c, i) =>
    `${i + 1}. [${c.handle}] (${c.conflictType}, confidence ${c.confidence}): ${c.explanation}`
    + ` — suggests ${c.suggestedResolution}`,
  );
  return `Challenge scan for ${idea.handle}: ${result.conflicts.length} conflict(s).\n${lines.join('\n')}`;
}

function discussionText(idea) {
  const recent = (idea.discussion ?? []).slice(-MAX_DISCUSSION);
  if (!recent.length) return null;
  const lines = recent.map((d) => `- [${d.author ?? 'unattributed'}${d.ts ? ` @ ${d.ts}` : ''}] ${d.text}`);
  return `Recent discussion on ${idea.handle}:\n${lines.join('\n')}`;
}

/**
 * Compose the per-turn context for a colleague turn.
 *
 * @param {object} ctx an ideabox ops context ({provider, cwd, ideaboxPath, …})
 * @param {{focusId?: string|null, byteBudget?: number, capabilityTimeoutMs?: number}} [opts]
 * @returns {Promise<{blocks: Array<{author: string, text: string}>, omissions: string[]}>}
 * @throws {IdeaboxNotFound} when `focusId` names no idea — the relay maps this
 *   to the context funnel; it must not silently fall through to plain chat.
 */
export async function composeColleagueContext(ctx, {
  focusId = null,
  byteBudget = DEFAULT_BYTE_BUDGET,
  capabilityTimeoutMs = CAPABILITY_TIMEOUT_MS,
} = {}) {
  const omissions = [];

  // ── corpus-level context: no record in focus ─────────────────────────────
  if (!focusId) {
    const ideas = await ctx.provider.listRecords({ kind: KIND.IDEA });
    const recent = [...ideas]
      .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))
      .slice(0, MAX_CORPUS_IDEAS);
    if (recent.length < ideas.length) {
      omissions.push(`ideas list truncated to ${recent.length} of ${ideas.length}`);
    }
    const lines = recent.map((i) => headline(i));
    return {
      blocks: [{
        author: 'compose:ideabox',
        text: `Recent ideas in this project's ideabox:\n${lines.join('\n')}`,
      }],
      omissions,
    };
  }

  // ── focused context ──────────────────────────────────────────────────────
  const idea = await findIdea(ctx.provider, focusId);
  if (!idea) throw new IdeaboxNotFound(focusId);

  /** Fetch one findings section; a failure becomes a named omission. */
  async function section(name, capability, fetch) {
    if (!ctx.provider.has(capability)) return null;
    try {
      return await withDeadline(fetch(), capabilityTimeoutMs, name);
    } catch (err) {
      omissions.push(`${name} unavailable: ${err?.message?.slice(0, 160) ?? 'unknown error'}`);
      return null;
    }
  }

  const [conviction, contradictions, challenge] = await Promise.all([
    section('conviction', CAP.CONVICTION, () => convictionOf(ctx, idea.handle)),
    section('contradictions', CAP.CONTRADICTION, () => contradictionsOf(ctx, idea.handle)),
    section('challenge', CAP.CHALLENGE, () => challengeIdea(ctx, idea.handle)),
  ]);

  if (contradictions && contradictions.length > MAX_CONTRADICTIONS) {
    omissions.push(`contradictions truncated to ${MAX_CONTRADICTIONS} of ${contradictions.length}`);
  }
  if (challenge && (challenge.conflicts?.length ?? 0) > MAX_CONFLICTS) {
    omissions.push(`challenge conflicts truncated to ${MAX_CONFLICTS} of ${challenge.conflicts.length}`);
  }

  // Assembly order is presentation; SURVIVAL order under budget is the
  // design contract, expressed by `drop` rank below (higher = dropped sooner).
  const sections = [];
  sections.push({
    name: 'record body', drop: 4, truncateTo: () => headline(idea),
    block: { author: `compose:idea ${idea.handle}`, text: recordText(idea) },
  });
  if (conviction) {
    sections.push({
      name: 'conviction', drop: 2,
      block: { author: 'compose:conviction', text: convictionText(idea, conviction) },
    });
  }
  if (contradictions?.length) {
    sections.push({
      name: 'contradictions', drop: 1,
      block: { author: 'compose:contradiction', text: contradictionsText(idea, contradictions) },
    });
  }
  if (challenge) {
    sections.push({
      name: 'challenge', drop: 3,
      block: { author: 'compose:challenge', text: challengeText(idea, challenge) },
    });
  }
  const discussion = discussionText(idea);
  if (discussion) {
    sections.push({
      name: 'discussion', drop: 5,
      block: { author: 'compose:discussion', text: discussion },
    });
  }

  // ── budget enforcement: drop (or truncate) in drop-rank order ────────────
  const total = () => sections.reduce((s, x) => s + bytes(x.block), 0);
  for (const rank of [5, 4, 3, 2, 1]) {
    if (total() <= byteBudget) break;
    const i = sections.findIndex((s) => s.drop === rank);
    if (i === -1) continue;
    const s = sections[i];
    if (s.truncateTo) {
      // The record body truncates to its headline before anything with a
      // lower drop rank is touched; if even the headline doesn't fit, the
      // next pass of the loop cannot shrink it further, so it stays — the
      // budget is a priority ordering, not a hard wire limit (Maya caps
      // upstream regardless).
      s.block = { author: s.block.author, text: s.truncateTo() };
      delete s.truncateTo;
      omissions.push(`record body truncated to headline, over budget`);
    } else {
      sections.splice(i, 1);
      omissions.push(`${s.name} omitted, over budget`);
    }
  }

  return { blocks: sections.map((s) => s.block), omissions };
}
