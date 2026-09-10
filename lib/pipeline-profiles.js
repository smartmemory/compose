/** Compose-owned sidecar schema and whole-wave admission. No dispatch or I/O. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import YAML from 'yaml';
import { validateAgentString, resolveAgentConfig } from './agent-string.js';

export class PipelineProfileError extends Error {
  constructor(code, message) { super(message); this.name = 'PipelineProfileError'; this.code = code; }
}
const fail = (message, code = 'PIPELINE_PROFILE_INVALID') => { throw new PipelineProfileError(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid configuration fields: ${JSON.stringify(value)}`);
};
export function ownField(value, path) {
  if (typeof path !== 'string' || !/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)*$/.test(path)
    || path.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('Invalid field path');
  for (const key of path.split('.')) {
    if (!object(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
export function normalizeOwnedPath(path) {
  if (typeof path !== 'string' || !path.length || /^[\\/]|^[A-Za-z]:/.test(path)
    || /[\0*?\[\]{}]/.test(path)) fail('Ownership requires literal repository-relative file paths', 'WAVE_OWNERSHIP_INVALID');
  const parts = path.replaceAll('\\', '/').split('/');
  if (parts.includes('..') || parts.some(part => part.toLowerCase() === '.git')) fail(`Unsafe ownership path: ${path}`, 'WAVE_OWNERSHIP_INVALID');
  const normalized = posix.normalize(parts.join('/'));
  if (normalized === '.' || normalized.endsWith('/')) fail(`Not a file path: ${path}`, 'WAVE_OWNERSHIP_INVALID');
  return normalized;
}
function agent(profile, provider) {
  if (typeof profile !== 'string' || !profile.trim() || profile.split(':').length > 3) fail('Profile must be a non-empty agent string');
  validateAgentString(profile);
  const resolved = resolveAgentConfig(profile);
  if (provider && resolved.provider !== provider) fail(`Profile provider ${resolved.provider} differs from stage ${provider}`);
  return { ...resolved, profile };
}
export function validateGateConfig(entry) {
  keys(entry, ['decide_from', 'validators']);
  keys(entry.decide_from, ['step', 'field', 'approve', 'revise', 'kill']);
  const mapping = entry.decide_from;
  if (typeof mapping.step !== 'string' || !mapping.step) fail('decide_from.step is required');
  ownField({}, mapping.field);
  const seen = new Set();
  for (const outcome of ['approve', 'revise', 'kill']) {
    if (!Array.isArray(mapping[outcome])) fail(`${outcome} must be a value array`);
    for (const value of mapping[outcome]) {
      if (typeof value !== 'string' || !value || seen.has(value)) fail('Gate values must be nonempty, disjoint strings');
      seen.add(value);
    }
  }
  if (entry.validators !== undefined && !Array.isArray(entry.validators)) fail('validators must be an array');
  for (const validator of entry.validators ?? []) {
    keys(validator, ['name', 'review_step', 'tasks_field']);
    if (validator.name !== 'WaveDecision' || typeof validator.review_step !== 'string' || !validator.review_step) fail('Unknown validator or missing review_step');
    ownField({}, validator.tasks_field ?? 'tasks');
  }
  return entry;
}
function ancestor(steps, from, gate, visited = new Set()) {
  if (visited.has(gate)) return false;
  visited.add(gate);
  return (steps.find(step => step.id === gate)?.after ?? []).some(id => id === from || ancestor(steps, from, id, visited));
}
export function normalizePipelineProfiles(raw, spec) {
  if (!object(raw)) fail('Profiles must be an object');
  const parsed = typeof spec === 'string' ? YAML.parse(spec) : spec;
  const flows = Object.values(parsed?.flows ?? {}).filter(flow => Array.isArray(flow?.steps));
  const steps = flows.flatMap(flow => flow.steps);
  const normalized = structuredClone(raw);
  for (const [id, entry] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    const matches = steps.filter(step => step.id === id);
    if (!matches.length) fail(`Step ${id} not found in spec`);
    for (const step of matches) {
      if (object(entry) && Object.hasOwn(entry, 'decide_from')) {
        validateGateConfig(entry);
        if (!step.gate || step.agent || step.fanout || id === 'review_gate') fail(`Step ${id} is not an available output gate`);
        const flowSteps = flows.find(flow => flow.steps.includes(step)).steps;
        for (const source of [entry.decide_from.step, ...(entry.validators ?? []).map(v => v.review_step)]) {
          if (!ancestor(flowSteps, source, id)) fail(`Source ${source} must be an ancestor of ${id}`);
        }
        continue;
      }
      if (step.gate && !step.agent && !step.fanout) fail(`Gate ${id} requires decide_from`);
      if (object(entry)) {
        keys(entry, ['default', 'tier_from']);
        if (entry.tier_from !== undefined && (entry.tier_from !== 'item.tier' || step.fanout?.dispatch !== 'consumer')) fail('tier_from requires a consumer fanout and item.tier');
      } else if (typeof entry !== 'string') fail(`Invalid profile for ${id}`);
      for (const stage of step.fanout?.steps ?? [step]) {
        const resolved = agent(typeof entry === 'string' ? entry : entry.default, stage.agent ?? 'claude');
        if (step.fanout?.dispatch === 'engine' && (resolved.tier || resolved.template)) fail('Engine dispatch cannot apply Compose templates or tiers');
        if (entry.tier_from) for (const tier of ['critical', 'standard', 'fast']) resolveConsumerProfile(entry, { tier }, resolved.provider);
      }
    }
  }
  if (raw._consumer !== undefined) {
    if (!object(raw._consumer)) fail('_consumer must be an object');
    for (const [id, policy] of Object.entries(raw._consumer)) {
      keys(policy, ['ownership', 'independent', 'checkpoint_gate']);
      if (policy.ownership !== undefined && policy.ownership !== 'item.files_owned') fail('ownership must be item.files_owned');
      if (policy.independent !== undefined && typeof policy.independent !== 'boolean') fail('independent must be boolean');
      const matches = steps.filter(step => step.id === id);
      if (!matches.length) fail(`Consumer ${id} not found`);
      for (const step of matches) {
        if (step.fanout?.dispatch !== 'consumer') fail(`${id} is not consumer-dispatched`);
        if ((policy.ownership || policy.checkpoint_gate) && step.fanout.isolation !== 'worktree') fail('Ownership/checkpoints require worktree isolation');
        if (policy.checkpoint_gate !== undefined) {
          const flow = flows.find(flow => flow.steps.includes(step));
          const gate = flow.steps.find(s => s.id === policy.checkpoint_gate);
          if (!gate?.gate || gate.after?.length !== 1 || gate.after[0] !== id || gate.when) fail('checkpoint_gate must be the direct unconditional merge gate');
        }
      }
    }
  }
  if (raw._costCeiling !== undefined) {
    const c = raw._costCeiling;
    keys(c, ['input', 'default', 'gates']);
    if (typeof c.input !== 'string' || !/^[A-Za-z_]\w*$/.test(c.input)
      || !Number.isFinite(c.default) || c.default <= 0 || !Array.isArray(c.gates) || !c.gates.length
      || c.gates.some(id => !steps.some(s => s.id === id && s.gate))) fail('Invalid _costCeiling');
  }
  return normalized;
}
/** Replacing a default must never erase the per-item routing policy. Re-preflight the result. */
export function mergeRuntimeProfiles(normalized, runtime = {}) {
  const result = structuredClone(normalized);
  for (const [id, override] of Object.entries(runtime)) {
    if (id.startsWith('_') || object(result[id]) && result[id].decide_from) fail(`Runtime override is not an agent profile: ${id}`);
    const previous = result[id];
    if (object(override)) {
      keys(override, ['default', 'tier_from']);
      if (override.tier_from !== undefined && override.tier_from !== previous?.tier_from) fail('Runtime overrides cannot change tier_from');
    } else if (typeof override !== 'string') fail('Runtime override must be an agent profile');
    result[id] = object(previous) ? { ...previous, default: typeof override === 'string' ? override : override.default } : structuredClone(override);
    agent(typeof result[id] === 'string' ? result[id] : result[id].default);
  }
  return result;
}
export function resolveConsumerProfile(entry, item, provider) {
  const resolved = agent(typeof entry === 'string' ? entry : entry?.default, provider);
  if (!entry?.tier_from) return resolved;
  if (entry.tier_from !== 'item.tier') fail('Unsupported tier_from');
  const tier = ownField({ item }, entry.tier_from);
  if (tier === undefined && !Object.hasOwn(item ?? {}, 'tier')) return resolved;
  if (!['critical', 'standard', 'fast'].includes(tier)) fail(`Unknown item tier: ${String(tier)}`, 'WAVE_TIER_INVALID');
  return agent(`${resolved.provider}:${resolved.template ?? ''}:${tier}`, provider);
}
export function validateWaveAdmission(entry, items, opts = {}) {
  const findings = [];
  const profiles = [];
  const owners = new Map();
  const add = (code, itemIndex, message) => findings.push({ code, itemIndex, message, severity: 'error' });
  if (!Array.isArray(items)) return { ok: false, findings: [{ code: 'WAVE_INPUT_INVALID', message: 'Recorded wave input must be an array' }] };
  items.forEach((item, itemIndex) => {
    try { profiles.push(resolveConsumerProfile(entry, item, opts.provider)); }
    catch (error) { add(error.code ?? 'WAVE_TIER_INVALID', itemIndex, error.message); }
    if (opts.independent && (!Array.isArray(item?.depends_on) || item.depends_on.length)) add('WAVE_DEPENDENCIES_NOT_EMPTY', itemIndex, 'Independent tasks require empty depends_on');
    if (opts.ownership || Object.hasOwn(item ?? {}, 'files_owned')) {
      try {
        if (!Array.isArray(item?.files_owned)) fail('files_owned is required', 'WAVE_OWNERSHIP_INVALID');
        for (const file of item.files_owned.map(normalizeOwnedPath)) {
          if (owners.has(file) && owners.get(file) !== itemIndex) add('WAVE_OWNERSHIP_CONFLICT', itemIndex, `Multiple tasks own ${file}`);
          owners.set(file, itemIndex);
        }
      } catch (error) { add(error.code, itemIndex, error.message); }
    }
  });
  return { ok: findings.length === 0, findings, profiles };
}
export function profilesDigest(normalized) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(canonical(normalized))).digest('hex');
}
/** Dispatch 2 replaces the string-only wrapper with this, after resolving spec inputs. */
export function preflightPipelineProfiles(raw, spec, runtime = {}) {
  const normalized = normalizePipelineProfiles(mergeRuntimeProfiles(normalizePipelineProfiles(raw, spec), runtime), spec);
  const resolved = {};
  const overrides = {};
  for (const [id, entry] of Object.entries(normalized)) {
    if (!id.startsWith('_') && !entry?.decide_from) {
      resolved[id] = resolveConsumerProfile(entry, {});
      if (entry.tier_from) overrides[id] = ['critical', 'standard', 'fast'].map(tier => resolveConsumerProfile(entry, { tier }));
    }
  }
  const parsed = typeof spec === 'string' ? YAML.parse(spec) : spec;
  for (const step of Object.values(parsed?.flows ?? {}).flatMap(flow => flow?.steps ?? [])) {
    if (Object.hasOwn(normalized, step.id)) continue;
    const stages = step.fanout?.steps ?? (step.agent ? [step] : []);
    for (const [index, stage] of stages.entries()) {
      const resolution = agent(stage.agent ?? 'claude');
      if (step.fanout?.dispatch === 'engine' && (resolution.template || resolution.tier)) fail('Engine dispatch cannot apply Compose templates or tiers');
      resolved[stages.length === 1 ? step.id : `${step.id}/${index}`] = resolution;
    }
  }
  return { ok: true, normalized, resolved, profilesDigest: profilesDigest({ normalized, resolved, overrides }) };
}
