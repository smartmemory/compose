// Post-fix consequence re-test through the SHIPPED paths:
//  1. two addDiscussion appends — BOTH must survive (last week: second dropped the first)
//  2. writebackReply twice with the same messageId — second must return deduped:true, ONE entry
import { ideaboxContext, addIdea, addDiscussion, findIdea } from '/Users/ruze/reg/my/forge/compose/lib/fluid/ideabox-ops.js';
import { writebackReply, markerFor } from '/Users/ruze/reg/my/forge/compose/lib/colleague/writeback.js';

const ROOT = '/Users/ruze/reg/my/forge/compose';
let failed = false;
const fail = (m) => { console.error('FAIL:', m); failed = true; };

const ctx = await ideaboxContext(ROOT, { origin: 'ui:ideabox' });
const { record } = await addIdea(ctx, { title: 'RMW fix probe', body: 'post-upstream-fix verification', tags: ['foh6-listfix'] });
console.log('[seeded]', record.handle);

// 1. two plain appends
await addDiscussion(ctx, record.handle, { author: 'probe-1', text: 'first entry' });
await addDiscussion(ctx, record.handle, { author: 'probe-2', text: 'second entry' });
let idea = await findIdea(ctx.provider, record.handle);
const authors = (idea.discussion ?? []).map(d => d.author);
console.log('[after two appends]', JSON.stringify(authors));
if (!(authors.includes('probe-1') && authors.includes('probe-2'))) fail('an append was lost — RMW still rebuilds from a stale base');

// 2. writeback dedup on same messageId
const msgId = 'fixprobe-0001';
const w1 = await writebackReply(ctx, { focusId: record.handle, messageId: msgId, text: 'maya reply' });
const w2 = await writebackReply(ctx, { focusId: record.handle, messageId: msgId, text: 'maya reply' });
console.log('[writeback 1]', JSON.stringify(w1), '[writeback 2]', JSON.stringify(w2));
if (w1.outcome !== 'ok' || w1.deduped) fail('first writeback should be a fresh ok');
if (w2.outcome !== 'ok' || w2.deduped !== true) fail('second writeback did NOT dedup — reconcile scan still blind');

idea = await findIdea(ctx.provider, record.handle);
const markers = (idea.discussion ?? []).filter(d => d.text.includes(markerFor(msgId))).length;
const total = (idea.discussion ?? []).length;
console.log('[final]', JSON.stringify({ total, mayaMarkers: markers, authors: idea.discussion.map(d => d.author) }));
if (markers !== 1) fail(`expected exactly 1 marker entry, got ${markers}`);
if (total !== 3) fail(`expected 3 entries (probe-1, probe-2, maya), got ${total}`);

console.log(failed ? 'RMW-FIX: FAILURES ABOVE' : 'RMW-FIX: VERIFIED — appends survive, dedup fires');
process.exitCode = failed ? 1 : 0;
