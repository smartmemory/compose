/**
 * lib/fluid/ideabox-ops.js — the ideabox mutations, owned once.
 *
 * COMP-PLAN-IDEA-UNIFY S3b-2 (D20).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * S3b-1 cut the CLI over to the record store and closed the cockpit's write
 * path with a 409 rather than let it overwrite generated output. The obvious way
 * to reopen it is to have `server/ideabox-routes.js` call the provider "the way
 * the CLI does". That is the S3b-1 mistake, repeated.
 *
 * S3b-1 put serialized mutation and `reclaimAborted` into `local-provider.js`
 * instead of the seam, so `smartmemory-provider.js` satisfied the interface
 * completely while having neither — a second implementation that looks finished
 * and silently lacks the guarantees. Two independent call sites that must each
 * remember to run the migration gate before writing, and to re-render after,
 * fail in exactly that shape: the route looks correct, passes review, and
 * destroys an upgrading user's ideabox the first time it is used.
 *
 * So the two invariants live HERE, in code neither surface can skip:
 *
 *  1. `ensureIdeaboxMigrated` runs FIRST, before any write. Without it, a
 *     project with a populated markdown ideabox and an empty store has its ideas
 *     replaced by whatever the caller just typed.
 *  2. The projection is rewritten AFTER the record is durable, never before. If
 *     the render throws, the record is already saved and `compose ideabox
 *     render` completes the job. The other order writes a file describing a
 *     state that was never stored.
 *
 * WHAT AN OP RETURNS, AND WHY IT IS NOT A MESSAGE
 * ----------------------------------------------
 * `{ record, markdown, ...facts }`. The op does no printing and no serializing:
 * the CLI needs a line of text and the API needs a JSON body, and an op that
 * chose for them would force one surface to parse the other's presentation. The
 * `markdown` it hands back is the exact projection it just wrote, which is what
 * lets the API derive its response by parsing that string instead of re-reading
 * a file whose mtime it would have to race (D21).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { fluidProviderFor } from './factory.js';
import { ensureIdeaboxMigrated } from './ideabox-migrate.js';
import { writeIdeaboxProjection } from './render-ideabox.js';
import { FluidAmbiguousMatch, FluidRecordNotFound, KIND } from './provider.js';
import { resolveIdeaboxPath, resolveFeaturesPathFromConfig } from '../project-paths.js';

// ---------------------------------------------------------------------------
// Typed failures
//
// Typed rather than string-matched. The routes previously decided their status
// code with `err.message.includes('not found')`, which makes every error message
// load-bearing: rewording one silently turns a 404 into a 500. Each op names its
// failure and the caller maps it once.
// ---------------------------------------------------------------------------

/** The caller addressed a record that does not exist. HTTP 404. */
export class IdeaboxNotFound extends Error {
  constructor(id) {
    super(`Idea not found: ${id}`);
    this.name = 'IdeaboxNotFound';
    this.code = 'IDEA_NOT_FOUND';
    this.id = id;
  }
}

/** The caller's input is malformed or out of range. HTTP 400. */
export class IdeaboxInvalid extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'IdeaboxInvalid';
    this.code = 'IDEA_INVALID';
    this.field = field;
  }
}

/** The record exists but is in a state that forbids the operation. HTTP 409. */
export class IdeaboxConflict extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'IdeaboxConflict';
    this.code = 'IDEA_CONFLICT';
    this.detail = detail;
  }
}

/**
 * The record was written and the projection was not.
 *
 * A distinct type because it is the one failure where the caller MUST NOT tell
 * the user the operation did not happen. It did; only the generated file is
 * stale, and `compose ideabox render` fixes it without touching a record.
 */
