#!/usr/bin/env node
/**
 * scripts/flows/pipeline-roundtrip.mjs — Compose's own user flow for the pipeline
 * editor (COMP-VERIFY-FLOW-1 dogfood, replays incident I17).
 *
 * I17: the Flow editor's model read 0 of the 62 `after:` dependency edges in
 * the shipped pipelines, and the save path needed a server change a model-only
 * test missed. This flow does what the editor does, through the real server:
 *
 *   1. copy pipelines/*.stratum.yaml to a throwaway workspace
 *   2. start THIS checkout's Compose server on a free port in the test range
 *      (checked with ~/.claude/scripts/port_check.py when it exists)
 *   3. per pipeline: GET /api/pipeline/spec, build the editor's model
 *      (src/lib/pipeline-model.js specToModel), POST /api/pipeline/save each flow
 *      unchanged (flow-scoped, with baseHash, as useVisionStore.saveSpec does),
 *      reload, print `EDGES <pipeline> <n>` counted from the reloaded document
 *   4. add one dependency in `build`, save, reload, print `EDIT build <n>` and
 *      `KEY <after|depends_on|none>` from the saved YAML
 *   5. stop the server and delete the workspace
 *
 * Exit 0 when every step ran (the expected lines decide pass/fail, not this
 * script); 1 on a product error (a save refused, a spec missing); 3 when it
 * could not set up (no free port, server never came up), declared in
 * `setup_exit_codes` so Compose reports FLOW_SETUP_ERROR, not FLOW_FAILED.
 */
import { cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { addDependency, specToModel, wouldCreateCycle } from '../../src/lib/pipeline-model.js';
import { REPO, makeSandbox, startServer, stopAll } from './flow-env.mjs';

// 1-2. A throwaway workspace with the shipped pipelines, and this checkout's server against it.
const sb = makeSandbox('pipeline-roundtrip');
let server = null;
process.on('exit', () => { stopAll(server?.child); sb.remove(); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
cpSync(path.join(REPO, 'pipelines'), path.join(sb.ws, 'pipelines'), { recursive: true });
server = await startServer(sb);
const base = server.base;
const ws = sb.ws;

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`${method} ${url} -> ${res.status}: ${data.error || JSON.stringify(data)}`); process.exit(1); }
  return data;
}

const load = async (file) => {
  const { text, hash } = await api('GET', `/api/pipeline/spec?file=${encodeURIComponent(file)}`);
  return { text, hash, model: specToModel(YAML.parse(text)) };
};
const edges = (model) => model.flows.reduce((n, f) => n + f.steps.reduce((m, s) => m + (s.depends_on?.length || 0), 0), 0);

/** Save every flow flow-scoped, the way the editor's Save does for the open flow. */
async function saveAll(file, model, hash) {
  let h = hash;
  for (const f of model.flows) h = (await api('POST', '/api/pipeline/save', { file, model, flowName: f.name, baseHash: h })).hash;
  return h;
}

// 3. Round-trip every shipped pipeline unchanged.
const files = readdirSync(path.join(ws, 'pipelines')).filter((f) => f.endsWith('.stratum.yaml')).sort();
let total = 0;
for (const file of files) {
  const { model, hash } = await load(file);
  await saveAll(file, model, hash);
  const n = edges((await load(file)).model);
  total += n;
  console.log(`EDGES ${file.replace(/\.stratum\.yaml$/, '')} ${n}`);
}
console.log(`EDGES total ${total}`);

// 4. One real edit: add a dependency to build's largest flow, save, reload.
{
  const file = 'build.stratum.yaml';
  const { model, hash } = await load(file);
  const flow = [...model.flows].sort((a, b) => b.steps.length - a.steps.length)[0];
  let pick = null;
  for (const s of [...flow.steps].reverse()) {
    const dep = flow.steps.find((d) => d.id !== s.id && !(s.depends_on || []).includes(d.id) && !wouldCreateCycle(model, flow.name, s.id, d.id));
    if (dep) { pick = { step: s.id, dep: dep.id }; break; }
  }
  if (!pick) { console.error(`no dependency can be added in ${flow.name} without a cycle`); process.exit(1); }
  addDependency(model, flow.name, pick.step, pick.dep);
  await api('POST', '/api/pipeline/save', { file, model, flowName: flow.name, baseHash: hash });
  const after = await load(file);
  console.log(`EDIT build ${edges(after.model)}`);
  const raw = YAML.parse(after.text);
  const rawSteps = raw.flows?.[flow.name]?.steps ?? (raw.workflow?.steps || []);
  const step = rawSteps.find((s) => s.id === pick.step) || {};
  const key = Array.isArray(step.after) && step.after.includes(pick.dep) ? 'after'
    : Array.isArray(step.depends_on) && step.depends_on.includes(pick.dep) ? 'depends_on' : 'none';
  console.log(`KEY ${key}`);
}
process.exit(0);
