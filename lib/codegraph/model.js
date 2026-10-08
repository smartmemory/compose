// lib/codegraph/model.js — STRAT-CODEGRAPH-1
//
// In-memory indexes over normalized snapshots (lib/codegraph/snapshot.js), and
// the callers query SmartMemory core does not ship (rebuilt from relations, the
// way the 2026-10-08 spikes did: replays/tools/callers.py).
//
// Every edge keeps SmartMemory's `resolution` and `confidence` as given. As of
// core 9ad526cb every resolved edge is name_only/0.5; the model does not
// reinterpret them.

const CALLER_EDGE_TYPES = new Set(['CALLS', 'REFERENCES']);

function push(map, key, value) {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The callee a call-text spelling actually names: argument groups removed, so
 * `checkOrInsert(a, b).then` is a call of `then` (on checkOrInsert's result), not of
 * checkOrInsert. (The spike's split('(') read it as checkOrInsert.)
 */
export function spelledName(callee) {
  let out = String(callee);
  for (let prev = null; prev !== out;) {
    prev = out;
    out = out.replace(/\([^()]*\)/g, '');
  }
  return out.replace(/\s+/g, '').replace(/\?\./g, '.');
}

function lastSegment(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * @param {Array<{repo: {name, prefix}, snapshot: object}>} snapshots  loadSnapshots().snapshots
 */
export function buildModel(snapshots) {
  const entities = [];
  const byId = new Map();
  const byName = new Map();
  const byQualified = new Map();
  const byFile = new Map();
  const incoming = new Map();
  const unresolvedByCallee = new Map();
  const repos = [];

  for (const { repo, snapshot } of snapshots) {
    if (!snapshot) continue;
    repos.push({ name: repo.name, prefix: repo.prefix ?? '', root: repo.root ?? null, complete: snapshot.complete });
    const prefix = repo.prefix ?? '';
    for (const raw of snapshot.entities) {
      const e = { ...raw, repo: repo.name, path: `${prefix}${raw.file}` };
      entities.push(e);
      byId.set(e.id, e);
      push(byFile, e.path, e);
      if (e.type !== 'module') {
        push(byName, e.name, e);
        const last = lastSegment(e.name);
        if (last !== e.name) push(byName, last, e);
        push(byQualified, e.qualifiedName, e);
      }
      for (const ev of e.unresolved) {
        push(unresolvedByCallee, lastSegment(spelledName(ev.callee)), { caller: e, ev });
      }
    }
    for (const r of snapshot.relations) {
      if (CALLER_EDGE_TYPES.has(r.type)) push(incoming, r.t, r);
    }
  }

  /** Display path → enclosing non-module entity with the smallest span. */
  function enclosing(path, line) {
    let best = null;
    for (const e of byFile.get(path) ?? []) {
      if (e.type === 'module' || e.line > line || e.endLine < line) continue;
      if (!best || e.endLine - e.line < best.endLine - best.line) best = e;
    }
    return best;
  }

  function where(e) {
    return `${e.path}:${e.line}`;
  }

  /**
   * Callers of every definition named `name` (bare or last dotted segment).
   * resolved: graph edges (CALLS + REFERENCES), unresolved:false, with resolution/confidence.
   * spelling: unresolved call evidence whose callee is `name` or ends with `.name` (not traversable).
   */
  function callersOf(name) {
    const key = lastSegment(name);
    const definitions = [...new Set([...(byName.get(name) ?? []), ...(byQualified.get(name) ?? [])])]
      .filter((e) => e.name === name || e.qualifiedName === name || lastSegment(e.name) === name);
    const resolved = [];
    for (const def of definitions) {
      for (const r of incoming.get(def.id) ?? []) {
        if (r.unresolved) continue; // a resolved self-edge is a real (recursive) caller
        const caller = byId.get(r.s);
        if (!caller) continue;
        resolved.push({
          caller: caller.qualifiedName,
          path: caller.path,
          line: r.line ?? caller.line,
          relationType: r.type,
          resolution: r.resolution,
          confidence: r.confidence,
          target: where(def),
        });
      }
    }
    const spelling = [];
    for (const { caller, ev } of unresolvedByCallee.get(key) ?? []) {
      const spelled = spelledName(ev.callee);
      if (spelled !== name && !spelled.endsWith(`.${name}`)) continue;
      spelling.push({
        caller: caller.qualifiedName,
        path: caller.path,
        line: ev.line ?? caller.line,
        callee: ev.callee,
        resolution: ev.resolution,
        moduleResolution: ev.moduleResolution,
      });
    }
    const order = (a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1);
    return { definitions: definitions.map(where).sort(), resolved: resolved.sort(order), spelling: spelling.sort(order) };
  }

  /** Name lookup: exact name, last dotted segment, or qualified name. */
  function lookup(name) {
    return byName.get(name) ?? byQualified.get(name) ?? byName.get(lastSegment(name)) ?? [];
  }

  return {
    repos,
    entities,
    byId,
    byName,
    byQualified,
    byFile,
    files: new Set(byFile.keys()),
    lookup,
    enclosing,
    callersOf,
    where,
  };
}
