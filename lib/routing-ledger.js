/** Routing evidence persistence and pure projections. No model calls or runtime hooks. */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync, ftruncateSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import startSchema from '../contracts/routing-start.schema.json' with { type: 'json' };
import recordSchema from '../contracts/routing-record.schema.json' with { type: 'json' };
import joinSchema from '../contracts/routing-join.schema.json' with { type: 'json' };
import outcomeSchema from '../contracts/routing-outcome.schema.json' with { type: 'json' };
import { assertRoutingSlice, canonicalRoutingJson, contractFingerprint, reachableContracts, routingDigest, routingTable, routingRefuse, routingRecordId } from './model-router.js';
import { preflightPipelineProfiles, resolveConsumerProfile } from './pipeline-profiles.js';
import { resolvePlanSpecValues } from './stratum-mcp-client.js';
import { findRoutingPlanRuns, validateRoutingSnapshot } from './flow-state.js';

const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
for (const schema of [startSchema, joinSchema, outcomeSchema, recordSchema]) ajv.addSchema(schema);
const checkStart = ajv.compile(startSchema);
const checkRecord = ajv.compile(recordSchema);
const checkJoin = ajv.compile(joinSchema);
const checkOutcome = ajv.compile(outcomeSchema);
const checkReceiptRouting = ajv.compile({ $ref: 'routing-join.schema.json#/$defs/receiptRouting' });
const checkLedgerRow = ajv.compile({ $ref: 'routing-record.schema.json#/$defs/ledgerRow' });
const transport = ['route_mode', 'routing_start', 'routing_root', 'routing_plan_intent', 'routing_continuation'];
const refuse = routingRefuse;
const same = (a, b) => canonicalRoutingJson(a) === canonicalRoutingJson(b);
function validate(check, value) {
  canonicalRoutingJson(value);
  if (!check(value)) refuse('ROUTING_SCHEMA_INVALID', ajv.errorsText(check.errors));
  return value;
}
export function routingStaticInput(input) { return Object.fromEntries(Object.entries(input).filter(([k]) => !transport.includes(k))); }
export function validateRoutingStart(start) {
  validate(checkStart, start);
  const { rootDigest, ...payload } = start;
  if (routingDigest(payload) !== rootDigest || !same(start.table, routingTable()) || routingDigest(start.originalInput) !== start.inputDigest
    || routingDigest(start.spec.original) !== start.spec.originalDigest || routingDigest(start.spec.effective) !== start.spec.effectiveDigest
    || routingDigest({ startId: start.startId, policyVersion: start.policyVersion }) !== start.seed) refuse('ROUTING_ROOT_DRIFT', 'Routing start/table/input/spec digest differs');
  for (const contract of Object.values(start.contracts)) if (contractFingerprint(contract) !== contract.fingerprint) refuse('ROUTING_ROOT_DRIFT', 'Output closure fingerprint differs');
  return start;
}
export function validateRoutingRecord(record, pin) {
  validate(checkRecord, record);
  if (pin && (pin.startId !== record.startId || pin.rootDigest !== record.rootDigest)) refuse('ROUTING_BINDING_DRIFT', 'Routing record belongs to another start');
  if (joinTypes.has(record.type)) validateRoutingJoin(record);
  if (outcomeTypes.has(record.type)) validateRoutingOutcome(record);
  if (!record.type) validateRoutingLedgerRow(record);
  if (record.type === 'issuance' && record.id !== routingRecordId(record)) refuse('ROUTING_BINDING_DRIFT', 'Issuance tuple differs from record id');
  if (record.type === 'issuance' && !same(record.selected, record.would)) refuse('ROUTING_BINDING_DRIFT', 'S1a issuance must use its static baseline');
  if (record.type === 'admission') {
    if (![record.candidate, record.proposal, record.would].every(v => same(v, record.baseline))
      || (record.admitted !== null && !same(record.admitted, record.baseline)) || (record.admitted === null) !== (record.refusal !== null)) refuse('ROUTING_BINDING_DRIFT', 'Invalid static admission');
    if ((record.itemIndex === null) !== (record.generation === null) || (record.stage === null && (record.itemIndex !== null || record.logicalTaskId !== null))) refuse('ROUTING_BINDING_DRIFT', 'Ordinary identity must be null');
  }
  if (record.type === 'plan-intent' && routingDigest(record.input) !== record.inputDigest) refuse('ROUTING_BINDING_DRIFT', 'Plan input digest differs');
  if (record.type === 'epoch-binding' && ((record.graph === null) !== (record.graphDigest === null)
    || (record.graph && routingDigest(record.graph) !== record.graphDigest)
    || (record.sourceBinding && routingDigest(record.sourceBinding.output) !== record.sourceBinding.outputDigest))) refuse('ROUTING_BINDING_DRIFT', 'Epoch graph/source digest differs');
  if (record.type === 'continuation-intent') {
    if (routingDigest(record.sourceGraph) !== record.sourceGraphDigest || routingDigest(record.filteredGraph) !== record.filteredGraphDigest) refuse('ROUTING_BINDING_DRIFT', 'Continuation graph digest differs');
    const sourceIds = record.sourceGraph.tasks?.map(t => t.id);
    if (!sourceIds || sourceIds.some(id => typeof id !== 'string' || !id) || new Set(sourceIds).size !== sourceIds.length
      || new Set(record.completedTaskIds).size !== record.completedTaskIds.length
      || !same(sourceIds.filter(id => record.completedTaskIds.includes(id)), record.removedTaskIds)) refuse('ROUTING_CONTINUATION_AMBIGUOUS', 'Invalid continuation completion/graph identity');
    const removedDependencies = [];
    const expected = { ...record.sourceGraph, tasks: record.sourceGraph.tasks.filter(t => !record.removedTaskIds.includes(t.id)).map(t => {
      if (!Array.isArray(t.depends_on)) refuse('ROUTING_CONTINUATION_AMBIGUOUS', 'Missing dependency list');
      return { ...t, depends_on: t.depends_on.filter(dependency => {
        if (!record.removedTaskIds.includes(dependency)) return true;
        removedDependencies.push({ taskId: t.id, dependency }); return false;
      }) };
    }) };
    const indexMap = sourceIds.map((taskId, oldIndex) => ({ taskId, oldIndex, newIndex: record.removedTaskIds.includes(taskId) ? null : expected.tasks.findIndex(t => t.id === taskId) }));
    if (!same(record.filteredGraph, expected) || !same(record.removedDependencies, removedDependencies) || !same(record.indexMap, indexMap)
      || !same(record.bindings.map(b => b.logicalTaskId), expected.tasks.map(t => t.id))) refuse('ROUTING_CONTINUATION_AMBIGUOUS', 'Continuation transformation evidence differs');
  }
  return record;
}
function safeId(id) { if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(id)) refuse('ROUTING_STORAGE_UNSAFE', 'Unsafe routing file identity'); return id; }
function directory(path) {
  if (existsSync(path)) { if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) refuse('ROUTING_STORAGE_UNSAFE', `Unsafe directory ${path}`); return; }
  directory(dirname(path)); mkdirSync(path); syncDirectory(dirname(path));
}
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function rootPath(cwd) {
  const root = realpathSync(cwd);
  for (const path of [join(root, '.compose'), join(root, '.compose/routing')]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) refuse('ROUTING_STORAGE_UNSAFE', 'Routing subtree may not be a symlink');
  return join(root, '.compose/routing');
}
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
export function ensureRoutingStorage({ cwd }) {
  const root = rootPath(cwd);
  if (git(cwd, ['ls-files', '--', '.compose/routing']).trim()) refuse('ROUTING_STORAGE_UNSAFE', 'Reserved routing subtree contains tracked files');
  const exclude = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const rule = '/.compose/routing/';
  if (!before.split('\n').includes(rule)) {
    directory(dirname(exclude));
    const fd = openSync(exclude, 'a', 0o600);
    try { writeFileSync(fd, `${before && !before.endsWith('\n') ? '\n' : ''}${rule}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dirname(exclude));
  }
  try { git(cwd, ['check-ignore', '--no-index', '.compose/routing/probe']); }
  catch { refuse('ROUTING_STORAGE_UNSAFE', 'Routing ignore rule is not effective'); }
  directory(root);
}
function startDir(cwd, startId) { return join(rootPath(cwd), 'starts', safeId(startId)); }
function assertNoSymlinkPath(path) {
  let cursor = path;
  while (true) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) refuse('ROUTING_STORAGE_UNSAFE', `Symlink routing path refused: ${cursor}`);
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function readJson(path, code = 'ROUTING_BINDING_MISSING') {
  try {
    assertNoSymlinkPath(path);
    if (lstatSync(path).isSymbolicLink()) refuse('ROUTING_STORAGE_UNSAFE', 'Symlink record refused');
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) { if (error.code?.startsWith('ROUTING_')) throw error; refuse(code, `Cannot read routing evidence ${path}: ${error.message}`); }
}
function immutable(path, value, hooks = {}) {
  assertNoSymlinkPath(path);
  const bytes = canonicalRoutingJson(value) + '\n';
  directory(dirname(path));
  if (existsSync(path)) {
    if (!same(readJson(path), value)) refuse('ROUTING_BINDING_DRIFT', `Immutable routing payload changed: ${path}`);
    return structuredClone(value);
  }
  const temp = `${path}.${randomUUID()}.tmp`; const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, bytes, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    hooks.beforePublish?.(path);
    try { linkSync(temp, path); } catch (error) { if (error.code !== 'EEXIST') throw error; if (!same(readJson(path), value)) refuse('ROUTING_BINDING_DRIFT', 'Concurrent immutable payload differs'); }
    syncDirectory(dirname(path)); hooks.afterPublish?.(path);
  } finally { unlinkSync(temp); }
  return structuredClone(value);
}
function withStartLock(cwd, startId, fn) {
  const dir = startDir(cwd, startId); assertNoSymlinkPath(dir); directory(dir); const lock = join(dir, '.lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reclaim = `${lock}.reclaim`;
    try { mkdirSync(reclaim); } catch { refuse('ROUTING_STORAGE_LOCKED', 'Another writer is reclaiming the start lock'); }
    try {
      const owner = readJson(join(lock, 'owner.json'), 'ROUTING_STORAGE_LOCKED');
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) refuse('ROUTING_STORAGE_LOCKED', 'Unverifiable lock owner');
      try { process.kill(owner.pid, 0); refuse('ROUTING_STORAGE_LOCKED', 'Start writer is alive'); }
      catch (err) { if (err.code !== 'ESRCH') refuse('ROUTING_STORAGE_LOCKED', 'Cannot prove start writer death'); }
      rmSync(lock, { recursive: true }); mkdirSync(lock);
    } finally { rmSync(reclaim, { recursive: true }); }
  }
  try {
    immutable(join(lock, 'owner.json'), { pid: process.pid });
    return fn();
  } finally { rmSync(lock, { recursive: true }); syncDirectory(dir); }
}
function saveRecord(cwd, record, hooks) {
  validateRoutingRecord(record);
  return immutable(join(startDir(cwd, record.startId), 'records', `${safeId(record.id)}.json`), record, hooks);
}
function loadRecord(cwd, start, id) { return validateRoutingRecord(readJson(join(startDir(cwd, start.startId), 'records', `${safeId(id)}.json`)), start); }
function base(start, type, id) { return { schemaVersion: 1, startId: start.startId, rootDigest: start.rootDigest, type, id }; }

/** Refuse transport at every interpolation/forwarding boundary before planning.
 * Walk authored flow bodies, including child inputs and fanout stages; declarations
 * are types, not values. Never rewrite prompts or the caller's ordinary inputs.
 */
export function validateRoutingTransport(spec) {
  const scan = (value, path) => {
    if (typeof value === 'string') {
      const expressions = [...value.matchAll(/\$\{([^}]*)\}/g)].map(m => m[1]);
      if (value.startsWith('$.')) expressions.push(value.slice(2));
      for (const expression of expressions) {
        for (const match of expression.matchAll(/\binput\b([^\s]*)/g)) {
          const suffix = match[1];
          const field = suffix.match(/^\.([A-Za-z_]\w*)/)?.[1]
            ?? suffix.match(/^\[['"]([^'"]+)['"]\]/)?.[1];
          if (!field || transport.includes(field)) refuse('ROUTING_TRANSPORT_EXPOSED', `Routing transport reference at ${path}`);
        }
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) scan(child, `${path}.${key}`);
    }
  };
  for (const [name, flow] of Object.entries(spec.flows ?? {})) {
    if (!flow || typeof flow !== 'object') continue;
    const { input, ...body } = flow;
    scan(body, `flows.${name}`);
  }
}

export function createRoutingStart({ cwd, spec, inputs, originalProfiles = {}, runtimeOverrides = {}, runtimeOrigins: suppliedOrigins = {}, preflight, mode = 'off', presetId, hooks = {} }) {
  assertRoutingSlice({ mode, policy: preflight?.routingPolicy });
  if (mode === 'off') return null;
  const parsed = typeof spec === 'string' ? YAML.parse(spec) : structuredClone(spec);
  const flow = parsed.flows?.[parsed.flows.entry] ?? Object.values(parsed.flows ?? {}).find(v => v?.steps);
  if (!transport.every(k => flow?.input?.[k] === 'string?')) refuse('ROUTING_INPUT_UNDECLARED', 'Participating flow must declare all optional routing transport strings');
  validateRoutingTransport(parsed);
  const recordedRoles = {};
  const effective = resolvePlanSpecValues(parsed, routingStaticInput(inputs), recordedRoles);
  const runtimeOrigins = Object.fromEntries(Object.entries(recordedRoles).map(([id, profile]) => [id, {
    supplied: false, origin: 'recorded-role', recordedRole: profile,
  }]));
  for (const [id, provenance] of Object.entries(preflight?.staticProvenance ?? {})) {
    if (Object.hasOwn(recordedRoles, id) || Object.hasOwn(runtimeOverrides, id)) runtimeOrigins[id] = provenance.manualFallback;
  }
  const verified = preflightPipelineProfiles(originalProfiles, effective, { ...recordedRoles, ...runtimeOverrides }, { mode, runtimeOrigins });
  if (!preflight?.ok || preflight.profilesDigest !== verified.profilesDigest) refuse('ROUTING_ROOT_DRIFT', 'Preflight does not match static configuration');
  const startId = randomUUID(); const policyVersion = 's1a-static-v1';
  const staticResolutions = {}, ordinaryInitialCandidates = {}, contracts = {};
  for (const [flowName, definition] of Object.entries(effective.flows)) {
    for (const step of definition?.steps ?? []) {
      const stages = step.fanout?.steps ?? (step.agent ? [step] : []);
      for (const [index, stage] of stages.entries()) {
        const scope = `${flowName}/${step.id}${step.fanout ? `/stage-${index}` : ''}`;
        const profileKey = Object.hasOwn(verified.normalized, step.id) || stages.length === 1 ? step.id : `${step.id}/${index}`;
        const provenance = structuredClone(verified.staticProvenance[profileKey]);
        // Explicit supply is evidence, not necessarily an effective override:
        // bare role flags preserve the verified sidecar winner and null profile.
        const origin = suppliedOrigins[step.id] ?? suppliedOrigins[profileKey];
        if (origin) Object.assign(provenance.manualFallback, {
          supplied: origin.supplied, origin: origin.origin, recordedRole: origin.recordedRole,
        });
        if (!Object.hasOwn(verified.normalized, step.id)) {
          provenance.winner = resolveConsumerProfile(stage.agent, {});
          provenance.prior = provenance.winner.tier;
        }
        staticResolutions[scope] = provenance;
        if (!step.fanout) ordinaryInitialCandidates[scope] = structuredClone(provenance.winner);
        const root = stage.out ?? null;
        const closure = { root, contracts: reachableContracts(root, parsed.contracts ?? {}), options: [], paths: [] };
        contracts[scope] = { ...closure, fingerprint: contractFingerprint(closure) };
      }
    }
  }
  const candidateLadders = Object.fromEntries(['claude', 'codex'].map(provider => [provider, {
    rungs: ['fast', 'standard', 'critical'].map(tier => resolveConsumerProfile(`${provider}::${tier}`, {})),
    coordinator: provider === 'claude' ? resolveConsumerProfile('claude::coordinator', {}) : null,
  }]));
  const originalInput = routingStaticInput(inputs);
  const payload = { schemaVersion: 1, policyVersion, fingerprintVersion: 1, startId,
    seed: routingDigest({ startId, policyVersion }), mode, createdAt: new Date().toISOString(),
    policy: { tolerance: 0.05, candidateLadders, route_trials: [], route_explore: 0 }, table: routingTable(),
    presetId, workspaceRoot: realpathSync(cwd), spec: { original: parsed, effective, originalDigest: routingDigest(parsed), effectiveDigest: routingDigest(effective) },
    originalInput, inputDigest: routingDigest(originalInput), originalProfiles, runtimeOverrides, mergedProfiles: verified.normalized,
    profilesDigest: verified.profilesDigest, mappings: routingModelMappings(verified), contracts, staticResolutions, ordinaryInitialCandidates,
    calibration_feedback: false, calibration: '', cohort: 'static' };
  const start = validateRoutingStart({ ...payload, rootDigest: routingDigest(payload) });
  ensureRoutingStorage({ cwd });
  return withStartLock(cwd, startId, () => immutable(join(startDir(cwd, startId), 'routing-start.json'), start, hooks));
}
/** Include all reserved provider tiers and item-template capabilities, even before a wave exists. */
export function routingModelMappings(preflight) {
  const mappings = structuredClone(preflight.resolved);
  for (const provider of ['claude', 'codex']) {
    for (const tier of ['fast', 'standard', 'critical', ...(provider === 'claude' ? ['coordinator'] : [])]) {
      mappings[`candidate/${provider}/${tier}`] = resolveConsumerProfile(`${provider}::${tier}`, {});
    }
  }
  for (const [id, entry] of Object.entries(preflight.normalized)) {
    if (entry?.tier_from === 'item.tier') for (const tier of ['fast', 'standard', 'critical']) mappings[`item/${id}/${tier}`] = resolveConsumerProfile(entry, { tier });
  }
  return mappings;
}
export function readRoutingStart({ cwd, startId, rootDigest }) {
  const start = validateRoutingStart(readJson(join(startDir(cwd, startId), 'routing-start.json'), 'ROUTING_ROOT_MISSING'));
  if (start.startId !== startId || start.rootDigest !== rootDigest || start.workspaceRoot !== realpathSync(cwd)) refuse('ROUTING_ROOT_DRIFT', 'Routing start identity differs');
  return start;
}
export function recordRoutingPlanIntent({ cwd, start, input, specDigest, featureCode, previousRunId = null, continuation = null, hooks = {} }) {
  readRoutingStart({ cwd, ...start });
  if (input.routing_start !== canonicalRoutingJson(start) || input.routing_root !== start.rootDigest || input.route_mode !== 'shadow') refuse('ROUTING_ROOT_DRIFT', 'Plan transport differs from sealed start');
  if (specDigest !== start.spec.effectiveDigest || !same(routingStaticInput(input), start.originalInput)) refuse('ROUTING_ROOT_DRIFT', 'Plan static input/spec drift');
  if (continuation) validateRoutingRecord(continuation, start);
  if ((previousRunId === null) !== (continuation === null) || (continuation && (continuation.previousRunId !== previousRunId || input.routing_continuation !== continuation.id))) refuse('ROUTING_CONTINUATION_AMBIGUOUS', 'Missing continuation linkage');
  const id = safeId(input.routing_plan_intent);
  const intent = { ...base(start, 'plan-intent', id), phase: 'prepared', planIntentId: id, input: structuredClone(input), inputDigest: routingDigest(input), specDigest,
    featureCode, workspaceRoot: realpathSync(cwd), previousRunId, continuationIntentId: continuation?.id ?? null };
  return withStartLock(cwd, start.startId, () => {
    if (continuation) saveRecord(cwd, continuation);
    const result = saveRecord(cwd, intent, hooks);
    immutable(join(rootPath(cwd), 'features', routingDigest(featureCode), `${id}.json`), { startId: start.startId, rootDigest: start.rootDigest, planIntentId: id });
    return result;
  });
}
/** Durable requested marker is separate from the immutable prepared intent. */
export function recordRoutingPlanRequested({ cwd, start, intent, hooks = {} }) {
  readRoutingStart({ cwd, ...start });
  if (!same(loadRecord(cwd, start, intent.id), intent)) refuse('ROUTING_BINDING_DRIFT', 'Plan intent changed');
  return withStartLock(cwd, start.startId, () => saveRecord(cwd, { ...intent, id: `${intent.id}-requested`, phase: 'requested' }, hooks));
}
export function bindRoutingRun({ cwd, start, intent, snapshot, hooks = {} }) {
  readRoutingStart({ cwd, ...start });
  if (!same(loadRecord(cwd, start, intent.id), intent)) refuse('ROUTING_BINDING_DRIFT', 'Plan intent changed');
  const requested = loadRecord(cwd, start, `${intent.id}-requested`);
  if (requested.phase !== 'requested' || requested.planIntentId !== intent.id) refuse('ROUTING_BINDING_MISSING', 'Plan was not durably requested');
  validateRoutingSnapshot(snapshot, { rootDigest: start.rootDigest, planIntentId: intent.id, workspaceRoot: cwd });
  if (routingDigest(snapshot.input) !== intent.inputDigest || routingDigest(snapshot.spec) !== intent.specDigest) refuse('ROUTING_BINDING_DRIFT', 'Recorded run differs from plan input/spec');
  const binding = { ...base(start, 'run-binding', routingDigest({ runId: snapshot.id, startId: start.startId })), runId: snapshot.id, revisionDigest: snapshot.revisionDigest,
    specDigest: intent.specDigest, inputDigest: intent.inputDigest, planIntentId: intent.id, previousRunId: intent.previousRunId, continuationIntentId: intent.continuationIntentId };
  return withStartLock(cwd, start.startId, () => {
    // One plan intent must never bind two engine runs, even after an acknowledgement loss.
    immutable(join(startDir(cwd, start.startId), 'plans', `${intent.id}.json`), { bindingId: binding.id, runId: binding.runId });
    return saveRecord(cwd, binding, hooks);
  });
}
export function recoverRoutingPlan({ cwd, intent, stateRoot }) {
  const start = readRoutingStart({ cwd, ...intent });
  let runs;
  try { runs = findRoutingPlanRuns({ stateRoot, workspaceRoot: cwd, planIntentId: intent.id, rootDigest: start.rootDigest }); }
  catch (error) { refuse('ROUTING_PLAN_UNCERTAIN', error.message); }
  if (runs.length !== 1) refuse('ROUTING_PLAN_UNCERTAIN', 'Cannot certify exactly one requested engine plan');
  return bindRoutingRun({ cwd, start, intent, snapshot: runs[0] });
}
export function validateRoutingRun({ cwd, snapshot, journal, currentSpec, currentMappings }) {
  validateRoutingSnapshot(snapshot, { workspaceRoot: cwd });
  const recorded = JSON.parse(snapshot.input.routing_start);
  const start = readRoutingStart({ cwd, startId: recorded.startId, rootDigest: snapshot.input.routing_root });
  if (!same(recorded, start)) refuse('ROUTING_ROOT_DRIFT', 'Recorded start bytes differ');
  const parsed = typeof currentSpec === 'string' ? YAML.parse(currentSpec) : currentSpec;
  if (!same(parsed, start.spec.original) || !same(currentMappings, start.mappings)) refuse('ROUTING_ROOT_DRIFT', 'Current spec/model mappings differ from pinned start');
  const id = routingDigest({ runId: snapshot.id, startId: start.startId }); const binding = loadRecord(cwd, start, id);
  if (binding.type !== 'run-binding' || binding.runId !== snapshot.id || binding.revisionDigest !== snapshot.revisionDigest || binding.inputDigest !== routingDigest(snapshot.input)
    || binding.planIntentId !== snapshot.input.routing_plan_intent) refuse('ROUTING_BINDING_DRIFT', 'Run binding differs');
  validateRoutingJournal(journal.routing, binding);
  return { start, binding };
}

/** Build the complete first journal in memory; callers publish only after validation. */
export function initializeRoutingJournal(binding, retained = null) {
  validateRoutingRecord(binding);
  if (binding.type !== 'run-binding') refuse('ROUTING_BINDING_DRIFT', 'Expected run binding');
  if (retained) {
    validateRoutingJournal(retained, retained.runBinding);
    if (binding.previousRunId !== retained.runBinding.runId) refuse('ROUTING_BINDING_DRIFT', 'Retained journal is not the immediate predecessor');
  }
  const records = structuredClone(retained?.records ?? {});
  if (retained) {
    const prior = retained.runBinding;
    if (Object.hasOwn(records, prior.id) && !same(records[prior.id], prior)) refuse('ROUTING_BINDING_DRIFT', 'Retained run binding differs');
    records[prior.id] = structuredClone(prior);
  }
  return validateRoutingJournal({ version: 1, startId: binding.startId, rootDigest: binding.rootDigest,
    runBinding: structuredClone(binding), records, tokenIndex: structuredClone(retained?.tokenIndex ?? {}),
    eventTips: structuredClone(retained?.eventTips ?? {}) }, binding);
}

/** Follow only reachable predecessors, checking every retained graph/history transition. */
function continuationAncestors(binding, records) {
  const links = [];
  const visited = new Set();
  let cursor = binding;
  while (cursor.continuationIntentId) {
    if (visited.has(cursor.runId)) refuse('ROUTING_BINDING_DRIFT', 'Cyclic continuation history');
    visited.add(cursor.runId);
    const link = records[cursor.continuationIntentId];
    const predecessors = Object.values(records).filter(r => r.type === 'run-binding' && r.runId === cursor.previousRunId);
    if (link?.type !== 'continuation-intent' || predecessors.length !== 1) refuse('ROUTING_BINDING_MISSING', 'Missing continuation history');
    links.push(link);
    cursor = predecessors[0];
  }
  for (let i = 0; i + 1 < links.length; i++) validateContinuationTransition(links[i].sourceGraph, links[i].completedTaskIds, links.slice(i + 1));
  return links;
}
function validateContinuationTransition(graph, completed, ancestors) {
  if (!ancestors.length) return;
  if (!same(graph, ancestors[0].filteredGraph)) refuse('ROUTING_CONTINUATION_GRAPH_DRIFT', 'Immediate graph differs from retained continuation transformation');
  if (completed && ancestors.some(link => link.completedTaskIds.some(id => !completed.includes(id)))) {
    refuse('ROUTING_CONTINUATION_HISTORY_DRIFT', 'Cumulative completion history dropped an ancestor completion');
  }
}

/** Validate both directions of the index and all immutable links on every journal read. */
export function validateRoutingJournal(routing, binding) {
  if (!routing || !binding) refuse('ROUTING_BINDING_MISSING', 'Participating routing journal/binding missing');
  validateRoutingRecord(binding);
  if (binding.type !== 'run-binding' || routing.version !== 1 || routing.startId !== binding.startId || routing.rootDigest !== binding.rootDigest
    || !same(routing.runBinding, binding) || Object.keys(routing).some(k => !['version', 'startId', 'rootDigest', 'runBinding', 'records', 'tokenIndex', 'eventTips'].includes(k))) refuse('ROUTING_BINDING_DRIFT', 'Journal routing pin differs');
  for (const key of ['records', 'tokenIndex', 'eventTips']) if (!routing[key] || typeof routing[key] !== 'object' || Array.isArray(routing[key])) refuse('ROUTING_BINDING_MISSING', `Missing routing ${key}`);
  for (const record of Object.values(routing.records)) validateRoutingRecord(record, binding);
  const bindings = [binding, ...Object.values(routing.records).filter(r => r.type === 'run-binding')];
  const ancestors = new Set(); let cursor = binding;
  while (cursor) {
    if (ancestors.has(cursor.runId)) refuse('ROUTING_BINDING_DRIFT', 'Cyclic run continuation');
    ancestors.add(cursor.runId);
    if (cursor.previousRunId === null) break;
    const link = routing.records[cursor.continuationIntentId];
    const prior = bindings.filter(b => b.runId === cursor.previousRunId);
    if (prior.length !== 1 || link?.type !== 'continuation-intent' || link.previousRunId !== cursor.previousRunId
      || link.previousRevisionDigest !== prior[0].revisionDigest) refuse('ROUTING_BINDING_MISSING', 'Missing continuation ancestry');
    cursor = prior[0];
  }
  const history = continuationAncestors(binding, routing.records);
  for (const [id, record] of Object.entries(routing.records)) {
    if (id !== record.id) refuse('ROUTING_BINDING_DRIFT', 'Journal record map key differs');
    if (record.type === 'issuance') {
      const admission = routing.records[record.admissionId];
      const runPin = record.runId === binding.runId ? binding : Object.values(routing.records).find(r => r.type === 'run-binding' && r.runId === record.runId);
      if (!admission || routing.tokenIndex[record.issuanceToken] !== id) refuse('ROUTING_BINDING_MISSING', 'Issuance admission/index missing');
      if (record.priorRecordId) {
        const prior = routing.records[record.priorRecordId];
        if (prior?.type !== 'issuance') refuse('ROUTING_BINDING_MISSING', 'Retained predecessor issuance missing');
        if (prior.id === record.id || prior.admissionId !== record.admissionId) refuse('ROUTING_BINDING_DRIFT', 'Predecessor admission differs');
      }
      if (!ancestors.has(record.runId) || admission.type !== 'admission' || !same(admission.admitted, record.selected)
        || ['scopedStep', 'stage', 'logicalWaveId', 'logicalEpoch', 'logicalTaskId'].some(k => admission[k] !== record[k])
        || !runPin || record.revisionDigest !== runPin.revisionDigest) refuse('ROUTING_BINDING_DRIFT', 'Issuance admission/run mismatch');
    }
    if (record.type === 'continuation-intent') {
      const predecessors = bindings.filter(b => b.runId === record.previousRunId);
      if (predecessors.length !== 1) refuse('ROUTING_BINDING_MISSING', 'Continuation predecessor missing');
      const links = continuationAncestors(predecessors[0], routing.records);
      validateContinuationTransition(record.sourceGraph, record.completedTaskIds, links);
      const earlier = record.completedTaskIds.filter(taskId => !record.sourceGraph.tasks.some(task => task.id === taskId));
      const completionChain = earlier.map(taskId => {
        const owners = links.filter(link => link.removedTaskIds.includes(taskId));
        if (owners.length !== 1) refuse('ROUTING_CONTINUATION_HISTORY_DRIFT', 'Earlier completion lacks a unique retained transformation');
        return owners[0].id;
      });
      if (!same([...new Set(completionChain)].sort(), [...record.completionChain].sort())) refuse('ROUTING_CONTINUATION_HISTORY_DRIFT', 'Retained completion chain differs');
      for (const retained of record.bindings) {
        const admission = routing.records[retained.admissionId];
        const issuance = routing.records[retained.priorRecordId];
        if (admission?.type !== 'admission' || issuance?.type !== 'issuance') refuse('ROUTING_BINDING_MISSING', 'Continuation allocation evidence missing');
        if (issuance.admissionId !== admission.id || issuance.runId !== record.previousRunId || issuance.epoch !== retained.priorEngineEpoch
          || admission.allocationId !== retained.allocationId
          || ['scopedStep', 'stage', 'logicalWaveId', 'logicalEpoch', 'logicalTaskId'].some(k => retained[k] !== admission[k])) {
          refuse('ROUTING_BINDING_DRIFT', 'Continuation allocation evidence differs');
        }
      }
    }
    if (record.type === 'epoch-binding') {
      const runPin = bindings.find(b => b.runId === record.runId);
      const links = runPin?.runId === binding.runId ? history : runPin ? continuationAncestors(runPin, routing.records) : [];
      if (record.graph && links[0]?.bindings.some(b => b.scopedStep === record.scopedStep && b.stage === record.stage && b.logicalWaveId === record.logicalWaveId)) {
        validateContinuationTransition(record.graph, null, links);
      }
      if (!ancestors.has(record.runId)) refuse('ROUTING_BINDING_DRIFT', 'Epoch run is outside continuation chain');
      for (const [ids, type] of [[record.admissionIds, 'admission'], [record.issuanceIds, 'issuance']]) {
        if (new Set(ids).size !== ids.length || ids.some(id => routing.records[id]?.type !== type)) refuse('ROUTING_BINDING_MISSING', 'Missing/repeated epoch reference');
      }
      if (record.priorEpochBindingId) {
        const prior = routing.records[record.priorEpochBindingId];
        if (prior?.type !== 'epoch-binding' || prior.scopedStep !== record.scopedStep || prior.stage !== record.stage
          || prior.logicalEpoch > record.logicalEpoch || (record.runId === prior.runId && record.logicalEpoch !== prior.logicalEpoch + 1)) refuse('ROUTING_BINDING_DRIFT', 'Ambiguous or non-monotonic logical epoch');
      }
    }
    if (record.type === 'issuance-event') {
      const issuance = routing.records[record.issuanceId];
      if (!issuance || issuance.type !== 'issuance') refuse('ROUTING_BINDING_MISSING', 'Event issuance missing');
      if (issuance.issuanceToken !== record.issuanceToken) refuse('ROUTING_BINDING_DRIFT', 'Event token differs');
    }
  }
  for (const [token, id] of Object.entries(routing.tokenIndex)) {
    if (routing.records[id]?.type !== 'issuance' || routing.records[id].issuanceToken !== token) refuse('ROUTING_BINDING_MISSING', 'Token index references missing/wrong issuance');
  }
  for (const id of Object.keys(routing.eventTips)) if (routing.records[id]?.type !== 'issuance') refuse('ROUTING_BINDING_MISSING', 'Event tip issuance missing');
  for (const issuance of Object.values(routing.records).filter(r => r.type === 'issuance')) routingIssuanceState(routing, issuance.id);
  validateRoutingEvidence(routing);
  return routing;
}
/** Derive safety state without rewriting records or inferring acceptance from an epoch. */
export function routingIssuanceState(routing, issuanceId) {
  const issuance = routing.records[issuanceId];
  if (!issuance || issuance.type !== 'issuance') refuse('ROUTING_BINDING_MISSING', 'Expected issuance missing');
  let state = 'prepared'; let envelope = null;
  const seen = new Set();
  const events = Object.values(routing.records).filter(r => r.type === 'issuance-event' && r.issuanceId === issuanceId).sort((a, b) => a.sequence - b.sequence);
  const tip = routing.eventTips?.[issuanceId];
  if (!tip || !Number.isSafeInteger(tip.count) || tip.count < 0 || Object.keys(tip).sort().join(',') !== 'count,eventId'
    || tip.count !== events.length || tip.eventId !== (events.at(-1)?.id ?? null)) refuse('ROUTING_BINDING_MISSING', 'Missing or inconsistent issuance event tip');
  for (const event of events) {
    if (event.sequence !== seen.size) refuse('ROUTING_BINDING_MISSING', 'Missing/repeated event sequence');
    if (seen.has(event.event)) refuse('ROUTING_BINDING_DRIFT', 'Duplicate event transition');
    seen.add(event.event);
    if (event.issuanceToken !== issuance.issuanceToken) refuse('ROUTING_BINDING_DRIFT', 'Event token differs');
    if (event.event === 'launch-intent') {
      if (state !== 'prepared') refuse('ROUTING_BINDING_DRIFT', 'Launch must be the first event');
      state = 'launched';
    } else if (event.event === 'result-prepared') {
      if (!['launched', 'uncertain'].includes(state)) refuse('ROUTING_BINDING_DRIFT', 'Result requires a launch');
      envelope = event.envelope; state = 'result-prepared';
    } else if (event.event === 'uncertain') {
      if (!['launched', 'result-prepared'].includes(state)) refuse('ROUTING_BINDING_DRIFT', 'Uncertainty requires a launch');
      state = 'uncertain';
    } else if (event.event === 'settled') {
      if (!['launched', 'result-prepared', 'uncertain'].includes(state)) refuse('ROUTING_BINDING_DRIFT', 'Settlement requires a launch');
      const evidence = event.evidence;
      if (['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation', 'issuanceToken'].some(k => evidence[k] !== issuance[k])) refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Settlement identity differs');
      if (evidence.proofKind) validateSettlementProof(routing, issuance, evidence, envelope);
      else if (evidence.acceptedDispatchToken !== issuance.issuanceToken) refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Settlement lacks matching token-bound engine evidence');
      state = 'settled';
    }
  }
  return { state, envelope: structuredClone(envelope) };
}

/** Continuation preserves logical admissions while recording the physical graph transformation. */
export function createContinuationIntent({ start, oldBinding, resumeDetails, priorJournal, snapshot }) {
  validateRoutingStart(start); validateRoutingRecord(oldBinding, start);
  validateRoutingSnapshot(snapshot, { rootDigest: start.rootDigest, revisionDigest: oldBinding.revisionDigest, planIntentId: oldBinding.planIntentId });
  validateRoutingJournal(priorJournal.routing, oldBinding);
  const fail = message => refuse('ROUTING_CONTINUATION_AMBIGUOUS', message);
  if (snapshot.id !== oldBinding.runId || resumeDetails.previousRunId !== oldBinding.runId || routingDigest(snapshot.input) !== oldBinding.inputDigest) fail('Previous run identity differs');
  const records = Object.values(priorJournal.routing.records);
  for (const issuance of records.filter(r => r.type === 'issuance')) {
    const state = routingIssuanceState(priorJournal.routing, issuance.id).state;
    if (state !== 'settled') refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Prior issuance is not verifiably settled');
  }
  const sourceGraph = resumeDetails.originalGraph; const filteredGraph = resumeDetails.graph;
  function taskIds(graph) {
    if (!Array.isArray(graph?.tasks)) fail('Missing graph tasks');
    const ids = graph.tasks.map(t => t.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) fail('Missing/duplicate task ids');
    return ids;
  }
  const ids = taskIds(sourceGraph); taskIds(filteredGraph);
  validateContinuationTransition(sourceGraph, null, continuationAncestors(oldBinding, priorJournal.routing.records));
  const epochs = records.filter(r => r.type === 'epoch-binding' && r.runId === oldBinding.runId && r.graphDigest === routingDigest(sourceGraph) && snapshot.steps[r.scopedStep] && (snapshot.steps[r.scopedStep].epoch ?? 0) === r.epoch);
  if (epochs.length !== 1 || !same(epochs[0].graph, sourceGraph)) fail('Immediate source graph has no unique retained epoch binding');
  const epoch = epochs[0];
  if (epoch.sourceBinding) {
    const source = snapshot.steps[epoch.sourceBinding.scopedStep];
    if (source?.status !== 'succeeded' || source.acceptedDispatchToken !== epoch.sourceBinding.acceptedDispatchToken
      || (source.epoch ?? 0) !== epoch.sourceBinding.epoch || !same(source.output, epoch.sourceBinding.output)) fail('Allocation source evidence differs');
  }
  const completed = resumeDetails.completedTaskIds;
  if (!Array.isArray(completed) || new Set(completed).size !== completed.length || completed.some(id => typeof id !== 'string' || !id)) fail('Invalid cumulative completed ids');
  validateContinuationTransition(sourceGraph, completed, continuationAncestors(oldBinding, priorJournal.routing.records));
  const chains = records.filter(r => r.type === 'continuation-intent');
  const completionChain = [];
  const ancestorLinks = new Set(); let priorRun = oldBinding;
  while (priorRun.continuationIntentId) {
    const link = priorJournal.routing.records[priorRun.continuationIntentId];
    if (!link || ancestorLinks.has(link.id)) fail('Missing/cyclic retained completion chain');
    ancestorLinks.add(link.id);
    priorRun = records.find(r => r.type === 'run-binding' && r.runId === priorRun.previousRunId);
    if (!priorRun) fail('Missing earlier run binding');
  }
  for (const id of completed) {
    if (!ids.includes(id)) {
      const links = chains.filter(r => ancestorLinks.has(r.id) && r.removedTaskIds.includes(id));
      if (links.length !== 1) fail('Earlier completion is not uniquely explained by retained chain');
      completionChain.push(links[0].id);
    } else {
      const issuances = records.filter(r => r.type === 'issuance' && r.logicalTaskId === id && epoch.issuanceIds.includes(r.id));
      if (!issuances.length || !issuances.every(r => routingIssuanceState(priorJournal.routing, r.id).state === 'settled')) fail('Completion has no settled execution');
      if (!(resumeDetails.verifiedCompletedTaskIds ?? []).includes(id)) fail('Completion lacks validated bookkeeping/result evidence');
    }
  }
  const removedTaskIds = ids.filter(id => completed.includes(id)); const removedDependencies = [];
  const expected = { ...sourceGraph, tasks: sourceGraph.tasks.filter(t => !removedTaskIds.includes(t.id)).map(t => {
    if (!Array.isArray(t.depends_on) || t.depends_on.some(id => !ids.includes(id))) fail('Unexplained graph dependency');
    const depends_on = t.depends_on.filter(dependency => {
      if (!removedTaskIds.includes(dependency)) return true;
      removedDependencies.push({ taskId: t.id, dependency }); return false;
    });
    return { ...t, depends_on };
  }) };
  if (!same(expected, filteredGraph)) fail('Unexplained filtered graph edits');
  const indexMap = ids.map((taskId, oldIndex) => ({ taskId, oldIndex, newIndex: removedTaskIds.includes(taskId) ? null : filteredGraph.tasks.findIndex(t => t.id === taskId) }));
  if (resumeDetails.removedTaskIds && !same(resumeDetails.removedTaskIds, removedTaskIds)) fail('Removed task evidence differs');
  if (resumeDetails.removedDependencies && !same(resumeDetails.removedDependencies, removedDependencies)) fail('Removed dependency evidence differs');
  if (resumeDetails.indexMap && !same(resumeDetails.indexMap, indexMap)) fail('Index map differs');
  const bindings = filteredGraph.tasks.map(task => {
    const admissions = epoch.admissionIds.map(id => priorJournal.routing.records[id]).filter(r => r?.type === 'admission' && r.logicalTaskId === task.id);
    if (admissions.length !== 1) fail('Ambiguous logical task admission');
    const admission = admissions[0];
    const issuances = epoch.issuanceIds.map(id => priorJournal.routing.records[id]).filter(r => r?.type === 'issuance' && r.admissionId === admission.id);
    if (!issuances.length) fail('Missing previous issuance');
    const terminal = issuances.filter(r => !issuances.some(next => next.priorRecordId === r.id));
    if (terminal.length !== 1) fail('Ambiguous previous issuance chain');
    return { scopedStep: admission.scopedStep, stage: admission.stage, logicalWaveId: admission.logicalWaveId, logicalEpoch: admission.logicalEpoch,
      logicalTaskId: task.id, allocationId: admission.allocationId, priorEngineEpoch: terminal[0].epoch, admissionId: admission.id, priorRecordId: terminal[0].id };
  });
  const payload = { previousRunId: oldBinding.runId, previousRevisionDigest: oldBinding.revisionDigest,
    sourceGraph, sourceGraphDigest: routingDigest(sourceGraph), filteredGraph, filteredGraphDigest: routingDigest(filteredGraph),
    completedTaskIds: [...completed], removedTaskIds, completionChain: [...new Set(completionChain)], removedDependencies, indexMap, bindings };
  return validateRoutingRecord({ ...base(start, 'continuation-intent', routingDigest({ startId: start.startId, ...payload })), ...payload }, start);
}

/** Runner discovery uses the durable feature index, never the newest flow heuristic. */
export function pendingRoutingPlans({ cwd, featureCode }) {
  const dir = join(rootPath(cwd), 'features', routingDigest(featureCode));
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const pin = readJson(join(dir, name));
    const start = readRoutingStart({ cwd, ...pin });
    const intent = loadRecord(cwd, start, pin.planIntentId);
    const requested = existsSync(join(startDir(cwd, start.startId), 'records', `${intent.id}-requested.json`));
    const bound = existsSync(join(startDir(cwd, start.startId), 'plans', `${intent.id}.json`));
    const pointer = bound ? readJson(join(startDir(cwd, start.startId), 'plans', `${intent.id}.json`)) : null;
    const binding = pointer ? loadRecord(cwd, start, pointer.bindingId) : null;
    return { start, intent, requested, bound, binding };
  });
}
export function readRoutingRunBinding({ cwd, start, runId }) {
  return loadRecord(cwd, start, routingDigest({ runId, startId: start.startId }));
}

const joinTypes = new Set(['call-intent', 'call-resolution', 'call-evidence-head', 'unsupported-observation']);
const outcomeTypes = new Set(['wave-snapshot', 'gate-disposition', 'gate-acknowledgement', 'lineage-link', 'outcome']);
const evidenceConflict = message => refuse('ROUTING_CALL_EVIDENCE_CONFLICT', message);
const recordsOf = (routing, type) => Object.values(routing.records).filter(r => r.type === type);
const copy = value => structuredClone(value);
const evidenceId = (type, parts) => routingDigest({ type, ...parts });
function requiredRecord(routing, id, type) {
  const record = routing.records[id] ?? (routing.runBinding.id === id ? routing.runBinding : null);
  if (!record || (type && record.type !== type)) refuse('ROUTING_BINDING_MISSING', `Missing ${type ?? 'evidence'} ${id}`);
  return record;
}
function validateCallIdentity(value) {
  if ((value.callIdSource === 'absent') !== (value.callId === null)
    || (value.callId !== null && (!value.callId || /^(legacy:|compose:|engine:)/.test(value.callId)))) evidenceConflict('Call identity must be a connector invocation or explicitly absent');
}
export function validateRoutingJoin(record, pin) {
  validate(checkJoin, record);
  if (pin && (record.startId !== pin.startId || record.rootDigest !== pin.rootDigest)) evidenceConflict('Call root differs');
  if (record.type === 'unsupported-observation') validateEngineObservation(record);
  if (record.type === 'call-intent') {
    validateCallIdentity(record);
    if ((record.issuanceId === null) === (record.observationId === null)) evidenceConflict('Exactly one call owner is required');
  }
  if (record.type === 'call-resolution') {
    validateCallIdentity(record);
    const usage = record.usageEvidence;
    for (const k of ['tokens', 'durationMs', 'usd', 'model', 'effort']) {
      if (usage.presence[k] !== (usage[k] !== null)) evidenceConflict(`Raw ${k} presence differs`);
    }
    if (record.reportedModel !== usage.model || record.reportedEffort !== usage.effort) evidenceConflict('Reported execution differs from raw evidence');
    if (record.terminationEvidence.intentId !== record.intentId || record.terminationEvidence.callId !== record.callId) evidenceConflict('Termination binding differs');
    if (record.outcome !== 'unresolved' && record.terminationEvidence.kind === 'uncertain') evidenceConflict('Terminal outcome requires terminal evidence');
  }
  return record;
}
export function validateReceiptRouting(detail, routing) {
  validate(checkReceiptRouting, detail); validateCallIdentity(detail);
  if (detail.kind === 'route-metadata') {
    if (!detail.issuanceId || !detail.issuanceToken || detail.observationId !== null || detail.intentId !== null || detail.callId !== null || detail.parentRecordId !== null) evidenceConflict('Invalid route metadata identity');
  } else if (!detail.intentId || !detail.callId || ((detail.issuanceId === null) === (detail.observationId === null))) evidenceConflict('Paid receipt requires genuine call identity and one owner');
  if (routing) {
    if (detail.startId !== routing.startId || detail.rootDigest !== routing.rootDigest) evidenceConflict('Receipt root differs');
    const owner = requiredRecord(routing, detail.issuanceId ?? detail.observationId);
    const expected = routingReceiptDetail(routing, owner, detail.intentId ? requiredRecord(routing, detail.intentId, 'call-intent') : null);
    if (!same(expected, detail)) evidenceConflict('Receipt original binding differs');
  }
  return detail;
}
/** Stable receipt identity, derived only from retained records, never current engine state. */
export function routingReceiptDetail(routing, owner, intent = null) {
  const supported = owner.type === 'issuance';
  return { schemaVersion: 1, kind: intent ? 'paid-call' : 'route-metadata', startId: routing.startId, rootDigest: routing.rootDigest,
    ownerRunId: supported ? owner.runId : owner.ownerRunId, recordId: supported ? owner.id : owner.recordId,
    issuanceId: supported ? owner.id : null, issuanceToken: supported ? owner.issuanceToken : null,
    observationId: supported ? null : owner.id, parentRecordId: supported ? null : owner.parentRecordId,
    intentId: intent?.id ?? null, callId: intent?.callId ?? null, callIdSource: intent?.callIdSource ?? 'absent',
    scopedStep: owner.scopedStep, stage: owner.stage, epoch: owner.epoch, itemIndex: owner.itemIndex, generation: owner.generation,
    logicalTaskId: owner.logicalTaskId, logicalWaveId: owner.logicalWaveId, admissionId: supported ? owner.admissionId : null,
    itemBindingRef: supported ? (owner.stage === null ? null : owner.admissionId) : owner.itemBindingRef,
    selectedRouteRef: supported ? owner.id : null };
}
export function routingMetadataBundle(routing, issuance, journalLocator) {
  const binding = issuance.runId === routing.runBinding.runId ? routing.runBinding : recordsOf(routing, 'run-binding').find(r => r.runId === issuance.runId);
  if (!binding) refuse('ROUTING_BINDING_MISSING', 'Original receipt run missing');
  assertNoSymlinkPath(journalLocator);
  if (resolve(journalLocator) !== journalLocator) refuse('ROUTING_STORAGE_UNSAFE', 'Owner locator must be absolute and canonical');
  const owner = { ...base(routing, 'receipt-owner', evidenceId('receipt-owner', { runId: binding.runId })), ownerRunId: binding.runId,
    revisionDigest: binding.revisionDigest, journalLocator, runBindingId: binding.id };
  const dispatchId = `compose:route:${issuance.runId}:${issuance.issuanceToken}`;
  const detail = validateReceiptRouting(routingReceiptDetail(routing, issuance));
  const receipt = { dispatchId, stepId: issuance.scopedStep, source: 'compose:route', usage: {}, detail: { routing: detail } };
  const metadata = { ...base(routing, 'issuance-metadata', evidenceId('issuance-metadata', { issuanceId: issuance.id })),
    issuanceId: issuance.id, ownerId: owner.id, dispatchId, payloadDigest: routingDigest(receipt) };
  return { owner, metadata, receipt };
}

/** Cross-process lock. Only ESRCH proves a dead owner; EPERM is never reclaimed. */
export function acquireRoutingLock(lock, { timeoutMs = 5000 } = {}) {
  assertNoSymlinkPath(lock); directory(dirname(lock));
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();
  while (true) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const reclaim = `${lock}.reclaim`;
      let claimed = false;
      try {
        mkdirSync(reclaim); claimed = true;
        let owner;
        try { owner = readJson(join(lock, 'owner.json'), 'ROUTING_STORAGE_LOCKED'); } catch (e) { if (e.code !== 'ROUTING_STORAGE_LOCKED') throw e; }
        if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          let dead = false;
          try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
          if (dead) { rmSync(lock, { recursive: true }); syncDirectory(dirname(lock)); }
        }
      } catch (e) { if (e.code !== 'EEXIST' && e.code !== 'ENOENT') throw e; }
      finally { if (claimed) rmSync(reclaim, { recursive: true, force: true }); }
      if (Date.now() >= deadline) refuse('ROUTING_STORAGE_LOCKED', 'Routing writer is alive or owner death cannot be verified');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { immutable(join(lock, 'owner.json'), { pid: process.pid, nonce }); }
  catch (e) { rmSync(lock, { recursive: true, force: true }); throw e; }
  return () => {
    if (readJson(join(lock, 'owner.json')).nonce !== nonce) refuse('ROUTING_STORAGE_LOCKED', 'Lock ownership changed');
    rmSync(lock, { recursive: true }); syncDirectory(dirname(lock));
  };
}
function checkImprovement(previous, next) {
  if (!previous) return;
  for (const k of ['callId', 'reportedModel', 'reportedEffort', 'usageRef']) if (previous[k] !== null && !same(previous[k], next[k])) evidenceConflict(`Known ${k} changed`);
  for (const k of ['tokens', 'durationMs', 'usd', 'model', 'effort', 'provenance']) {
    if (previous.usageEvidence[k] !== null && !same(previous.usageEvidence[k], next.usageEvidence[k])) evidenceConflict(`Known usage ${k} changed`);
  }
  if (previous.outcome !== 'unresolved' && previous.outcome !== next.outcome) evidenceConflict('Terminal result changed');
  if (previous.launchOutcome !== 'uncertain' && previous.launchOutcome !== next.launchOutcome) evidenceConflict('Launch evidence changed');
  if (previous.terminationEvidence.kind !== 'uncertain' && !same(previous.terminationEvidence, next.terminationEvidence)) evidenceConflict('Confirmed termination changed');
}
export function latestRoutingCall(routing, intentId) {
  const intent = requiredRecord(routing, intentId, 'call-intent');
  const resolutions = recordsOf(routing, 'call-resolution').filter(r => r.intentId === intentId).sort((a, b) => a.sequence - b.sequence);
  const heads = recordsOf(routing, 'call-evidence-head').filter(r => r.intentId === intentId).sort((a, b) => a.sequence - b.sequence);
  if (heads.length !== resolutions.length) evidenceConflict('Missing call evidence head/tail');
  resolutions.forEach((r, index) => {
    const h = heads[index];
    if (r.sequence !== index || r.id !== evidenceId('call-resolution', { intentId, sequence: index })
      || r.previousResolutionId !== (resolutions[index - 1]?.id ?? null)
      || h.sequence !== index || h.count !== index + 1 || h.resolutionId !== r.id
      || h.previousHeadId !== (heads[index - 1]?.id ?? null)
      || h.id !== evidenceId('call-evidence-head', { intentId, sequence: index })) evidenceConflict('Call evidence chain gap or fork');
    if (intent.callId !== null && r.callId !== intent.callId) evidenceConflict('Connector identity changed');
    if (intent.transport === 'local-sdk' && r.reportedEffort !== null) evidenceConflict('Local configured effort is not reported evidence');
    checkImprovement(resolutions[index - 1], r);
  });
  return { intent, resolution: resolutions.at(-1) ?? null, head: heads.at(-1) ?? null };
}
/** Called inside the owner journal's atomic mutation; evidence and optional spool publish together. */
export function prepareRoutingResolution(routing, intentId, evidence) {
  const { intent, resolution: previous, head } = latestRoutingCall(routing, intentId);
  const sequence = previous ? previous.sequence + 1 : 0;
  const r = { ...base(routing, 'call-resolution', evidenceId('call-resolution', { intentId, sequence })), intentId, sequence,
    previousResolutionId: previous?.id ?? null, ...copy(evidence) };
  validateRoutingJoin(r, routing); checkImprovement(previous, r);
  if (intent.callId !== null && intent.callId !== r.callId) evidenceConflict('Resolution call identity differs from intent');
  const payload = value => { const { id, sequence, previousResolutionId, resolvedAt, ...rest } = value; return rest; };
  if (previous && same(payload(previous), payload(r))) return { resolution: previous, head, repeated: true };
  return { resolution: r, head: { ...base(routing, 'call-evidence-head', evidenceId('call-evidence-head', { intentId, sequence })), intentId, sequence,
    resolutionId: r.id, previousHeadId: head?.id ?? null, count: sequence + 1 }, repeated: false };
}
/** Capture raw presence explicitly. Callers must pass observed fields, never normalized defaults. */
export function routingUsageEvidence(raw = {}, { provenance = null } = {}) {
  const result = { tokens: null, durationMs: null, usd: null, model: null, effort: null, presence: {}, provenance, raw: copy(raw) };
  for (const k of ['tokens', 'durationMs', 'usd', 'model', 'effort']) {
    result[k] = Object.hasOwn(raw, k) && raw[k] !== undefined ? raw[k] : null;
    result.presence[k] = result[k] !== null;
  }
  return result;
}
/** Project independently retained engine bytes without minting a connector identity. */
export function prepareEngineReceiptEvidence({ ownerRunId, sequence, receipt }) {
  // Stratum's persisted ReceiptRecord stores costs in amount. Compose's retained
  // submission/spool ReceiptInput stores them in usage. Project one representation;
  // never rewrite the retained receipt or fill missing persisted fields from usage.
  const persisted = Object.hasOwn(receipt, 'amount');
  const amounts = persisted ? receipt.amount : receipt.usage;
  const raw = {};
  for (const [key, field] of [['tokens', 'tokens'], ['durationMs', 'ms'], ['usd', 'usd']]) {
    if (Object.hasOwn(amounts ?? {}, field)) raw[key] = amounts[field];
  }
  // Engine provenance includes legacy; connector usageEvidence has a separate schema.
  return { ownerRunId, sequence, receipt: copy(receipt),
    usageEvidence: routingUsageEvidence(raw, { provenance: receipt.usdSource ?? (persisted ? null : amounts?.usd_source) ?? null }) };
}
function validateEngineObservation(observation) {
  const evidence = observation.engineReceiptEvidence;
  if (observation.evidenceSource !== 'engine-receipt') {
    if (evidence !== null || observation.evidenceRef !== null) evidenceConflict('Non-receipt observation carries engine receipt evidence');
    return;
  }
  const ref = observation.evidenceRef;
  if (!ref || !evidence || evidence.ownerRunId !== observation.ownerRunId || ref.ownerRunId !== evidence.ownerRunId
    || ref.sequence !== evidence.sequence || ref.dispatchId !== evidence.receipt.dispatchId
    || ref.payloadDigest !== routingDigest(evidence.receipt)
    || !same(evidence, prepareEngineReceiptEvidence(evidence))) evidenceConflict('Engine receipt reference differs from retained bytes/amounts/provenance');
  if (evidence.receipt.detail?.routing || /^compose:/.test(ref.dispatchId)) evidenceConflict('Connector or metadata receipt cannot become engine evidence');
  if (/^legacy:/.test(ref.dispatchId) && ref.dispatchId !== `legacy:${ref.sequence}`) evidenceConflict('Legacy receipt sequence differs');
  if (observation.parentRecordId !== null || observation.parentIntentId !== null) evidenceConflict('Engine receipt cannot acquire connector parent identity');
}
function engineReceiptCost(observation) {
  validateEngineObservation(observation);
  const usage = observation.engineReceiptEvidence.usageEvidence;
  const { sequence, ...ref } = observation.evidenceRef;
  return { tokens: usage.tokens, durationMs: usage.durationMs, usd: usage.usd,
    provenance: usage.provenance ? [usage.provenance] : [], paidReceiptRefs: [copy(ref)] };
}
function frozen(value) { for (const v of Object.values(value)) if (v && typeof v === 'object') frozen(v); return Object.freeze(value); }
/** Dispatch 2 passes this immutable observer through internal options; this factory never launches. */
export function bindRoutingCalls({ artifacts, issuanceId = null, observationId = null }) {
  if (!artifacts?.exportRoutingJournal) refuse('ROUTING_BINDING_MISSING', 'Participating calls require a real owner journal');
  const routing = artifacts.exportRoutingJournal();
  if ((issuanceId === null) === (observationId === null)) evidenceConflict('Exactly one observer owner is required');
  const owner = requiredRecord(routing, issuanceId ?? observationId, issuanceId ? 'issuance' : 'unsupported-observation');
  const ownerRunId = issuanceId ? owner.runId : owner.ownerRunId;
  if (ownerRunId !== artifacts.runId) evidenceConflict('Open the original owner journal before binding calls');
  const binding = frozen({ startId: routing.startId, rootDigest: routing.rootDigest, ownerRunId, ownerJournal: artifacts.journalPath,
    issuanceId, observationId, recordId: issuanceId ?? owner.recordId, parentRecordId: owner.parentRecordId ?? null });
  return Object.freeze({ binding,
    intent({ callSite, purpose = 'primary', transport, callId = null, profileIntent, intendedAt = new Date().toISOString() }) {
      return artifacts.recordRoutingCallIntent({ binding, callSite, purpose, transport, callId, callIdSource: callId === null ? 'absent' : 'connector-invocation', profileIntent, intendedAt });
    },
    resolve(intentId, { outcome, launchOutcome, usage = routingUsageEvidence(), terminationEvidence, usageRef = null, incompleteReasons = [], resolvedAt = new Date().toISOString() }, receipt = null) {
      const intent = artifacts.readRoutingRecord(intentId);
      if (intent.recordId !== binding.recordId || intent.ownerRunId !== binding.ownerRunId) evidenceConflict('Observer cannot resolve another call');
      return artifacts.recordRoutingCallResolution({ intentId, evidence: { outcome, launchOutcome, callId: intent.callId, callIdSource: intent.callIdSource,
        reportedModel: usage.model, reportedEffort: usage.effort, usageEvidence: usage, usageRef, terminationEvidence, incompleteReasons, resolvedAt }, receipt });
    },
    child({ parentIntentId, unsupportedReason = 'normalization-repair', callSite }) {
      const parent = artifacts.readRoutingRecord(parentIntentId);
      if (parent.recordId !== binding.recordId) evidenceConflict('Child parent differs');
      const observation = artifacts.recordRoutingObservation({ unsupportedReason, parentRecordId: binding.recordId, parentIntentId,
        callSite, evidenceSource: 'connector', context: owner });
      return bindRoutingCalls({ artifacts, observationId: observation.id });
    },
  });
}

export function validateRoutingOutcome(record, pin) {
  validate(checkOutcome, record);
  if (pin && (record.startId !== pin.startId || record.rootDigest !== pin.rootDigest)) refuse('ROUTING_BINDING_DRIFT', 'Outcome root differs');
  if (record.type === 'outcome') validateOutcomeClassification(record);
  return record;
}
function validateOutcomeClassification(record) {
  const expected = record.label === 'accepted' ? 'positive' : ['repaired', 'retried-same-epoch'].includes(record.label) ? 'negative'
    : record.label === 'failed-or-cancelled' && record.censorReason === null ? 'negative' : 'excluded';
  if (record.binary !== expected) refuse('ROUTING_BINDING_DRIFT', 'Outcome binary differs from label/cause');
}
function snapshotItems(snapshot) { return [...snapshot.waves.flatMap(w => w.items), ...snapshot.ordinaryIssuances]; }
export function routingGateRequest(routing, disposition) {
  const snapshot = requiredRecord(routing, disposition.snapshotId, 'wave-snapshot');
  return { runId: disposition.runId, revisionDigest: snapshot.revisionDigest, gateStepId: disposition.gateStepId,
    gateToken: disposition.gateToken, gateOrdinal: disposition.gateOrdinal, decision: copy(disposition.finalProposedDecision) };
}
function tokenAcknowledged(routing, dispositionId) {
  return recordsOf(routing, 'gate-acknowledgement').some(a => a.dispositionId === dispositionId && ['token-response', 'token-engine-witness'].includes(a.reconciliation));
}
function validateLineage(routing, link, proposalOwner = null) {
  const disposition = requiredRecord(routing, link.dispositionId, 'gate-disposition');
  if (proposalOwner && proposalOwner.id !== disposition.id) refuse('ROUTING_BINDING_DRIFT', 'Proposal belongs to another disposition');
  if (proposalOwner && link.relation !== 'retained' && [link.toSnapshotId, link.toAdmissionId, link.toIssuanceId].some(id => id !== null)) refuse('ROUTING_BINDING_DRIFT', 'Replacement proposal must precede completed target evidence');
  if (link.relation !== 'added') {
    const evidence = disposition.dispositions.filter(d => d.issuanceId === link.fromIssuanceId);
    if (evidence.length !== 1 || evidence[0].relation !== link.relation
      || evidence[0].defective !== (link.relation === 'repaired')) refuse('ROUTING_BINDING_DRIFT', 'Lineage contradicts per-issuance relation/defect evidence');
  }
  if (!proposalOwner) {
    const keys = ['dispositionId', 'relation', 'fromSnapshotId', 'fromAdmissionId', 'fromIssuanceId', 'proposedTaskDigest'];
    const proposals = disposition.lineage.filter(p => keys.every(k => p[k] === link[k])
      && ['toSnapshotId', 'toAdmissionId', 'toIssuanceId'].every(k => p[k] === null || p[k] === link[k]));
    if (!proposals.length) refuse('ROUTING_BINDING_DRIFT', 'Lineage target has no matching retained disposition proposal');
  }
  if (link.relation === 'added' && [link.fromSnapshotId, link.fromAdmissionId, link.fromIssuanceId].some(x => x !== null)) refuse('ROUTING_BINDING_DRIFT', 'Added work cannot have a predecessor');
  if (link.relation !== 'added' && (!link.fromSnapshotId || !link.fromAdmissionId || !link.fromIssuanceId)) refuse('ROUTING_BINDING_MISSING', 'Lineage predecessor missing');
  const endpoints = [];
  for (const side of ['from', 'to']) {
    if (link[`${side}SnapshotId`]) requiredRecord(routing, link[`${side}SnapshotId`], 'wave-snapshot');
    if (link[`${side}AdmissionId`]) requiredRecord(routing, link[`${side}AdmissionId`], 'admission');
    const issuanceId = link[`${side}IssuanceId`];
    if (!issuanceId) continue;
    const issuance = requiredRecord(routing, issuanceId, 'issuance');
    const admission = requiredRecord(routing, link[`${side}AdmissionId`], 'admission');
    const snapshot = requiredRecord(routing, link[`${side}SnapshotId`], 'wave-snapshot');
    const items = snapshotItems(snapshot).filter(item => item.issuanceId === issuanceId && item.admissionId === admission.id);
    if (issuance.admissionId !== admission.id || items.length !== 1) refuse('ROUTING_BINDING_DRIFT', 'Lineage endpoint is not retained in its snapshot');
    if (side === 'to' && link.proposedTaskDigest !== items[0].itemDigest) refuse('ROUTING_BINDING_DRIFT', 'Proposed task digest differs from retained target');
    endpoints.push(issuance);
  }
  if (endpoints.length === 2 && (endpoints[0].scopedStep !== endpoints[1].scopedStep || endpoints[0].stage !== endpoints[1].stage
    || endpoints[1].logicalEpoch < endpoints[0].logicalEpoch || (link.relation !== 'retained' && endpoints[0].id === endpoints[1].id))) refuse('ROUTING_BINDING_DRIFT', 'Lineage scope/epoch differs');
  if (link.fromSnapshotId && ![disposition.snapshotId, ...requiredRecord(routing, disposition.snapshotId).priorSnapshotIds].includes(link.fromSnapshotId)) refuse('ROUTING_BINDING_DRIFT', 'Lineage predecessor is outside disposition history');
  if (!link.toIssuanceId && !link.proposedTaskDigest) refuse('ROUTING_BINDING_MISSING', 'Future lineage requires a retained proposed task digest');
}
function validateSnapshot(routing, snapshot) {
  const pin = [routing.runBinding, ...recordsOf(routing, 'run-binding')].find(r => r.runId === snapshot.runId);
  if (!pin || pin.revisionDigest !== snapshot.revisionDigest) refuse('ROUTING_BINDING_DRIFT', 'Snapshot run/revision differs');
  for (const id of [...snapshot.sourceRefs, ...snapshot.priorSnapshotIds]) requiredRecord(routing, id);
  for (const wave of snapshot.waves) {
    const epoch = requiredRecord(routing, wave.epochBindingId, 'epoch-binding');
    if (['runId', 'scopedStep', 'stage', 'epoch', 'logicalWaveId', 'logicalEpoch'].some(k => wave[k] !== epoch[k])) refuse('ROUTING_BINDING_DRIFT', 'Snapshot wave identity differs');
    if (wave.sourceRef) requiredRecord(routing, wave.sourceRef);
  }
  for (const item of snapshotItems(snapshot)) {
    if (routingDigest(item.fullItem) !== item.itemDigest) refuse('ROUTING_BINDING_DRIFT', 'Snapshot full item digest differs');
    if (item.priorSnapshotId) requiredRecord(routing, item.priorSnapshotId, 'wave-snapshot');
    if (item.admissionId) {
      const admission = requiredRecord(routing, item.admissionId, 'admission');
      if (item.itemDigest !== admission.inputDigest) refuse('ROUTING_BINDING_DRIFT', 'Snapshot item differs from full admitted input');
    }
    if (!item.issuanceId) { if (item.issuanceToken !== null) refuse('ROUTING_BINDING_DRIFT', 'Unissued snapshot has a token'); continue; }
    const issuance = requiredRecord(routing, item.issuanceId, 'issuance');
    if (['admissionId', 'issuanceToken', 'logicalTaskId', 'itemIndex', 'generation', 'stage'].some(k => item[k] !== issuance[k])) refuse('ROUTING_BINDING_DRIFT', 'Snapshot original issuance differs');
  }
}
function validateSettlementProof(routing, issuance, evidence, envelope) {
  if (evidence.proofKind === 'failure-acknowledgement') {
    const request = evidence.request;
    if (!envelope || !same(envelope, request.envelope) || request.dispatchToken !== issuance.issuanceToken
      || ['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation'].some(k => request[k] !== issuance[k])
      || routingDigest(request) !== evidence.requestDigest || evidence.status !== 'failed'
      || evidence.response.acknowledged !== true || evidence.response.status !== 'failed') refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Failure lacks acknowledged original request');
  } else if (evidence.proofKind === 'cancellation-audit') {
    if (evidence.audit.runId !== issuance.runId || evidence.audit.revisionDigest !== issuance.revisionDigest || evidence.audit.status !== 'cancelled') refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Cancellation audit differs');
    const intents = inclusiveIntents(routing, issuance.id);
    if (!intents.length) refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Cancellation lacks call census');
    const resolutions = evidence.terminationRefs.map(id => requiredRecord(routing, id, 'call-resolution'));
    if (resolutions.some(r => r.terminationEvidence.kind === 'uncertain' || !intents.some(i => i.id === r.intentId))
      || !same(resolutions.map(r => r.intentId).sort(), intents.map(i => i.id).sort())
      || intents.some(i => latestRoutingCall(routing, i.id).resolution?.terminationEvidence.kind === 'uncertain')) refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Cancellation lacks every call termination');
  } else refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Unknown settlement proof');
}
function inclusiveIntents(routing, recordId, visited = new Set()) {
  if (visited.has(recordId)) evidenceConflict('Cyclic call parent');
  visited.add(recordId);
  return [...recordsOf(routing, 'call-intent').filter(r => r.recordId === recordId),
    ...recordsOf(routing, 'unsupported-observation').filter(r => r.parentRecordId === recordId).flatMap(r => inclusiveIntents(routing, r.recordId, visited))];
}
function validateRoutingEvidence(routing) {
  const owners = recordsOf(routing, 'receipt-owner');
  for (const owner of owners) {
    const pin = requiredRecord(routing, owner.runBindingId, 'run-binding');
    if (pin.runId !== owner.ownerRunId || pin.revisionDigest !== owner.revisionDigest || resolve(owner.journalLocator) !== owner.journalLocator) refuse('ROUTING_BINDING_DRIFT', 'Receipt owner differs');
    assertNoSymlinkPath(owner.journalLocator);
    if (owners.filter(o => o.ownerRunId === owner.ownerRunId).length !== 1) evidenceConflict('Competing receipt owners');
  }
  for (const observation of recordsOf(routing, 'unsupported-observation')) inclusiveIntents(routing, observation.id);
  for (const snapshot of recordsOf(routing, 'wave-snapshot')) {
    const visit = (id, seen = new Set()) => {
      if (seen.has(id)) refuse('ROUTING_BINDING_DRIFT', 'Snapshot history cycle');
      const next = new Set([...seen, id]);
      for (const prior of requiredRecord(routing, id, 'wave-snapshot').priorSnapshotIds) visit(prior, next);
    };
    visit(snapshot.id);
  }
  for (const issuance of recordsOf(routing, 'issuance')) latestRoutingOutcome(routing, issuance.id);
  for (const r of Object.values(routing.records)) {
    if (!r.type) refuse('ROUTING_SCHEMA_INVALID', 'Ledger versions cannot be journal records');
    if (r.type === 'admission') for (const ref of r.repairContext.evidenceRefs ?? []) requiredRecord(routing, ref);
    if (r.type === 'issuance-metadata') {
      const issuance = requiredRecord(routing, r.issuanceId, 'issuance');
      const owner = requiredRecord(routing, r.ownerId, 'receipt-owner');
      const expected = routingMetadataBundle(routing, issuance, owner.journalLocator);
      if (!same(r, expected.metadata) || !same(owner, expected.owner)) evidenceConflict('Metadata bundle differs');
    }
    if (r.type === 'issuance' && r.observationVersion === 1 && !recordsOf(routing, 'issuance-metadata').some(m => m.issuanceId === r.id)) refuse('ROUTING_BINDING_MISSING', 'S1b issuance metadata missing');
    if (r.type === 'unsupported-observation' || r.type === 'call-intent') {
      const owner = owners.find(o => o.ownerRunId === r.ownerRunId);
      if (!owner || owner.journalLocator !== r.ownerJournal) evidenceConflict('Call/observation original owner differs');
      if (r.parentRecordId) {
        const parent = requiredRecord(routing, r.parentRecordId);
        if ((parent.runId ?? parent.ownerRunId) !== r.ownerRunId) evidenceConflict('Child call crosses physical owner');
      }
      if (r.type === 'unsupported-observation') {
        if (r.recordId !== r.id) evidenceConflict('Unsupported record identity differs');
        if (r.parentIntentId && requiredRecord(routing, r.parentIntentId, 'call-intent').recordId !== r.parentRecordId) evidenceConflict('Parent intent differs');
      } else {
        const binding = requiredRecord(routing, r.issuanceId ?? r.observationId, r.issuanceId ? 'issuance' : 'unsupported-observation');
        if (binding.evidenceSource && binding.evidenceSource !== 'connector') evidenceConflict('Engine observation cannot own connector calls');
        if (r.recordId !== (r.issuanceId ?? binding.recordId) || r.parentRecordId !== (binding.parentRecordId ?? null) || (binding.runId ?? binding.ownerRunId) !== r.ownerRunId
          || (r.callId !== null && routing.tokenIndex[r.callId])) evidenceConflict('Call uses another owner or an engine token');
        if (r.callId !== null && recordsOf(routing, 'call-intent').some(other => other.id !== r.id && other.callId === r.callId)) evidenceConflict('Connector identity belongs to multiple intents');
        const slots = recordsOf(routing, 'call-intent').filter(i => i.recordId === r.recordId && i.callSlot === r.callSlot);
        if (slots.length !== 1) evidenceConflict('Call slot fork');
        latestRoutingCall(routing, r.id);
      }
    }
    if (['call-resolution', 'call-evidence-head'].includes(r.type)) {
      const intent = requiredRecord(routing, r.intentId, 'call-intent');
      if (r.usageRef && (r.usageRef.ownerRunId !== intent.ownerRunId || r.usageRef.dispatchId !== intent.callId)) evidenceConflict('Receipt reference is not the original call');
    }
    if (r.type === 'evidence-checkpoint') {
      for (const id of r.heads) requiredRecord(routing, id, 'call-evidence-head');
      for (const id of r.outcomeIds) requiredRecord(routing, id, 'outcome');
    }
    if (r.type === 'wave-snapshot') validateSnapshot(routing, r);
    if (r.type === 'gate-disposition') {
      const snap = requiredRecord(routing, r.snapshotId, 'wave-snapshot');
      if (['runId', 'gateStepId', 'gateToken'].some(k => r[k] !== snap[k])) refuse('ROUTING_BINDING_DRIFT', 'Gate disposition differs from snapshot');
      if (r.findingsRef) requiredRecord(routing, r.findingsRef);
      for (const d of r.dispositions) requiredRecord(routing, d.issuanceId, 'issuance');
      for (const link of r.lineage) validateLineage(routing, link, r);
    }
    if (r.type === 'lineage-link') validateLineage(routing, r);
    if (r.type === 'gate-acknowledgement') {
      const disposition = requiredRecord(routing, r.dispositionId, 'gate-disposition');
      const request = routingGateRequest(routing, disposition);
      if (r.requestDigest !== routingDigest(request)) refuse('ROUTING_BINDING_DRIFT', 'Gate acknowledgement request digest differs');
      if (r.reconciliation.startsWith('token-')) {
        if (!r.witness || !same(r.witness.request, request)) refuse('ROUTING_BINDING_DRIFT', 'Gate acknowledgement lacks exact request');
        if (r.reconciliation === 'token-response' && r.witness.response?.status !== 'acknowledged') refuse('ROUTING_BINDING_DRIFT', 'Gate response is not acknowledged');
        if (r.reconciliation === 'token-engine-witness') {
          const e = r.witness.engineEvidence;
          const { gateToken, ...rest } = request;
          if (!e || !same(e, { ...rest, consumedGateToken: gateToken })) refuse('ROUTING_BINDING_DRIFT', 'Engine witness lacks consumed token/round');
        }
      }
      const competing = recordsOf(routing, 'gate-disposition').filter(d => d.runId === disposition.runId && d.gateStepId === disposition.gateStepId && d.gateOrdinal === disposition.gateOrdinal && d.id !== disposition.id);
      if (r.reconciliation.startsWith('token-') && competing.some(d => tokenAcknowledged(routing, d.id) && !same(routingGateRequest(routing, d), request))) refuse('ROUTING_BINDING_DRIFT', 'Conflicting gate round acknowledgements');
    }
    if (r.type === 'outcome') {
      requiredRecord(routing, r.issuanceId, 'issuance');
      for (const ref of r.evidenceRefs) requiredRecord(routing, ref);
      if (r.previousOutcomeId && requiredRecord(routing, r.previousOutcomeId, 'outcome').issuanceId !== r.issuanceId) refuse('ROUTING_BINDING_DRIFT', 'Outcome predecessor differs');
      if (recordsOf(routing, 'outcome').filter(o => o.issuanceId === r.issuanceId && o.previousOutcomeId === r.previousOutcomeId).length !== 1) refuse('ROUTING_BINDING_DRIFT', 'Outcome chain fork');
    }
  }
}
/** Validate payloads at write/reload, including the local part of inherited bundles. */
export function validateRoutingReceiptSpool(journal, journalPath) {
  const routing = journal.routing;
  if (!routing) return journal;
  for (const owner of recordsOf(routing, 'receipt-owner').filter(o => o.ownerRunId === journal.runId)) {
    if (owner.journalLocator !== journalPath) evidenceConflict('Owner journal locator changed');
  }
  const seen = new Set();
  for (const pending of journal.pendingUsageReceipts ?? []) {
    if (!pending.receipt?.detail?.routing) continue;
    if (seen.has(pending.dispatchId) || pending.dispatchId !== pending.receipt.dispatchId) evidenceConflict('Receipt spool id differs or repeats');
    seen.add(pending.dispatchId);
    validateReceiptRouting(pending.receipt.detail.routing, routing);
    if (pending.receipt.detail.routing.ownerRunId !== journal.runId) evidenceConflict('Spool migrated to another physical run');
    if (!['pending', 'acknowledged'].includes(pending.state)) evidenceConflict('Receipt delivery state invalid');
  }
  for (const metadata of recordsOf(routing, 'issuance-metadata')) {
    const owner = requiredRecord(routing, metadata.ownerId, 'receipt-owner');
    if (owner.ownerRunId !== journal.runId) continue;
    const pending = journal.pendingUsageReceipts?.find(p => p.dispatchId === metadata.dispatchId);
    if (!pending || routingDigest(pending.receipt) !== metadata.payloadDigest) refuse('ROUTING_BINDING_MISSING', 'Atomic issuance metadata spool missing or changed');
  }
  for (const observation of recordsOf(routing, 'unsupported-observation')) {
    if (observation.evidenceSource !== 'engine-receipt' || observation.ownerRunId !== journal.runId) continue;
    const ref = observation.evidenceRef;
    const pending = journal.pendingUsageReceipts?.find(p => p.dispatchId === ref.dispatchId);
    if (pending && (routingDigest(pending.receipt) !== ref.payloadDigest || (pending.seq ?? null) !== ref.sequence)) evidenceConflict('Engine retained receipt differs from original spool');
  }
  for (const resolution of recordsOf(routing, 'call-resolution')) {
    const ref = resolution.usageRef;
    if (!ref || ref.ownerRunId !== journal.runId) continue;
    const pending = journal.pendingUsageReceipts?.find(p => p.dispatchId === ref.dispatchId);
    if (!pending || routingDigest(pending.receipt) !== ref.payloadDigest || pending.receipt.detail.routing.intentId !== resolution.intentId) evidenceConflict('Call resolution spool binding differs');
    for (const [raw, paid] of [['tokens', 'tokens'], ['durationMs', 'ms'], ['usd', 'usd']]) {
      if ((pending.receipt.usage?.[paid] ?? null) !== resolution.usageEvidence[raw]) evidenceConflict('Paid receipt amount differs from raw call evidence');
    }
    if (resolution.usageEvidence.usd !== null && resolution.usageEvidence.provenance !== (pending.receipt.usdSource ?? pending.receipt.usage?.usd_source ?? null)) evidenceConflict('Paid receipt provenance differs from raw evidence');
  }
  return journal;
}

const classification = (label, binary, derivation, censorReason = null) => ({ label, binary, derivation, censorReason });
/** Evidence-only classification; terminal application success is deliberately not an input. */
export function deriveRoutingOutcome(routing, issuanceId) {
  validateRoutingJournal(routing, routing.runBinding);
  const issuance = requiredRecord(routing, issuanceId, 'issuance');
  const events = recordsOf(routing, 'issuance-event').filter(e => e.issuanceId === issuanceId);
  const settlement = events.find(e => e.event === 'settled');
  if (settlement?.evidence.proofKind === 'cancellation-audit') return classification('failed-or-cancelled', 'excluded', 'confirmed-cancellation', 'cancelled');
  if (!settlement) return classification('unknown', 'excluded', 'unsettled-issuance', 'uncertain-settlement');
  const links = recordsOf(routing, 'lineage-link').filter(l => l.fromIssuanceId === issuanceId && tokenAcknowledged(routing, l.dispositionId));
  const valid = links.filter(l => {
    const d = requiredRecord(routing, l.dispositionId);
    return d.partitionCheck === 'valid' && d.ownershipCheck === 'valid';
  });
  if (links.length !== valid.length) return classification('unknown', 'excluded', 'ambiguous-gate-evidence', 'ambiguous-lineage');
  const replacements = valid.filter(l => ['repaired', 're-implemented'].includes(l.relation) && l.toIssuanceId);
  if (new Set(replacements.map(l => l.relation)).size > 1) return classification('unknown', 'excluded', 'conflicting-dispositions', 'ambiguous-lineage');
  if (replacements.some(l => l.relation === 'repaired')) return classification('repaired', 'negative', 'linked-defect-replacement');
  if (replacements.some(l => l.relation === 're-implemented')) return classification('re-implemented', 'excluded', 'linked-non-defect-replacement', 'non-defect-supersession');
  if (recordsOf(routing, 'issuance').some(i => i.priorRecordId === issuanceId && i.runId === issuance.runId && i.epoch === issuance.epoch)) return classification('retried-same-epoch', 'negative', 'same-epoch-reissuance');
  if (settlement.evidence.status === 'failed') return classification('failed-or-cancelled', 'negative', 'acknowledged-failure');
  if (settlement.evidence.status === 'cancelled') return classification('unknown', 'excluded', 'unresolved-cancellation-cause', 'unconfirmed-cancellation');
  const dispositions = recordsOf(routing, 'gate-disposition').filter(d => d.dispositions.some(x => x.issuanceId === issuanceId));
  if (dispositions.some(d => !tokenAcknowledged(routing, d.id) || d.partitionCheck !== 'valid' || d.ownershipCheck !== 'valid')) return classification('unknown', 'excluded', 'unconfirmed-or-ambiguous-disposition', 'missing-gate-proof');
  const retained = dispositions.some(d => d.dispositions.some(x => x.issuanceId === issuanceId && x.relation === 'retained')
    && snapshotItems(requiredRecord(routing, d.snapshotId)).some(item => item.issuanceId === issuanceId && item.status === 'succeeded' && item.acceptedDispatchToken === issuance.issuanceToken));
  const superseding = dispositions.some(d => d.dispositions.some(x => x.issuanceId === issuanceId && x.relation !== 'retained'));
  if (retained && !superseding && settlement.evidence.status === 'succeeded' && settlement.evidence.acceptedDispatchToken === issuance.issuanceToken) return classification('accepted', 'positive', 'token-bound-downstream-retention');
  return classification('unknown', 'excluded', 'no-adjudicated-downstream-outcome', 'missing-lineage');
}
/** Repair stratum recording only. No tier ordering or floor computation. */
export function deriveRoutingContext(routing, issuanceId, visited = new Set()) {
  const unknown = { waveKind: 'unknown', ancestryUnknown: true, repairOfRecordId: null, repairDepth: null, repairLineageRefs: null };
  if (visited.has(issuanceId)) return unknown;
  visited.add(issuanceId);
  const issuance = requiredRecord(routing, issuanceId, 'issuance');
  const admission = requiredRecord(routing, issuance.admissionId, 'admission');
  if (issuance.priorRecordId) {
    const prior = requiredRecord(routing, issuance.priorRecordId, 'issuance');
    if (prior.runId === issuance.runId && prior.epoch === issuance.epoch) {
      const context = deriveRoutingContext(routing, prior.id, visited);
      return { ...context, waveKind: 'retry' };
    }
  }
  const links = recordsOf(routing, 'lineage-link').filter(l => l.toIssuanceId === issuanceId && l.relation === 'repaired');
  const unique = [...new Map(links.map(l => [l.fromIssuanceId, l])).values()];
  if (unique.length === 1 && links.every(l => {
    const d = requiredRecord(routing, l.dispositionId);
    return tokenAcknowledged(routing, d.id) && d.partitionCheck === 'valid' && d.ownershipCheck === 'valid';
  })) {
    const prior = requiredRecord(routing, unique[0].fromIssuanceId, 'issuance');
    const primary = recordsOf(routing, 'call-intent').filter(i => i.issuanceId === prior.id && i.purpose === 'primary');
    if (!primary.some(i => latestRoutingCall(routing, i.id).resolution?.launchOutcome === 'executed')) return unknown;
    const context = deriveRoutingContext(routing, prior.id, visited);
    if (context.repairDepth === null) return unknown;
    return { waveKind: 'repair', ancestryUnknown: false, repairOfRecordId: prior.id, repairDepth: context.repairDepth + 1, repairLineageRefs: links.map(l => l.id).sort() };
  }
  if (links.length || admission.repairContext.state === 'repair' || admission.repairContext.state === 'unknown') return unknown;
  // An initial physical AND logical epoch supplies the fresh boundary. Later epochs
  // with S1a's not-evaluated marker cannot establish whether work is fresh or repair.
  if (admission.epoch === 0 && admission.logicalEpoch === 0 && !issuance.priorRecordId) return { waveKind: 'fresh', ancestryUnknown: false, repairOfRecordId: null, repairDepth: 0, repairLineageRefs: [] };
  return unknown;
}
export function routingExecutedTier(start, intent, resolution) {
  const unavailable = reason => ({ value: null, source: reason, evidenceRefs: resolution ? [resolution.id] : [] });
  if (intent.transport === 'local-sdk') return unavailable('local-transport-omits-effort');
  if (!resolution || resolution.launchOutcome !== 'executed' || !resolution.reportedModel || !resolution.reportedEffort) return unavailable('missing-reported-execution');
  const candidates = Object.values(start.mappings).filter(m => m.provider === intent.profileIntent.provider && m.modelID === resolution.reportedModel && m.effort === resolution.reportedEffort && m.tier !== null);
  const tiers = [...new Set(candidates.map(m => m.tier))];
  return tiers.length === 1 ? { value: tiers[0], source: 'reported-primary-pinned-mapping', evidenceRefs: [resolution.id] } : unavailable('unmapped-or-conflicting-execution');
}
export function routingEligible(row, { key = row.key, tier = null, cohort = 'static', source = row.source, waveKind = row.context.waveKind, requireExecutedTier = false } = {}) {
  validateRoutingLedgerRow(row);
  if (!row.issuance || row.source === 'unsupported' || row.completeness.state !== 'complete' || row.outcome.binary === 'excluded'
    || row.context.ancestryUnknown || row.key !== key || row.source !== source || row.context.waveKind !== waveKind || cohort !== 'static') return false;
  const primary = row.calls.filter(c => c.intent.issuanceId === row.issuance.id && c.intent.purpose === 'primary');
  const executed = [...new Set(primary.map(c => c.executedTier.value))];
  return !(requireExecutedTier || tier !== null) || (executed.length === 1 && executed[0] !== null && (tier === null || tier === executed[0]));
}
export function validateRoutingLedgerRow(row) {
  validate(checkLedgerRow, row);
  validateOutcomeClassification(row.outcome);
  if ((row.issuance === null) === (row.observation === null) || (row.source === 'unsupported') !== (row.observation !== null)) evidenceConflict('Ledger source/owner differs');
  const owner = row.issuance ?? row.observation;
  if (row.observation) validateRoutingJoin(row.observation, row);
  if (row.issuance && (row.key !== row.issuance.key || row.source !== row.issuance.selected.provenance.source)) evidenceConflict('Ledger key/source differs');
  if (row.recordId !== (row.issuance?.id ?? row.observation.recordId) || row.startId !== owner.startId || row.rootDigest !== owner.rootDigest) evidenceConflict('Ledger root/identity differs');
  const c = row.context;
  if (c.ancestryUnknown !== (c.repairDepth === null || c.repairLineageRefs === null)
    || (c.waveKind === 'unknown' && !c.ancestryUnknown)
    || (['fresh', 'repair'].includes(c.waveKind) && c.ancestryUnknown)) evidenceConflict('Context ancestry knowledge differs from retained depth/lineage');
  if (row.issuance && c.ancestryUnknown && row.completeness.state === 'complete') evidenceConflict('Unknown ancestry cannot be complete');
  if (row.context.ancestryUnknown && (row.context.repairOfRecordId !== null || row.context.repairDepth !== null || row.context.repairLineageRefs !== null)) evidenceConflict('Unknown context cannot assert lineage');
  if (row.completeness.state === 'complete' && (row.completeness.reasons.length || !row.calls.length || ['tokens', 'durationMs', 'usd'].some(k => row.cost[k] === null))) evidenceConflict('Complete ledger row lacks cost/calls');
  if (row.context.waveKind === 'repair' && (!row.context.repairOfRecordId || !(row.context.repairDepth >= 1) || !row.context.repairLineageRefs?.length)) evidenceConflict('Repair row lacks lineage');
  if (row.context.waveKind === 'fresh' && (row.context.repairOfRecordId !== null || row.context.repairDepth !== 0 || row.context.repairLineageRefs?.length !== 0)) evidenceConflict('Fresh context has repair history');
  if (c.waveKind === 'retry' && !c.ancestryUnknown && (c.repairDepth === 0
    ? c.repairOfRecordId !== null || c.repairLineageRefs.length !== 0
    : !c.repairOfRecordId || !c.repairLineageRefs.length)) evidenceConflict('Retry lacks its known underlying ancestry');
  if (row.observation?.evidenceSource === 'engine-receipt') {
    if (row.calls.length || row.completeness.state !== 'incomplete' || row.outcome.binary !== 'excluded'
      || !same(row.cost, engineReceiptCost(row.observation))) evidenceConflict('Engine ledger evidence/cost/exclusion differs');
    return row;
  }
  if (row.cost.provenance.includes('legacy')) evidenceConflict('Legacy cost provenance requires engine receipt evidence');
  const total = { tokens: null, durationMs: null, usd: null };
  const intents = new Set(); const receipts = new Map();
  for (const call of row.calls) {
    validateRoutingJoin(call.intent, row);
    if (intents.has(call.intent.id)) evidenceConflict('Ledger repeats an invocation');
    intents.add(call.intent.id);
    if (!call.resolution) { if (row.completeness.state === 'complete') evidenceConflict('Complete row has an unresolved intent'); continue; }
    const r = validateRoutingJoin(call.resolution, row);
    if (r.intentId !== call.intent.id || (call.intent.callId !== null && r.callId !== call.intent.callId)) evidenceConflict('Ledger call join differs');
    if (row.completeness.state === 'complete' && (!r.callId || r.outcome === 'unresolved' || r.launchOutcome === 'uncertain'
      || (r.launchOutcome === 'executed' && (!r.usageRef || !r.usageEvidence.provenance || ['tokens', 'durationMs', 'usd'].some(k => r.usageEvidence[k] === null))))) evidenceConflict('Complete row has incomplete attribution');
    if (r.launchOutcome === 'not-executed') continue;
    if (r.usageRef) {
      const key = canonicalRoutingJson([r.usageRef.ownerRunId, r.usageRef.dispatchId]);
      if (receipts.has(key)) continue;
      receipts.set(key, r.usageRef);
    }
    for (const k of Object.keys(total)) if (r.usageEvidence[k] !== null) total[k] = (total[k] ?? 0) + r.usageEvidence[k];
  }
  if (Object.keys(total).some(k => total[k] !== row.cost[k]) || !same([...receipts.values()].sort((a, b) => canonicalRoutingJson(a).localeCompare(canonicalRoutingJson(b))), row.cost.paidReceiptRefs)) evidenceConflict('Ledger cost differs from retained per-call evidence');
  return row;
}
/** Resolve authoritative original owners. Never create a replacement journal or move a spool. */
export function readRoutingOwners({ artifacts }) {
  let routing = artifacts.exportRoutingJournal();
  const journals = new Map();
  const owners = recordsOf(routing, 'receipt-owner');
  for (const owner of owners) {
    const journal = readJson(owner.journalLocator);
    if (journal.runId !== owner.ownerRunId || realpathSync(journal.targetCwd) !== artifacts.targetCwd) evidenceConflict('Original owner target/run differs');
    validateRoutingJournal(journal.routing, journal.routing?.runBinding);
    if (journal.routing.rootDigest !== routing.rootDigest || journal.routing.runBinding.revisionDigest !== owner.revisionDigest) evidenceConflict('Original owner root/revision differs');
    validateRoutingReceiptSpool(journal, owner.journalLocator);
    for (const retained of Object.values(routing.records)) {
      const ownerRunId = retained.ownerRunId ?? (retained.intentId ? routing.records[retained.intentId]?.ownerRunId : null);
      if (ownerRunId === owner.ownerRunId && joinTypes.has(retained.type) && !journal.routing.records[retained.id]) evidenceConflict('Original owner lost retained expected call evidence');
    }
    journals.set(owner.ownerRunId, journal);
    for (const r of Object.values(journal.routing.records)) {
      const old = routing.records[r.id];
      if (old && !same(old, r)) evidenceConflict('Retained owner record changed');
      routing.records[r.id] = copy(r);
    }
    for (const [token, id] of Object.entries(journal.routing.tokenIndex)) {
      if (journal.routing.records[id].runId !== owner.ownerRunId) continue;
      if (routing.tokenIndex[token] && routing.tokenIndex[token] !== id) evidenceConflict('Owner token index differs');
      routing.tokenIndex[token] = id;
      routing.eventTips[id] = copy(journal.routing.eventTips[id]);
    }
  }
  validateRoutingJournal(routing, routing.runBinding);
  return { routing, journals };
}
/** Delivery occurs outside the journal lock; the exact copied payload is checked on acknowledgement. */
export async function flushRoutingReceipts({ artifacts, deliver, requiredDispatchId = null }) {
  const pending = artifacts.pendingRoutingReceipts();
  for (const p of pending.filter(p => requiredDispatchId === null || p.dispatchId === requiredDispatchId)) {
    let result;
    try { result = await deliver(artifacts.runId, copy(p.receipt)); }
    catch (e) {
      if (e.code?.startsWith('ROUTING_') || e.code === 'CONSUMER_EVIDENCE_MISMATCH') throw e;
      if (requiredDispatchId) refuse('ROUTING_RECEIPT_INCOMPLETE', 'Required metadata delivery failed');
      continue;
    }
    if (['recorded', 'already_recorded', 'already-recorded'].includes(result?.status)) artifacts.acknowledgeUsageReceipt({ dispatchId: p.dispatchId, seq: result.seq, payloadDigest: routingDigest(p.receipt) });
  }
  if (requiredDispatchId) {
    artifacts.exportRoutingJournal();
    const receipt = artifacts.journal.pendingUsageReceipts?.find(p => p.dispatchId === requiredDispatchId);
    if (!receipt || receipt.state !== 'acknowledged') refuse('ROUTING_RECEIPT_INCOMPLETE', 'Required metadata is not durably acknowledged');
  }
}
function rowPayload(row) { const { version, materializedAt, ...payload } = row; return payload; }
function readLedgerUnlocked(cwd, { recoverTail = false } = {}) {
  const path = join(rootPath(cwd), 'ledger.jsonl'); assertNoSymlinkPath(path);
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path); const last = bytes.lastIndexOf(10); const complete = bytes.subarray(0, last + 1);
  if (last !== bytes.length - 1) {
    if (!recoverTail) refuse('ROUTING_LEDGER_INCOMPLETE', 'Ledger has an incomplete crash tail');
    const tail = bytes.subarray(last + 1);
    const quarantine = `${path}.tail-${routingDigest([...tail])}`;
    if (!existsSync(quarantine)) { const fd = openSync(quarantine, 'wx', 0o600); try { writeFileSync(fd, tail); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(dirname(path)); }
    const fd = openSync(path, 'r+'); try { ftruncateSync(fd, last + 1); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const latest = new Map();
  for (const line of complete.toString('utf8').split('\n').slice(0, -1)) {
    let row; try { row = JSON.parse(line); } catch { refuse('ROUTING_LEDGER_INVALID', 'Malformed complete ledger row'); }
    validateRoutingLedgerRow(row);
    const previous = latest.get(row.recordId);
    if (row.version !== (previous?.version ?? 0) + 1) refuse('ROUTING_LEDGER_INVALID', 'Ledger version gap or duplicate');
    if (previous && (previous.rootDigest !== row.rootDigest || previous.startId !== row.startId || !same(previous.issuance, row.issuance) || !same(previous.observation, row.observation))) evidenceConflict('Ledger ownership changed');
    if (previous) {
      for (const old of previous.calls) {
        const current = row.calls.find(c => c.intent.id === old.intent.id);
        if (!current || !same(current.intent, old.intent) || (old.resolution && !current.resolution)) evidenceConflict('Ledger revision lost a known invocation');
        if (old.resolution) checkImprovement(old.resolution, current.resolution);
      }
    }
    latest.set(row.recordId, row);
  }
  return [...latest.values()].sort((a, b) => a.recordId.localeCompare(b.recordId));
}
export function readRoutingLedger({ cwd, recoverTail = false }) {
  if (!existsSync(join(rootPath(cwd), 'ledger.jsonl'))) return [];
  const release = acquireRoutingLock(join(rootPath(cwd), '.ledger-lock'));
  try { return readLedgerUnlocked(cwd, { recoverTail }); } finally { release(); }
}
function costsForCalls(calls, journals, reasons) {
  const known = { tokens: null, durationMs: null, usd: null, provenance: [], paidReceiptRefs: [] };
  const refs = new Set();
  for (const { intent, resolution: r } of calls) {
    if (!r) { reasons.push('unresolved-call'); continue; }
    reasons.push(...r.incompleteReasons);
    if (!r.callId) reasons.push('missing-call-id');
    if (r.launchOutcome === 'uncertain' || r.outcome === 'unresolved') reasons.push('uncertain-call');
    if (r.launchOutcome === 'not-executed') continue;
    for (const k of ['tokens', 'durationMs', 'usd']) {
      if (r.usageEvidence[k] === null || !r.usageEvidence.presence[k]) reasons.push(`missing-${k}`);
    }
    if (!['reported', 'estimated'].includes(r.usageEvidence.provenance)) reasons.push('missing-cost-provenance');
    const ref = r.usageRef;
    if (!ref) reasons.push('missing-paid-receipt');
    else {
      const key = canonicalRoutingJson([ref.ownerRunId, ref.dispatchId]);
      if (refs.has(key)) { reasons.push('overlapping-paid-receipt'); continue; }
      refs.add(key); known.paidReceiptRefs.push(copy(ref));
      const spool = journals.get(ref.ownerRunId)?.pendingUsageReceipts?.find(p => p.dispatchId === ref.dispatchId);
      if (!spool || routingDigest(spool.receipt) !== ref.payloadDigest || spool.receipt.detail.routing.intentId !== intent.id) evidenceConflict('Materialized receipt owner differs');
      if (spool.state !== 'acknowledged') reasons.push('unacknowledged-paid-receipt');
    }
    for (const k of ['tokens', 'durationMs', 'usd']) if (r.usageEvidence[k] !== null) known[k] = (known[k] ?? 0) + r.usageEvidence[k];
    if (r.usageEvidence.provenance) known.provenance.push(r.usageEvidence.provenance);
  }
  known.provenance = [...new Set(known.provenance)].sort();
  known.paidReceiptRefs.sort((a, b) => canonicalRoutingJson(a).localeCompare(canonicalRoutingJson(b)));
  return known;
}
/** Recompute from durable journals, never caller-supplied rows or in-memory caches. */
export function materializeRoutingLedger({ cwd, artifacts, hooks = {} }) {
  const initial = artifacts.exportRoutingJournal();
  if (![...recordsOf(initial, 'issuance'), ...recordsOf(initial, 'unsupported-observation')].length) return [];
  ensureRoutingStorage({ cwd });
  const release = acquireRoutingLock(join(rootPath(cwd), '.ledger-lock'));
  try {
  // Persist derived outcome revisions at their original owners, then reload all
  // chains. Original call/outcome history is never replaced by a retained copy.
  const ownerArtifacts = [artifacts, ...recordsOf(initial, 'receipt-owner').filter(o => o.ownerRunId !== artifacts.runId).map(o => artifacts.openRoutingOwner(o))];
  for (const owner of ownerArtifacts) {
    const owned = owner.exportRoutingJournal();
    for (const issuance of recordsOf(owned, 'issuance').filter(i => i.runId === owner.runId)) owner.recordRoutingOutcome(issuance.id);
  }
  const { routing, journals } = readRoutingOwners({ artifacts });
  const start = readRoutingStart({ cwd, ...routing });
  const records = [...recordsOf(routing, 'issuance'), ...recordsOf(routing, 'unsupported-observation')];
  if (!records.length) return [];
  const rows = records.map(owner => {
    const supported = owner.type === 'issuance';
    const recordId = supported ? owner.id : owner.recordId;
    const intents = inclusiveIntents(routing, recordId).sort((a, b) => a.id.localeCompare(b.id));
    const calls = intents.map(intent => { const { resolution } = latestRoutingCall(routing, intent.id); return { intent, resolution, executedTier: routingExecutedTier(start, intent, resolution) }; });
    const reasons = supported ? [] : [...owner.incompleteReasons];
    if (!calls.length) reasons.push('missing-call-evidence');
    if (supported && !calls.some(c => c.intent.issuanceId === recordId && c.intent.purpose === 'primary')) reasons.push('missing-primary-call');
    if (supported) {
      const metadata = recordsOf(routing, 'issuance-metadata').find(m => m.issuanceId === recordId);
      const pending = journals.get(owner.runId)?.pendingUsageReceipts?.find(p => p.dispatchId === metadata?.dispatchId);
      if (!pending || pending.state !== 'acknowledged') reasons.push('unacknowledged-route-metadata');
    }
    const cost = owner.evidenceSource === 'engine-receipt' ? engineReceiptCost(owner) : costsForCalls(calls, journals, reasons);
    if (owner.evidenceSource === 'engine-receipt') reasons.push('engine-receipt-without-connector-attribution');
    for (const k of ['tokens', 'durationMs', 'usd']) if (cost[k] === null) reasons.push(`missing-${k}`);
    if (supported && !calls.some(c => c.intent.issuanceId === recordId && c.intent.purpose === 'primary' && c.resolution?.launchOutcome === 'executed')) reasons.push('primary-execution-unverified');
    const context = supported ? deriveRoutingContext(routing, recordId) : { waveKind: 'unknown', ancestryUnknown: true, repairOfRecordId: null, repairDepth: null, repairLineageRefs: null };
    const outcome = supported ? deriveRoutingOutcome(routing, recordId) : classification('unknown', 'excluded', 'unsupported-observation', 'unsupported');
    if (context.ancestryUnknown && supported) reasons.push('unknown-repair-context');
    const evidenceRefs = [...new Set([owner.id, ...(supported && latestRoutingOutcome(routing, recordId) ? [latestRoutingOutcome(routing, recordId).id] : []), ...calls.flatMap(c => [c.intent.id, ...(c.resolution ? [c.resolution.id, latestRoutingCall(routing, c.intent.id).head.id] : [])]),
      ...recordsOf(routing, 'gate-disposition').filter(d => d.dispositions.some(x => x.issuanceId === recordId)).map(d => d.id),
      ...(context.repairLineageRefs ?? [])])].sort();
    return validateRoutingLedgerRow({ schemaVersion: 1, startId: routing.startId, rootDigest: routing.rootDigest, recordId, version: 1, materializedAt: new Date().toISOString(),
      source: supported ? owner.selected.provenance.source : 'unsupported', key: supported ? owner.key : null, context, issuance: supported ? owner : null,
      observation: supported ? null : owner, outcome, evidenceRefs, calls, cost, completeness: { state: reasons.length ? 'incomplete' : 'complete', reasons: [...new Set(reasons)].sort() } });
  });
    const latest = new Map(readLedgerUnlocked(cwd, { recoverTail: true }).map(r => [r.recordId, r]));
    const result = [];
    for (const row of rows) {
      const prior = latest.get(row.recordId);
      if (prior && same(rowPayload(prior), rowPayload(row))) { result.push(prior); continue; }
      row.version = (prior?.version ?? 0) + 1;
      const path = join(rootPath(cwd), 'ledger.jsonl'); assertNoSymlinkPath(path);
      hooks.beforeLedgerAppend?.(copy(row));
      const fd = openSync(path, 'a', 0o600);
      try { writeFileSync(fd, canonicalRoutingJson(row) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(dirname(path)); hooks.afterLedgerAppend?.(copy(row));
      latest.set(row.recordId, row); result.push(row);
    }
    return result;
  } finally { release(); }
}
/** Union paid receipt references so inclusive parent costs never double-count children. */
export function reconcileRoutingPaidReceipts(rows) {
  const unique = new Map();
  for (const row of rows) {
    validateRoutingLedgerRow(row);
    const evidence = row.calls.flatMap(call => call.resolution?.usageRef ? [call.resolution] : []);
    if (row.observation?.evidenceSource === 'engine-receipt') evidence.push({ usageRef: row.cost.paidReceiptRefs[0], usageEvidence: row.observation.engineReceiptEvidence.usageEvidence });
    for (const r of evidence) {
      const key = canonicalRoutingJson([r.usageRef.ownerRunId, r.usageRef.dispatchId]);
      const value = { ref: r.usageRef, tokens: r.usageEvidence.tokens, durationMs: r.usageEvidence.durationMs, usd: r.usageEvidence.usd };
      if (unique.has(key) && !same(unique.get(key), value)) evidenceConflict('Paid receipt amounts/ownership conflict');
      unique.set(key, value);
    }
  }
  return [...unique.values()];
}

export function latestRoutingOutcome(routing, issuanceId) {
  const outcomes = recordsOf(routing, 'outcome').filter(r => r.issuanceId === issuanceId);
  if (!outcomes.length) return null;
  let previous = null; const visited = new Set();
  while (true) {
    const next = outcomes.filter(r => r.previousOutcomeId === previous);
    if (!next.length) break;
    if (next.length !== 1 || visited.has(next[0].id)) refuse('ROUTING_BINDING_DRIFT', 'Outcome chain fork/cycle');
    visited.add(next[0].id); previous = next[0].id;
  }
  if (visited.size !== outcomes.length) refuse('ROUTING_BINDING_MISSING', 'Outcome chain gap');
  return requiredRecord(routing, previous, 'outcome');
}
export function prepareRoutingOutcome(routing, issuanceId) {
  const outcome = deriveRoutingOutcome(routing, issuanceId);
  const dispositions = recordsOf(routing, 'gate-disposition').filter(d => d.dispositions.some(x => x.issuanceId === issuanceId));
  const evidenceRefs = [...new Set([issuanceId,
    ...recordsOf(routing, 'issuance-event').filter(e => e.issuanceId === issuanceId).map(e => e.id),
    ...recordsOf(routing, 'issuance').filter(i => i.priorRecordId === issuanceId).map(i => i.id),
    ...dispositions.flatMap(d => [d.id, d.snapshotId]),
    ...recordsOf(routing, 'gate-acknowledgement').filter(a => dispositions.some(d => d.id === a.dispositionId)).map(a => a.id),
    ...recordsOf(routing, 'lineage-link').filter(l => l.fromIssuanceId === issuanceId).map(l => l.id),
  ])].sort();
  const previous = latestRoutingOutcome(routing, issuanceId);
  const fields = { issuanceId, evidenceRefs, ...outcome };
  if (previous && same(fields, { issuanceId: previous.issuanceId, evidenceRefs: previous.evidenceRefs, label: previous.label,
    binary: previous.binary, derivation: previous.derivation, censorReason: previous.censorReason })) return previous;
  const payload = { ...fields, previousOutcomeId: previous?.id ?? null };
  return { ...base(routing, 'outcome', evidenceId('outcome', payload)), ...payload };
}
