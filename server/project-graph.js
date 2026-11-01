/**
 * project-graph.js — COMP-COCKPIT-PROJECT-MODEL-1: one project's roadmap graph, merged at read time.
 *
 * Members are the project root's store plus each module store. Each is read straight from
 * `<member>/.compose/data/vision-state.json` (VisionStore._save writes it on every mutation, so the file is current),
 * never through the workspace runtime and never written. The result is the `{items, connections}` shape GraphView
 * already takes, with ids namespaced `<member>:<id>` and each item carrying the `module` that owns it.
 *
 * Collisions on featureCode (owner Q1, 2026-11-01: "the module store is the truth"): any module beats the root store;
 * between modules, the one with `<features>/<CODE>/` on disk wins, then config order. The loser is dropped and its
 * edges are re-pointed to the winner. Root-store `track` items titled like a configured module are dropped too:
 * `modules[]` replaces them.
 *
 * Cross-store links (F1b): a connection may name an end by feature code (`fromCode` / `toCode`) when that end lives in
 * another member's store. The code wins over the local id and resolves to the item shown for it (the module owner by the
 * precedence above). A code that no member holds drops the connection, as an unresolvable id does.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { readComposeConfig, storeState } from './project-model.js';

const featuresDirOf = (root) => {
  const { config } = readComposeConfig(root);
  const rel = typeof config?.paths?.features === 'string' && config.paths.features ? config.paths.features : 'docs/features';
  return isAbsolute(rel) ? rel : join(root, rel);
};

const codeOf = (item) => item?.lifecycle?.featureCode ?? item?.featureCode ?? null;

/** The members to merge: `[{name, root, isRoot}]`, root store first, then modules in config order. */
export function projectMembers(project) {
  const members = [{ name: project.name, root: project.root, isRoot: true }];
  for (const m of project.modules ?? []) {
    if (m.realpath) members.push({ name: m.name, root: m.realpath, isRoot: false, error: m.error ?? null });
  }
  return members;
}

function readMember(member) {
  if (member.error) return { items: [], connections: [], skipped: member.error };
  const s = storeState(member.root);
  if (!s.lifecycle) return { items: [], connections: [], skipped: 'lifecycle:false' };
  if (!s.hasStore) return { items: [], connections: [], skipped: 'no store' };
  let state;
  try { state = JSON.parse(readFileSync(s.file, 'utf8')); } catch (e) {
    console.warn(`[project-graph] ${s.file} unreadable, member ${member.name} contributes nothing: ${e.message}`);
    return { items: [], connections: [], skipped: `unreadable: ${e.message}` };
  }
  return {
    items: Array.isArray(state?.items) ? state.items : [],
    connections: Array.isArray(state?.connections) ? state.connections : [],
    skipped: null,
  };
}

/** `{project, items, connections, members, modules, focus, dropped}` for one project from `readProjects`. */
export function buildProjectGraph(project, { lane = null } = {}) {
  const members = projectMembers(project);
  const moduleNames = new Set((project.modules ?? []).map((m) => m.name));
  const loaded = members.map((m) => ({ ...m, ...readMember(m) }));

  // Pass 1: the winner per featureCode.
  const winner = new Map(); // code -> member name
  const rank = (m, code) => {
    if (m.isRoot) return 0;
    return existsSync(join(featuresDirOf(m.root), code)) ? 2 : 1;
  };
  for (const m of loaded) {
    for (const item of m.items) {
      const code = codeOf(item);
      if (!code) continue;
      const prior = winner.get(code);
      if (!prior) { winner.set(code, m); continue; }
      if (rank(m, code) > rank(prior, code)) winner.set(code, m);
    }
  }

  const items = [];
  const dropped = [];
  const idMap = new Map(); // `${member}:${storeId}` -> namespaced id of the item shown
  const shownByCode = new Map();
  for (const m of loaded) {
    for (const item of m.items) {
      const nsId = `${m.name}:${item.id}`;
      const code = codeOf(item);
      if (m.isRoot && item.type === 'track' && moduleNames.has(item.title)) continue;
      if (code && winner.get(code) !== m) {
        dropped.push({ code, from: m.name, winner: winner.get(code).name });
        continue;
      }
      idMap.set(nsId, nsId);
      if (code) shownByCode.set(code, nsId);
      items.push({ ...item, id: nsId, module: m.name, memberRoot: m.root });
    }
  }
  // Losers re-point to the winner by code.
  for (const m of loaded) {
    for (const item of m.items) {
      const nsId = `${m.name}:${item.id}`;
      const code = codeOf(item);
      if (!idMap.has(nsId) && code && shownByCode.has(code)) idMap.set(nsId, shownByCode.get(code));
    }
  }

  const connections = [];
  const seen = new Set();
  for (const m of loaded) {
    for (const c of m.connections) {
      const end = (code, id) => (typeof code === 'string' && code ? shownByCode.get(code) : idMap.get(`${m.name}:${id}`));
      const fromId = end(c.fromCode, c.fromId);
      const toId = end(c.toCode, c.toId);
      if (!fromId || !toId || fromId === toId) continue;
      const key = `${fromId}|${toId}|${c.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      connections.push({ ...c, id: `${m.name}:${c.id}`, fromId, toId });
    }
  }

  const laneEntry = lane ? (project.lanes ?? []).find((l) => l.id === lane) : null;
  return {
    project: project.name,
    items,
    connections,
    members: loaded.map((m) => ({
      name: m.name, root: m.root, items: items.filter((i) => i.module === m.name).length, skipped: m.skipped,
    })),
    modules: project.modules ?? [],
    focus: { lane: laneEntry ? laneEntry.id : null, modules: laneEntry?.module ? [laneEntry.module] : [] },
    dropped,
  };
}

/**
 * DOC-LINKS on the merged graph: the primary doc of item `id`, read from the OWNING member's root. `{status, body}`.
 * Only the item's own `files` are candidates (design.md first), and a path that escapes the member root is refused.
 */
export function readProjectDoc(project, id) {
  const graph = buildProjectGraph(project);
  const item = graph.items.find((i) => i.id === id);
  if (!item) return { status: 404, body: { error: `no item ${String(id).slice(0, 120)} in ${project.name}` } };
  const files = Array.isArray(item.files) ? item.files.filter((f) => typeof f === 'string' && f) : [];
  const ordered = [...files.filter((f) => f.split('/').pop() === 'design.md'), ...files.filter((f) => f.split('/').pop() !== 'design.md')];
  const root = item.memberRoot;
  for (const f of ordered) {
    const abs = isAbsolute(f) ? f : resolve(root, f);
    let real;
    try { real = realpathSync(abs); } catch { continue; }
    if (real !== root && !real.startsWith(root + sep)) continue;
    try { if (!statSync(real).isFile()) continue; } catch { continue; }
    return { status: 200, body: { id, module: item.module, path: real, text: readFileSync(real, 'utf8') } };
  }
  return { status: 404, body: { error: `${item.module}: no doc on disk for ${codeOf(item) ?? id}` } };
}
