/** Immutable S1a start/intent/binding storage. No model calls or outcome ledger. */
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import YAML from 'yaml';
import startSchema from '../contracts/routing-start.schema.json' with { type: 'json' };
import recordSchema from '../contracts/routing-record.schema.json' with { type: 'json' };
import { assertRoutingSlice, canonicalRoutingJson, contractFingerprint, reachableContracts, routingDigest, routingTable, routingRefuse, routingRecordId } from './model-router.js';
import { preflightPipelineProfiles, resolveConsumerProfile } from './pipeline-profiles.js';
import { resolvePlanSpecValues } from './stratum-mcp-client.js';
import { findRoutingPlanRuns, validateRoutingSnapshot } from './flow-state.js';

const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
const checkStart = ajv.compile(startSchema);
const checkRecord = ajv.compile(recordSchema);
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

export function createRoutingStart({ cwd, spec, inputs, originalProfiles = {}, runtimeOverrides = {}, preflight, mode = 'off', presetId, hooks = {} }) {
  assertRoutingSlice({ mode, policy: preflight?.routingPolicy });
  if (mode === 'off') return null;
  const parsed = typeof spec === 'string' ? YAML.parse(spec) : structuredClone(spec);
  const flow = parsed.flows?.[parsed.flows.entry] ?? Object.values(parsed.flows ?? {}).find(v => v?.steps);
  if (!transport.every(k => flow?.input?.[k] === 'string?')) refuse('ROUTING_INPUT_UNDECLARED', 'Participating flow must declare all optional routing transport strings');
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
        const profileKey = stages.length === 1 ? step.id : `${step.id}/${index}`;
        const provenance = structuredClone(verified.staticProvenance[profileKey]);
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
      if (['runId', 'revisionDigest', 'scopedStep', 'epoch', 'itemIndex', 'generation', 'issuanceToken'].some(k => evidence[k] !== issuance[k])
        || evidence.acceptedDispatchToken !== issuance.issuanceToken) refuse('ROUTING_ISSUANCE_UNCERTAIN', 'Settlement lacks matching token-bound engine evidence');
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
