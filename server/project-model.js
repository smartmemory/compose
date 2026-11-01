/**
 * project-model.js — COMP-COCKPIT-PROJECT-MODEL-1: a project is a root folder with lanes and modules.
 *
 * One reader on top of `.compose/compose.json`, never a second registry:
 *   host config  `<host>/.compose/compose.json` `projects.roots`: the discovery list, in Projects home order.
 *   per project  `<root>/.compose/compose.json` `project`: `{name, label, lanes: [{id, opsLane?, label?, repo?, module?}],
 *                modules: [{name, path}]}`.
 * Everything is read from disk on each call. Nothing here writes, switches the cockpit's project or touches the
 * workspace runtime (a header-bound request for an unheld root reseeds and writes its store: design section 5).
 *
 * A module's identity is its realpath (the workspace runtime's `key()` rule), so the `SmartMemory/cadence` symlink and
 * `forge/cadence` are one module. `hasStore` is derived on every read and never written.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export const expandHome = (p) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };

/** `<dir>/.compose/compose.json` parsed: `{config, error}`; config null when absent or broken. */
export function readComposeConfig(dir) {
  const file = join(dir, '.compose', 'compose.json');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    return { config: null, error: e?.code === 'ENOENT' ? null : `${file}: ${e.message}` };
  }
  try {
    const config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { config: null, error: `${file}: not a JSON object` };
    return { config, error: null };
  } catch { return { config: null, error: `${file}: not JSON` }; }
}

/** Whether `dir` runs a vision store: its state file exists and its config does not retire it (FORGE-ROADMAP-RETIRE-STORE). */
export function storeState(dir) {
  const { config } = readComposeConfig(dir);
  const lifecycle = config?.capabilities?.lifecycle !== false;
  const file = join(dir, '.compose', 'data', 'vision-state.json');
  return { lifecycle, file, hasStore: lifecycle && existsSync(file) };
}

/** The host's `projects.roots`: `{roots, error}`, roots null when the key is absent (legacy fleet path). */
export function readProjectRoots(hostRoot) {
  const { config, error } = readComposeConfig(hostRoot);
  if (error) return { roots: null, error };
  const raw = config?.projects?.roots;
  if (raw === undefined || raw === null) return { roots: null, error: null };
  if (!Array.isArray(raw) || !raw.every((r) => typeof r === 'string' && r.trim())) {
    return { roots: null, error: 'projects.roots must be a list of paths' };
  }
  return { roots: raw.map((r) => r.trim()), error: null };
}

const isInside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** One root's `project` block, normalised and checked on its own (cross-project checks run in `readProjects`). */
export function readProject(rootGiven) {
  const given = expandHome(rootGiven);
  const root = realOrNull(given);
  const errors = [];
  if (!root) {
    return { name: basename(given), label: basename(given), root: given, hasStore: false, lanes: [], modules: [], errors: [`root not found: ${given}`] };
  }
  const { config, error } = readComposeConfig(root);
  if (error) errors.push(error);
  const block = config?.project;
  const store = storeState(root);
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    if (!error) errors.push(`${root}/.compose/compose.json has no "project" key`);
    return { name: basename(root), label: basename(root), root, hasStore: store.hasStore, lanes: [], modules: [], errors };
  }
  const name = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : basename(root);
  const label = typeof block.label === 'string' && block.label.trim() ? block.label.trim() : name;

  const modules = [];
  for (const m of Array.isArray(block.modules) ? block.modules : []) {
    if (!m || typeof m.name !== 'string' || !m.name || typeof m.path !== 'string' || !m.path) {
      errors.push(`module entry needs a name and a path: ${JSON.stringify(m).slice(0, 80)}`);
      continue;
    }
    if (modules.some((x) => x.name === m.name)) { errors.push(`module "${m.name}" is listed twice`); continue; }
    const abs = isAbsolute(expandHome(m.path)) ? expandHome(m.path) : resolve(root, m.path);
    const real = realOrNull(abs);
    const mod = { name: m.name, path: m.path, realpath: real, outsideRoot: false, hasStore: false, lifecycle: true, error: null };
    if (!real) mod.error = `module path not found: ${abs}`;
    else {
      mod.outsideRoot = !isInside(real, root);
      const s = storeState(real);
      mod.hasStore = s.hasStore;
      mod.lifecycle = s.lifecycle;
    }
    modules.push(mod);
  }

  const lanes = [];
  for (const l of Array.isArray(block.lanes) ? block.lanes : []) {
    if (!l || typeof l.id !== 'string' || !l.id) { errors.push(`lane entry needs an id: ${JSON.stringify(l).slice(0, 80)}`); continue; }
    if (lanes.some((x) => x.id === l.id)) { errors.push(`lane "${l.id}" is listed twice`); continue; }
    const lane = {
      id: l.id,
      label: typeof l.label === 'string' && l.label ? l.label : l.id,
      opsLane: typeof l.opsLane === 'string' && l.opsLane ? l.opsLane : l.id,
      repo: typeof l.repo === 'string' && l.repo ? (isAbsolute(expandHome(l.repo)) ? expandHome(l.repo) : resolve(root, l.repo)) : null,
      module: typeof l.module === 'string' && l.module ? l.module : null,
    };
    if (lane.module && !modules.some((m) => m.name === lane.module)) {
      errors.push(`lane "${lane.id}" names module "${lane.module}", which this project does not list`);
      lane.module = null;
    }
    lanes.push(lane);
  }
  return { name, label, root, hasStore: store.hasStore, lanes, modules, errors };
}

