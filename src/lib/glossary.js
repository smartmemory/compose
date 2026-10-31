/**
 * glossary.js — what the cockpit's own words mean, one plain sentence each (COMP-COCKPIT-RULE-PLAIN-1).
 * Unit-code meanings are not here: they come from the builder's per-lane glossaries through the unit index.
 */
export const TERMS = {
  '2.0': 'The SmartMemory 2.0 lane: the big rebuild, worked as a numbered list of steps.',
  main: 'The main product lane: the SmartMemory service, core library and SDKs.',
  ops: 'The operations lane: the tooling that runs the other lanes (rules, scripts, dashboards).',
  forge: 'The forge lane: Compose and Stratum, the tools that build things.',
  wiki: 'The wiki lane: the knowledge-base product.',
  ready: 'Written up and waiting for someone to pick it up.',
  launchable: 'Ready, and nothing is blocking it: Cadence would start it now.',
  blocked: 'Ready, but something is in its way (a missing brief, a hold, another unit).',
  landed: 'Finished and merged into the main line of code.',
  gate: 'The automatic checks a unit must pass before it can land.',
  stamp: 'A timestamped record of one step in a unit’s life (ready, dispatched, landed...).',
};

/** The sentence for `code`: the lane glossary from the index, else a cockpit term, else null. */
export function explain(code, lane, index) {
  const g = index?.glossary;
  const fromIndex = (lane && g?.[lane]?.[code]) ?? null;
  if (fromIndex) return fromIndex;
  return TERMS[code] ?? null;
}
