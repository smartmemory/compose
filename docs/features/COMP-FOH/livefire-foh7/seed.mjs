import { ideaboxContext, addIdea } from '/Users/ruze/reg/my/forge/compose/lib/fluid/ideabox-ops.js';
import { KIND } from '/Users/ruze/reg/my/forge/compose/lib/fluid/provider.js';
const S = process.argv[2];
const seeds = {
  'product-a': [
    { title: 'Persist gate retries in Postgres', body: 'Harbor should keep gate-retry state in a Postgres table so retries survive a relay restart. Redis was rejected because eviction loses the retry ledger.', tags: ['gate','persistence'] },
    { title: 'Harbor billing: usage meter per tenant', body: 'Meter API calls per tenant and push to Stripe nightly.', tags: ['billing'] },
  ],
  'product-b': [
    { title: 'Persist gate retries in Redis streams', body: 'Lantern proposes Redis streams for gate-retry persistence; the ledger is append-only and trimmed at 7 days.', tags: ['gate','persistence'] },
    { title: 'Lantern onboarding wizard', body: 'Three-step onboarding wizard for new workspaces.', tags: ['onboarding'] },
  ],
};
for (const [name, ideas] of Object.entries(seeds)) {
  const root = `${S}/${name}`;
  const ctx = await ideaboxContext(root, { origin: 'cli:ideabox' });
  console.log(name, 'provider=', ctx.provider.name(), 'recall=', ctx.provider.has('recall'));
  for (const i of ideas) { const r = await addIdea(ctx, i); console.log('  +', r.handle, r.title); }
  const list = await ctx.provider.listRecords({ kind: KIND.IDEA });
  console.log('  listRecords:', list.map(r => r.handle).join(','));
}