/**
 * The whole model: `{configured, projects, laneIndex, unassigned, errors}`. `known` is the ops lane set (`knownLanes`).
 * Cross-project rules (design section 1), each failing visibly on the later claimant: a module realpath (or a project
 * root) belongs to one project, an opsLane repeats only inside one project, two projects cannot share a name.
 */
export function readProjects(hostRoot, known = []) {
  const { roots, error } = readProjectRoots(hostRoot);
  if (roots === null) return { configured: false, projects: [], laneIndex: {}, unassigned: [...known], errors: error ? [error] : [] };
  const projects = roots.map(readProject);
  const claimed = new Map(); // realpath -> "project" or "project/module"
  const names = new Set();
  const laneIndex = {};
  for (const p of projects) {
    if (names.has(p.name)) p.errors.push(`project name "${p.name}" is used by an earlier root`);
    names.add(p.name);
    if (claimed.has(p.root)) p.errors.push(`root ${p.root} is already claimed by ${claimed.get(p.root)}`);
    else claimed.set(p.root, p.name);
    for (const m of p.modules) {
      if (!m.realpath || m.error) continue;
      const owner = claimed.get(m.realpath);
      if (owner) {
        m.error = `${m.realpath} is already claimed by ${owner}`;
        m.hasStore = false;
        p.errors.push(`module "${m.name}": ${m.error}`);
      } else claimed.set(m.realpath, `${p.name}/${m.name}`);
    }
    for (const lane of p.lanes) {
      const prior = laneIndex[lane.opsLane];
      if (prior && prior.project !== p.name) {
        p.errors.push(`ops lane "${lane.opsLane}" (lane "${lane.id}") is already claimed by project ${prior.project}`);
        continue;
      }
      const entry = prior ?? (laneIndex[lane.opsLane] = { project: p.name, laneIds: [], modules: [] });
      entry.laneIds.push(lane.id);
      if (lane.module && !entry.modules.includes(lane.module)) entry.modules.push(lane.module);
    }
  }
  const unassigned = known.filter((n) => !Object.hasOwn(laneIndex, n));
  return { configured: true, projects, laneIndex, unassigned, errors: [] };
}

/**
 * Q1 (owner 2026-11-01): the feature codes a project root must NOT seed, because a configured module store owns them.
 * Read from each module's own store file. An unreadable store, a retired one (lifecycle false) or a module outside
 * this root's `project.modules` owns nothing. Returns a Set (empty when the root lists no modules).
 */
