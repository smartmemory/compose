/**
 * lib/ontology — Compose's one seam onto the project ontology pack (FORGE-ONTOLOGY-READY-1).
 *
 * Every Compose module that needs a pack type (Project, Module, Lane, Feature, ...) imports it from here, never
 * declares it: `@typedef {import('../ontology/index.js').Feature} Feature`. The types and JSON Schemas come from
 * `pack.generated.js` (rendered by `gen-stub.js` from the pack `resolve-pack.js` finds; a stub until core's
 * ONTO-PROJECT-PACK-1 phase B ships generated .d.ts and JSON Schemas). Stored shapes stay as they are: where one
 * disagrees with the pack, it is a gap in docs/features/FORGE-ONTOLOGY-READY-1/mapping.md, not a rename here.
 */
export { PACK_ID, PACK_VERSION, PACK_SHA256, TYPE_NAMES, RELATION_NAMES, JSON_SCHEMAS } from './pack.generated.js';
export { resolveOntologyPack, findSmartMemoryRoot } from './resolve-pack.js';

/** @typedef {import('./pack.generated.js').Project} Project */
/** @typedef {import('./pack.generated.js').Group} Group */
/** @typedef {import('./pack.generated.js').Module} Module */
/** @typedef {import('./pack.generated.js').Repository} Repository */
/** @typedef {import('./pack.generated.js').Release} Release */
/** @typedef {import('./pack.generated.js').Feature} Feature */
/** @typedef {import('./pack.generated.js').Unit} Unit */
/** @typedef {import('./pack.generated.js').Lane} Lane */
/** @typedef {import('./pack.generated.js').Seat} Seat */
/** @typedef {import('./pack.generated.js').Session} Session */
/** @typedef {import('./pack.generated.js').Gate} Gate */
/** @typedef {import('./pack.generated.js').ProjectDecision} ProjectDecision */
/** @typedef {import('./pack.generated.js').Idea} Idea */
/** @typedef {import('./pack.generated.js').Commit} Commit */
/** @typedef {import('./pack.generated.js').Artifact} Artifact */

export {};
