import { ideaboxContext, addIdea } from '/Users/ruze/reg/my/forge/compose/lib/fluid/ideabox-ops.js';
const cwd = process.argv[2];
const ctx = await ideaboxContext(cwd);
try {
  const r = await addIdea(ctx, { title: 'CANARY — a brand new idea typed by an upgrading user' });
  console.log('add ok ->', r?.handle ?? JSON.stringify(r).slice(0,120));
} catch (e) { console.log('add REFUSED ->', e.code || e.name, '|', e.message.slice(0,200)); }
