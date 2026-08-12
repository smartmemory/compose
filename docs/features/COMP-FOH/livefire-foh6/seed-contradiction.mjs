// FOH-6 live-fire: seed two contradicting ideas through the SHIPPED ops path,
// then create the CONTRADICTS edge deterministically (no LLM-detection gate).
import {
  ideaboxContext, addIdea, challengeIdea, resolveIdeaChallenge, contradictionsOf,
} from '/Users/ruze/reg/my/forge/compose/lib/fluid/ideabox-ops.js';

const ROOT = '/Users/ruze/reg/my/forge/compose';
const log = (k, v) => console.log(`[${k}]`, typeof v === 'string' ? v : JSON.stringify(v));

const ctx = await ideaboxContext(ROOT, { origin: 'ui:ideabox' });

const A = await addIdea(ctx, {
  title: 'Gate-retry persistence datastore is Postgres',
  body: 'Idea: gate retries persist in Postgres with a per-lane retry budget table.',
  tags: ['foh6-livefire'],
});
log('seeded A', { handle: A.handle });

const B = await addIdea(ctx, {
  title: 'Gate-retry persistence datastore is Redis streams',
  body: 'Idea: gate retries persist in Redis streams, queue-based, with a per-lane retry budget.',
  tags: ['foh6-livefire'],
});
log('seeded B', { handle: B.handle });

// Informational only — LLM-based detection, never a gate for this E2E.
try {
  const det = await challengeIdea(ctx, B.handle);
  log('challenge(B) detection', { conflicts: (det?.conflicts ?? []).map(c => c.handle ?? c) });
} catch (e) {
  log('challenge(B) detection', `non-fatal: ${e.message?.slice(0, 200)}`);
}

// Deterministic edge: A supersedes B → decay B, durable A-CONTRADICTS->B.
const post = await resolveIdeaChallenge(ctx, A.handle, { against: B.handle, strategy: 'accept_new' });
log('resolve A over B', { confidence: post?.confidence ?? post?.current_confidence, challenged: post?.challenged, count: post?.challengeCount ?? post?.challenge_count });

const hits = await contradictionsOf(ctx, B.handle);
log('contradictionsOf(B)', hits.map(h => ({ handle: h.handle, kind: h.kind })));
if (!hits.length) { console.error('FAIL: no contradictions on B'); process.exit(1); }
console.log('SEED OK', JSON.stringify({ A: A.handle, B: B.handle }));