export class IdeaboxRenderFailed extends Error {
  constructor(cause, record) {
    super(
      `The idea was saved, but the ideabox file could not be regenerated from the records: ` +
      `${cause?.message ?? cause}. Nothing is lost — fix the cause and run ` +
      `\`compose ideabox render\` to rebuild the file.`
    );
    this.name = 'IdeaboxRenderFailed';
    this.code = 'IDEA_RENDER_FAILED';
    this.cause = cause;
    this.record = record;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Build the context every op takes.
 *
 * @param {string} cwd project root
 * @param {object} [opts]
 * @param {string} [opts.origin] provenance door — `cli:ideabox` or `ui:ideabox`.
 *   Stamped at write time and never retrofitted, so a record captured in the
 *   cockpit stays distinguishable from one typed at a terminal for its lifetime.
 * @param {object} [opts.config] already-loaded `.compose/compose.json`
 * @param {import('./provider.js').FluidProvider} [opts.provider] an existing
 *   provider, for tests and for callers that hold one already
 */
export async function ideaboxContext(cwd, opts = {}) {
  return {
    cwd,
    provider: opts.provider ?? await fluidProviderFor(cwd),
    ideaboxPath: opts.ideaboxPath ?? resolveIdeaboxPath(cwd),
    config: opts.config ?? {},
    origin: opts.origin ?? 'cli:ideabox',
  };
}

// ---------------------------------------------------------------------------
// Internals shared by every op
// ---------------------------------------------------------------------------

const PRIORITIES = ['P0', 'P1', 'P2'];
const EFFORTS = ['S', 'M', 'L'];
const IMPACTS = ['low', 'medium', 'high'];

/** Invariant 1. Every mutating op calls this before it writes anything. */
const gate = (ctx) => ensureIdeaboxMigrated(ctx.provider, ctx.ideaboxPath);

/**
 * Invariant 2. Called only after the record is durable.
 *
 * Wrapped so the failure carries the record: a caller that reported "could not
 * save the idea" here would be telling the user the opposite of what happened.
 */
async function project(ctx, record) {
  try {
    return await writeIdeaboxProjection(ctx.provider, ctx.ideaboxPath);
  } catch (err) {
    throw new IdeaboxRenderFailed(err, record);
  }
}

/**
 * Find by handle, case-insensitively, the way the CLI has always accepted
 * `idea-3`. Killed ideas are included: a kill can be discussed, re-prioritised
 * and resurrected, and only promotion refuses one (see `promoteIdea`).
 */
export async function findIdea(provider, id) {
  const wanted = String(id ?? '').toUpperCase();
  const records = await provider.listRecords({ kind: KIND.IDEA });
  return records.find((r) => r.handle.toUpperCase() === wanted) ?? null;
}

async function requireIdea(ctx, id) {
  const idea = await findIdea(ctx.provider, id);
  if (!idea) throw new IdeaboxNotFound(id);
  return idea;
}

/**
 * Tags are stored bare — the parser accepts a leading `#` verbatim but no record
 * on disk uses one, and the projection's own convention line documents them as
 * bare words.
 */
export function normalizeTags(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return list.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean);
}

/** `—`, empty and null all mean untriaged; the record stores that as null. */
function normalizePriority(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === '—') return null;
  const p = String(raw).toUpperCase();
  if (!PRIORITIES.includes(p)) {
    throw new IdeaboxInvalid(`Invalid priority: ${raw}. Use P0, P1, P2 or —`, 'priority');
  }
  return p;
}

function normalizeEnum(raw, allowed, field) {
  if (raw === null || raw === undefined || raw === '') return null;
  const v = String(raw);
  if (!allowed.includes(v)) {
    throw new IdeaboxInvalid(`${field} must be ${allowed.join(', ')}, or null`, field);
  }
  return v;
}

/**
 * Resolve a cluster argument to a cluster HANDLE, creating one if the name is
 * new.
 *
 * The renderer matches members by handle, so storing a raw name puts the idea in
 * neither its cluster nor the unclustered bucket: it vanishes from the file
 * while its record sits on disk. Resolution therefore happens BEFORE the write,
 * not after — a durable record that cannot be rendered is the one failure this
 * module cannot undo for the caller.
 *
 * @returns {Promise<{handle: string|null, created: object|null}>}
 */
