/**
 * Archetype loader (COMP-STAGE-GRADING-3). G3 owns this file; each new archetype adds one REGISTRY line.
 *
 * Contract: docs/features/COMP-MODEL-AB-DECISION/archetype-contract.json ($defs.descriptor, $defs.methodTable,
 * rules.loader). The engine (lib/experiment.js, G2) imports this module only for stage specs:
 *   opts._loadArchetype ?? (await import('./archetypes/index.js')).loadArchetype
 *
 * loadArchetype is synchronous, so a caller may `await` it or not.
 */

import * as debug from './debug.js';

const REGISTRY = Object.freeze(Object.assign(Object.create(null), {
  debug,
}));

export const ARCHETYPE_IDS = Object.freeze(Object.keys(REGISTRY));

/** archetype-contract.json $defs.methodTable, in order. */
export const METHOD_TABLE = Object.freeze([
  { name: 'buildInput', signature: 'buildInput(workspace, scenario) -> void', returns: 'void' },
  { name: 'prompt', signature: 'prompt(scenario) -> str', returns: 'string' },
  { name: 'oracle', signature: 'oracle(workspace, hidden, artifacts) -> {accuracy, detail}', returns: '#/$defs/oracleResult' },
  { name: 'canary', signature: 'canary(workspace) -> bool', returns: 'boolean' },
  { name: 'mechanismEngaged', signature: 'mechanismEngaged(workspace, transcript) -> bool', returns: 'boolean' },
].map(Object.freeze));

const STAGES = new Set(['design', 'plan', 'implement', 'review', 'test-authoring', 'debug', 'end-to-end']);
const JUDGED_STAGES = new Set(['design', 'plan']);

/** The archetype's data as archetype-contract.json $defs.descriptor. */
export function describeArchetype(mod) {
  return {
    id: mod.id,
    stage: mod.stage,
    runner: mod.runner,
    judged: mod.judged,
    version: mod.version,
    methods: METHOD_TABLE.map((m) => ({ ...m })),
  };
}

// A registered module that breaks the interface is a programming error, caught at load time.
function assertArchetype(key, mod) {
  const problems = [];
  if (mod.id !== key) problems.push(`id ${JSON.stringify(mod.id)} does not match registry key`);
  if (!STAGES.has(mod.stage)) problems.push(`unknown stage ${JSON.stringify(mod.stage)}`);
  if (mod.runner !== 'stage' && mod.runner !== 'build') problems.push(`runner must be "stage" or "build"`);
  if (mod.judged !== JUDGED_STAGES.has(mod.stage)) problems.push(`judged must be ${JUDGED_STAGES.has(mod.stage)} for stage ${mod.stage}`);
  if (typeof mod.version !== 'string' || !mod.version) problems.push('version must be a non-empty string');
  for (const { name } of METHOD_TABLE) {
    if (typeof mod[name] !== 'function') problems.push(`missing method ${name}`);
  }
  if (problems.length) throw new TypeError(`archetype ${key} breaks archetype-contract.json: ${problems.join('; ')}`);
}

export function loadArchetype(id) {
  if (typeof id !== 'string' || !Object.hasOwn(REGISTRY, id)) {
    const err = new Error(`ARCHETYPE_UNKNOWN: no archetype ${JSON.stringify(id)} (known: ${ARCHETYPE_IDS.join(', ')})`);
    err.code = 'ARCHETYPE_UNKNOWN';
    err.archetype = id;
    throw err;
  }
  const mod = REGISTRY[id];
  assertArchetype(id, mod);
  return mod;
}
