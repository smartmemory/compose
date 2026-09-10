/** Pure S1a routing identities, output-contract fingerprints and static decisions. */
import { createHash } from 'node:crypto';

export class RoutingError extends Error {
  constructor(code, message) { super(message); this.name = 'RoutingError'; this.code = code; }
}
export function routingRefuse(code, message) { throw new RoutingError(code, message); }
const invalid = message => routingRefuse('ROUTING_SCHEMA_INVALID', message);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** JSON only: no implicit dropping, coercion, sparse arrays, or toJSON execution. */
export function canonicalRoutingJson(value) {
  const ancestors = new Set();
  function visit(v) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (!object(v) && !Array.isArray(v)) invalid('Routing payload must contain only finite JSON values');
    if (ancestors.has(v)) invalid('Cyclic routing payload');
    if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) invalid('Non-JSON object');
    if (Reflect.ownKeys(v).some(k => typeof k === 'symbol')) invalid('Symbol keys are not JSON');
    ancestors.add(v);
    let text;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length || Array.from({ length: v.length }, (_, i) => i).some(i => !Object.hasOwn(v, i))) invalid('Sparse or decorated array');
      text = `[${v.map(visit).join(',')}]`;
    } else text = `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${visit(v[k])}`).join(',')}}`;
    ancestors.delete(v);
    return text;
  }
  return visit(value);
}
export function routingDigest(value) { return createHash('sha256').update(canonicalRoutingJson(value), 'utf8').digest('hex'); }
const sortedSet = values => [...new Map(values.map(v => [canonicalRoutingJson(v), v])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, v]) => v);

/** Match Stratum's contract grammar (ir/validate.ts), keeping enum literals distinct from refs. */
function parseContractType(value) {
  let raw = value;
  const optional = raw.endsWith('?');
  if (optional) raw = raw.slice(0, -1);
  if (!raw || raw.endsWith('?')) invalid(`Invalid contract type ${value}`);
  const enumArray = /^\(([^()]+)\)\[\]$/.exec(raw);
  if (enumArray) {
    const values = enumArray[1].split('|');
    if (values.some(v => !v)) invalid(`Invalid contract type ${value}`);
    return { kind: 'typed-array', item: { kind: 'enum', values: sortedSet(values), optional: false }, optional };
  }
  if (raw.endsWith('[]')) {
    const item = parseContractType(raw.slice(0, -2));
    if (item.optional) invalid(`Invalid optional array item ${value}`);
    return { kind: 'typed-array', item, optional };
  }
  if (raw === 'object' || raw === 'array') return { kind: raw, optional };
  if (['string', 'integer', 'number', 'boolean'].includes(raw)) return { kind: 'scalar', scalar: raw, optional };
  if (raw.includes('|')) {
    const values = raw.split('|');
    if (values.some(v => !v || /[\[\]()]/.test(v))) invalid(`Invalid contract type ${value}`);
    return { kind: 'enum', values: sortedSet(values), optional };
  }
  if (/^[A-Z][a-zA-Z0-9_]*$/.test(raw)) return { kind: 'ref', name: raw, optional };
  invalid(`Invalid contract type ${value}`);
}

/** One traversal produces both exact retained definitions and canonical fingerprint nodes. */
function traverseContracts(root, definitions) {
  const retained = {}, normalized = {};
  function visitType(node) {
    if (node.kind === 'typed-array') visitType(node.item);
    if (node.kind === 'ref' && !Object.hasOwn(retained, node.name)) {
      if (!Object.hasOwn(definitions, node.name)) invalid(`Missing referenced contract ${node.name}`);
      retained[node.name] = structuredClone(definitions[node.name]);
      normalized[node.name] = walk(definitions[node.name]);
    }
    return node;
  }
  function walk(value) {
    if (typeof value === 'string') return visitType(parseContractType(value));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    if (value === null) return null;
    invalid('Invalid contract definition');
  }
  return { root: walk(root), retained, normalized };
}
export function reachableContracts(root, definitions = {}) { return traverseContracts(root, definitions).retained; }
export function contractFingerprint({ root, contracts = {}, options = [], paths = [] }, version = 1) {
  if (version !== 1) invalid('Unsupported fingerprint version');
  const closure = traverseContracts(root, contracts);
  return routingDigest({ version, root: closure.root, contracts: closure.normalized, options: sortedSet(options), paths: sortedSet(paths) });
}
function textIdentity(value, label) { if (typeof value !== 'string' || !value) invalid(`Missing ${label}`); }
function nullableIndex(value, label) { if (value !== null && (!Number.isInteger(value) || value < 0)) invalid(`Invalid ${label}`); }
export function dispatchKey({ preset, scopedStep, stage, provider, template = '', prior, fingerprint }) {
  for (const [label, value] of Object.entries({ preset, scopedStep, provider, fingerprint })) textIdentity(value, label);
  nullableIndex(stage, 'stage');
  if (typeof template !== 'string' || ![null, 'critical', 'standard', 'fast', 'coordinator'].includes(prior)) invalid('Invalid template/prior');
  return canonicalRoutingJson({ preset, scopedStep, stage, provider, template, prior, fingerprint });
}
export function routingRecordId({ runId, scopedStep, stage, epoch, itemIndex, generation, issuanceToken }) {
  for (const [label, value] of Object.entries({ runId, scopedStep, issuanceToken })) textIdentity(value, label);
  for (const [label, value] of Object.entries({ stage, itemIndex, generation })) nullableIndex(value, label);
  if (!Number.isInteger(epoch) || epoch < 0 || (itemIndex === null) !== (generation === null)) invalid('Invalid issuance epoch/item identity');
  return routingDigest({ runId, scopedStep, stage, epoch, itemIndex, generation, issuanceToken });
}
export function routingTable() { return { version: 's1a-empty-v1', contents: [], contentDigest: routingDigest([]), ledgerCutoff: null }; }
export function assertRoutingSlice(start) {
  if (!['off', 'shadow'].includes(start.mode) || (start.policy?.route_trials?.length ?? 0) !== 0
    || (start.policy?.route_explore ?? 0) !== 0 || start.calibration_feedback === true || (start.calibration ?? '') !== '') {
    routingRefuse('ROUTING_SLICE_UNAVAILABLE', 'S1a supports static shadow only, without trials, exploration or feedback');
  }
}
export function resolveRoute({ start, key, baseline, allocationId, manualOverride }) {
  assertRoutingSlice(start);
  if (start.table && canonicalRoutingJson(start.table) !== canonicalRoutingJson(routingTable())) invalid('S1a requires the pinned empty table');
  canonicalRoutingJson(baseline);
  const provenance = baseline.provenance ?? baseline;
  const via = provenance.via ?? (manualOverride?.supplied ? 'manual.fallback' : 'preset.default');
  const source = via === 'item.tier' ? 'preset' : (provenance.source ?? (manualOverride?.supplied ? 'manual' : 'preset'));
  if (!['manual', 'preset', 'default'].includes(source)) invalid('Non-static route source');
  return { proposal: structuredClone(baseline), admitted: structuredClone(baseline), would: structuredClone(baseline), source, via, reason: 'static-s1a' };
}