export async function resolveCluster(provider, name) {
  if (name === null || name === undefined || name === '') return { handle: null, created: null };

  // A handle is accepted as-is but must exist. This lookup does not race: a
  // handle either names a record or it does not, and nothing here creates one.
  const clusters = await provider.listRecords({ kind: KIND.CLUSTER });
  const byHandle = clusters.find((c) => c.handle.toUpperCase() === String(name).toUpperCase());
  if (byHandle) return { handle: byHandle.handle, created: null };

  // The by-name path DOES race, and used to lose (COMP-FLUID-SEAM-GUARANTEES
  // F6-1): looking up and then creating are two operations, and the provider's
  // lock covers each one but not the pair, so two concurrent
  // `add --cluster "Umbrella A"` both missed and both created — leaving two
  // clusters with one name and the ideas split between them. `findOrCreateRecord`
  // is the seam's single atomic operation for exactly this.
  try {
    const { record, created } = await provider.findOrCreateRecord(
      { kind: KIND.CLUSTER, title: String(name) },
      {}
    );
    return { handle: record.handle, created: created ? record : null };
  } catch (err) {
    if (err instanceof FluidAmbiguousMatch) {
      throw new IdeaboxInvalid(
        `"${name}" matches ${err.handles.length} clusters (${err.handles.join(', ')}). ` +
        `Pass the handle instead.`,
        'cluster'
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Capture a new idea.
 * @returns {Promise<{record: object, markdown: string, createdCluster: object|null}>}
 */
export async function addIdea(ctx, { title, body = '', source = '', tags = [], cluster = null } = {}) {
  if (!title || !String(title).trim()) throw new IdeaboxInvalid('title is required', 'title');
  await gate(ctx);

  const { handle: clusterHandle, created: createdCluster } = await resolveCluster(ctx.provider, cluster);
  const record = await ctx.provider.createRecord({
    kind: KIND.IDEA,
    title: String(title).trim(),
    body: body ?? '',
    source: source ?? '',
    tags: normalizeTags(tags),
    cluster: clusterHandle,
    provenance: { origin: ctx.origin },
  });

  return { record, markdown: await project(ctx, record), createdCluster };
}

/**
 * Patch an idea's editable fields.
 *
 * `status` is deliberately absent from the allow-list: promotion and kill are
 * lifecycle events with their own consequences (a feature folder, a dated
 * reason), and a status set through a generic field patch would produce a record
 * claiming an outcome that never happened.
 *
 * @param {object} fields any of title, description/body, source, tags, cluster,
 *   mapsTo, effort, impact, priority
 */
export async function updateIdea(ctx, id, fields = {}) {
  if (fields.status !== undefined) {
    throw new IdeaboxInvalid(
      'Status changes must go through promote, kill or resurrect, not a field update',
      'status'
    );
  }

  await gate(ctx);
  const idea = await requireIdea(ctx, id);

  const patch = {};
  if (fields.title !== undefined) {
    if (!String(fields.title ?? '').trim()) throw new IdeaboxInvalid('title cannot be empty', 'title');
    patch.title = String(fields.title).trim();
  }
  // `description` is the client-facing name for the record's `body`; both are
  // accepted so a caller need not know which side of the seam it is on.
  const body = fields.body !== undefined ? fields.body : fields.description;
  if (body !== undefined) patch.body = body ?? '';
  if (fields.source !== undefined) patch.source = fields.source ?? null;
  if (fields.tags !== undefined) patch.tags = normalizeTags(fields.tags);
  if (fields.priority !== undefined) patch.priority = normalizePriority(fields.priority);
  if (fields.effort !== undefined) patch.effort = normalizeEnum(fields.effort, EFFORTS, 'effort');
  if (fields.impact !== undefined) patch.impact = normalizeEnum(fields.impact, IMPACTS, 'impact');

  let createdCluster = null;
  if (fields.cluster !== undefined) {
    const resolved = await resolveCluster(ctx.provider, fields.cluster);
    patch.cluster = resolved.handle;
    createdCluster = resolved.created;
  }

  if (fields.mapsTo !== undefined) {
    const rest = idea.links.filter((l) => l.type !== 'maps_to');
    patch.links = fields.mapsTo
      ? [...rest, { type: 'maps_to', target: String(fields.mapsTo) }]
      : rest;
  }

  // Nothing to do is not an error — a PATCH carrying only unknown keys has
  // simply asked for nothing. Returning the record unchanged, and re-rendering,
  // keeps the caller's "what does it look like now" answer correct.
  const record = Object.keys(patch).length
    ? await ctx.provider.updateRecord(idea.handle, patch)
    : idea;

  return { record, markdown: await project(ctx, record), createdCluster };
}

/** Set or clear triage priority. `—`, `''` and null all mean untriaged. */
export async function setPriority(ctx, id, priority) {
  // Validated before the migration gate runs: a bad argument should not be the
  // thing that triggers a project's one-time import.
  normalizePriority(priority);
  return updateIdea(ctx, id, { priority });
}

/**
 * Kill an idea, with a dated reason.
 *
 * Killing an already-killed idea is a no-op that still re-renders. Not
 * politeness: every op writes its record before the projection, so "record
 * committed, render failed" invites a retry — and an unconditional write would
 * replace the original date and reason, most likely with "(no reason given)". A
 * kill is dated evidence; a retry must not rewrite it. The render still runs, so
 * the retry finishes the job it failed at.
 *
 * @returns {Promise<{record, markdown, alreadyKilled: boolean}>}
 */
export async function killIdea(ctx, id, reason = '') {
  await gate(ctx);
  const idea = await requireIdea(ctx, id);

  if (idea.status === 'killed') {
    return { record: idea, markdown: await project(ctx, idea), alreadyKilled: true };
  }

  const record = await ctx.provider.updateRecord(idea.handle, {
    status: 'killed',
    killed: { at: new Date().toISOString(), reason: reason || '(no reason given)' },
  });
  return { record, markdown: await project(ctx, record), alreadyKilled: false };
}

/**
 * Return a killed idea to the live set, preserving its handle.
 *
 * `killed` and `status_label` are both cleared. Leaving the label would render a
 * resurrected idea under whatever free-form token it carried when it died, and
 * leaving `killed` would leave a live idea holding a dated kill reason — a
 * record that contradicts itself.
 */
export async function resurrectIdea(ctx, id) {
  await gate(ctx);
  const idea = await requireIdea(ctx, id);

  if (idea.status !== 'killed') {
    throw new IdeaboxConflict(`${idea.handle} is not killed, so there is nothing to resurrect`, {
      handle: idea.handle,
      status: idea.status,
    });
  }

  const record = await ctx.provider.updateRecord(idea.handle, {
    status: 'new',
    status_label: null,
    killed: null,
  });
  return { record, markdown: await project(ctx, record) };
}

/**
 * Promote an idea to a feature, creating the feature folder if it is absent.
 *
 * A killed idea is refused (D22). The CLI's lookup finds killed records, so
 * without this guard `compose ideabox promote` on a killed idea would quietly
 * flip it to `promoted` — undoing a dated kill through a command that never
 * mentions kills. The old REST route refused by accident, having searched only
 * the live array; here it is refused on purpose, and both surfaces agree.
 *
 * The promotion is recorded as a typed `promoted_to` link rather than a
 * formatted status string, so the idea-to-feature edge is data in the graph
 * instead of prose to re-parse.
 */
export async function promoteIdea(ctx, id, featureCode = '') {
  await gate(ctx);
  const idea = await requireIdea(ctx, id);

  if (idea.status === 'killed') {
    throw new IdeaboxConflict(
      `${idea.handle} was killed on ${String(idea.killed?.at ?? '').slice(0, 10)} and cannot be promoted. ` +
      `Resurrect it first if the kill was wrong.`,
      { handle: idea.handle, status: idea.status }
    );
  }

  let code = featureCode || '';
  if (!code) {
    const slug = idea.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/-+$/, '');
    code = `${idea.handle}-${slug}`.toUpperCase();
  }

  const featuresBase = resolveFeaturesPathFromConfig(ctx.cwd, ctx.config ?? {});
  const featurePath = join(featuresBase, code);
  let createdFeature = false;
  if (!existsSync(featurePath)) {
    // COMP-MCP-VALIDATE-1: route through the validated writer rather than a raw
    // write, so a promoted feature.json is schema-guarded like any other.
    const { writeFeature } = await import('../feature-json.js');
    writeFeature(ctx.cwd, {
      code,
      description: idea.title,
      status: 'PLANNED',
      promotedFrom: idea.handle,
      createdAt: new Date().toISOString(),
    }, featuresBase);
    createdFeature = true;
  }

  const record = await ctx.provider.updateRecord(idea.handle, {
    status: 'promoted',
    links: [...idea.links.filter((l) => l.type !== 'promoted_to'), { type: 'promoted_to', target: code }],
  });

  return {
    record,
    markdown: await project(ctx, record),
    featureCode: code,
    featurePath,
    createdFeature,
  };
}

/** Append to an idea's deliberation trail. Append-only by contract. */
export async function addDiscussion(ctx, id, { author = null, text } = {}) {
  if (!text || !String(text).trim()) throw new IdeaboxInvalid('text is required', 'text');
  await gate(ctx);
  const idea = await requireIdea(ctx, id);

  const record = await ctx.provider.appendDiscussion(idea.handle, {
    text: String(text),
    author: author ?? null,
  });
  return { record, markdown: await project(ctx, record) };
}

/**
 * Push-back (FOH-3): contradiction-detect a decision or idea against same-kind
 * records, via the provider's CHALLENGE capability.
 *
 * Read-only — no gate, no projection write. Resolution is kind-agnostic (a
 * decision handle resolves, not just an idea) and case-insensitive, matching the
 * other ops; the provider owns the capability check and the challengeable-kind
 * gate, so a miss surfaces as `IdeaboxNotFound` and everything else propagates.
 *
 * @returns {Promise<import('./provider.js').ChallengeResult>}
 */
export async function challengeIdea(ctx, id, opts = {}) {
  const handle = String(id ?? '').toUpperCase(); // getRecord rejects lowercase
  try {
    return await ctx.provider.challenge(handle, opts);
  } catch (err) {
    if (err instanceof FluidRecordNotFound) throw new IdeaboxNotFound(id);
    throw err; // FluidCapabilityUnavailable / FluidKindUnsupported propagate as-is
  }
}

/**
 * Belief-strength read (FOH-4): a record's current confidence and its decay
 * history, via the provider's CONVICTION capability.
 *
 * Unlike `challengeIdea` this DOES run the migration gate first: on a
 * markdown-only project the record only exists after migration, and answering
 * "not found" for an idea sitting right there in the markdown would be wrong.
 * No projection write — nothing in the record body changes on a read.
 *
 * @returns {Promise<import('./provider.js').ConvictionResult>}
 */
export async function convictionOf(ctx, id) {
  await gate(ctx);
  const handle = String(id ?? '').toUpperCase();
  try {
    return await ctx.provider.conviction(handle);
  } catch (err) {
    if (err instanceof FluidRecordNotFound) throw new IdeaboxNotFound(id);
    throw err;
  }
}

/**
 * Gated resolution of a detected contradiction (FOH-4): decay `against`'s
 * confidence because `id` supersedes it.
 *
 * `id` is the record whose challenge surfaced the conflict; `against` is a
 * conflict handle from that `challengeIdea(id)` result. The caller is TRUSTED
 * on that provenance (v1 boundary — the provider verifies `against` is a real
 * same-kind, non-self record, but cannot verify it was genuinely challenged:
 * detection is LLM-based and there is no durable challenge record yet).
 *
 * Mutation contract, restated where the caller reads it:
 *   - the strategy is always explicit (v1: `accept_new` only) — never a default;
 *   - a 0.5 decay is near-irreversible (no fluid reinforce path exists);
 *   - calling it again decays again (1.0 → 0.5 → 0.0), deliberately un-deduped;
 *   - of the typed failures only `FluidResolutionNoOp` is safe to retry —
 *     `FluidResolutionIndeterminate` means the decay may still land, and a
 *     retry can double-decay.
 *
 * No projection write: the record body is untouched; only the SmartMemory-side
 * confidence moved.
 *
 * @param {object} ctx
 * @param {string} id the challenged (surviving) record
 * @param {{against: string, strategy: string}} opts
 * @returns {Promise<import('./provider.js').ConvictionResult>} `against`'s
 *   post-decay conviction
 */
export async function resolveIdeaChallenge(ctx, id, { against, strategy } = {}) {
  await gate(ctx); // FIRST, like every mutating op — before even input checks
  if (!against || !String(against).trim()) {
    throw new IdeaboxInvalid('against is required — the conflict handle from a prior challenge', 'against');
  }
  const sourceHandle = String(id ?? '').toUpperCase();
  const targetHandle = String(against).toUpperCase();
  try {
    return await ctx.provider.resolveConflict(sourceHandle, targetHandle, { strategy });
  } catch (err) {
    if (err instanceof FluidRecordNotFound) throw new IdeaboxNotFound(err.handle ?? id);
    // FluidInvalidStrategy / FluidInvalidTarget / FluidResolutionNoOp /
    // FluidResolutionConflict / FluidResolutionIndeterminate are typed for the
    // caller and propagate as-is (same convention as challengeIdea).
    throw err;
  }
}