export function moduleOwnedCodes(root, config) {
  const owned = new Set();
  const modules = Array.isArray(config?.project?.modules) ? config.project.modules : [];
  for (const m of modules) {
    if (!m || typeof m.path !== 'string' || !m.path) continue;
    const abs = isAbsolute(expandHome(m.path)) ? expandHome(m.path) : resolve(root, m.path);
    const real = realOrNull(abs);
    if (!real || real === realOrNull(root)) continue;
    const s = storeState(real);
    if (!s.hasStore) continue;
    let state;
    try { state = JSON.parse(readFileSync(s.file, 'utf8')); } catch (e) {
      console.warn(`[project-model] module store ${s.file} unreadable, its codes are not excluded from the root seed: ${e.message}`);
      continue;
    }
    for (const item of Array.isArray(state?.items) ? state.items : []) {
      const code = item?.lifecycle?.featureCode ?? item?.featureCode;
      if (typeof code === 'string' && code) owned.add(code);
    }
  }
  return owned;
}

/** The `/api/fleet/roots` legacy shape derived from the model, for one release: a lane opens its first module with a store, else its project root. */
export function fleetRootsFromModel(model, known) {
  const roots = {};
  for (const lane of known) {
    const entry = model.laneIndex[lane];
    const project = entry && model.projects.find((p) => p.name === entry.project);
    if (!project) { roots[lane] = { root: null, hasCompose: false }; continue; }
    const mod = entry.modules.map((n) => project.modules.find((m) => m.name === n)).find((m) => m?.realpath && !m.error);
    const root = mod ? mod.realpath : project.root;
    let hasCompose = false;
    try { hasCompose = statSync(join(root, '.compose')).isDirectory(); } catch { /* absent */ }
    roots[lane] = { root, hasCompose };
  }
  return roots;
}


/**
 * Q1 cleanup plan for a project root store (owner 2026-11-01: delete the root's copies of codes a module store holds).
 * `rootState` and each `moduleStates[name]` are parsed vision-state.json objects. Returns `{remove, hold, rootOnly}`:
 *   remove  `[{id, code, owners}]` safe to delete through VisionStore.deleteItem.
 *   hold    `[{id, code, owners, reasons}]` NOT deleted: the item carries something no module copy has (a gate, or an
 *           edge whose code-level twin no module store holds), so deleting it would lose it from the merged graph.
 *   rootOnly the number of root codes no module holds (kept).
 */
export function planRootPrune(rootState, moduleStates) {
  const codeOfItem = (i) => i?.lifecycle?.featureCode ?? i?.featureCode ?? null;
  const modCodes = {};
  const modEdges = {};
  for (const [name, st] of Object.entries(moduleStates)) {
    const byId = new Map((st.items ?? []).map((i) => [i.id, codeOfItem(i) ?? `#${i.id}`]));
    modCodes[name] = new Set([...byId.values()]);
    modEdges[name] = new Set((st.connections ?? []).map((c) => `${byId.get(c.fromId)}|${byId.get(c.toId)}|${c.type}`));
  }
  const rootCode = new Map((rootState.items ?? []).map((i) => [i.id, codeOfItem(i) ?? `#${i.id}`]));
  const hasTwin = (from, to, type) => Object.values(modEdges).some((e) => e.has(`${from}|${to}|${type}`)
    || (type === 'informs' && e.has(`${to}|${from}|${type}`)));
  const remove = []; const hold = []; let rootOnly = 0;
  for (const item of rootState.items ?? []) {
    const code = codeOfItem(item);
    if (!code) continue;
    const owners = Object.keys(modCodes).filter((n) => modCodes[n].has(code));
    if (!owners.length) { rootOnly++; continue; }
    const reasons = [];
    const gates = (rootState.gates ?? []).filter((g) => g.itemId === item.id).length;
    if (gates) reasons.push(`${gates} gate(s)`);
    for (const c of rootState.connections ?? []) {
      if (c.fromId !== item.id && c.toId !== item.id) continue;
      const from = rootCode.get(c.fromId); const to = rootCode.get(c.toId);
      if (!hasTwin(from, to, c.type)) reasons.push(`edge ${from} -${c.type}-> ${to} has no module twin`);
    }
    (reasons.length ? hold : remove).push({ id: item.id, code, owners, ...(reasons.length ? { reasons } : {}) });
  }
  return { remove, hold, rootOnly };
}
