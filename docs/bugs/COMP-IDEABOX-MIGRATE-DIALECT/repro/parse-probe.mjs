import { readFileSync } from 'node:fs';
import { parseIdeabox } from '/Users/ruze/reg/my/forge/compose/lib/ideabox.js';
for (const [name, p] of [
  ['forge-top', '/Users/ruze/reg/my/forge/docs/product/ideabox.md'],
  ['compose  ', '/Users/ruze/reg/my/forge/compose/docs/product/ideabox.md'],
]) {
  try {
    const r = parseIdeabox(readFileSync(p, 'utf8'));
    console.log(name, '-> ideas:', (r.ideas??[]).length, 'killed:', (r.killed??[]).length, 'keys:', Object.keys(r));
  } catch (e) { console.log(name, '-> ERROR', e.message); }
}
