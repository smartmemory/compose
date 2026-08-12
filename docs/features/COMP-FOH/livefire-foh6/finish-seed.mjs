// FOH-6 live-fire: find the two already-seeded ideas, create the CONTRADICTS edge, verify.
import {
  ideaboxContext, resolveIdeaChallenge, contradictionsOf,
} from '/Users/ruze/reg/my/forge/compose/lib/fluid/ideabox-ops.js';
import { KIND } from '/Users/ruze/reg/my/forge/compose/lib/fluid/provider.js';

const ROOT = '/Users/ruze/reg/my/forge/compose';
const ctx = await ideaboxContext(ROOT, { origin: 'ui:ideabox' });

const records = await ctx.provider.listRecords({ kind: KIND.IDEA });
const A = records.find(r => /datastore is Postgres/i.test(r.title));
const B = records.find(r => /datastore is Redis/i.test(r.title));
if (!A || !B) { console.error('FAIL: seeded ideas not found', records.map(r => r.handle + ':' + r.title).slice(-6)); process.exit(1); }
console.log('[found]', JSON.stringify({ A: A.handle, B: B.handle }));

const post = await resolveIdeaChallenge(ctx, A.handle, { against: B.handle, strategy: 'accept_new' });
console.log('[resolve A over B]', JSON.stringify(post).slice(0, 300));

const hits = await contradictionsOf(ctx, B.handle);
console.log('[contradictionsOf(B)]', JSON.stringify(hits.map(h => ({ handle: h.handle, kind: h.kind }))));
if (!hits.length) { console.error('FAIL: no contradictions on B'); process.exit(1); }
console.log('SEED OK', JSON.stringify({ A: A.handle, B: B.handle }));
