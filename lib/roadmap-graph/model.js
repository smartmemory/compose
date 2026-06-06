/**
 * model.js — pure graph rules for the roadmap dependency graph
 * (COMP-ROADMAP-GRAPH-1).
 *
 * Takes the collected node universe + raw edge declarations and produces the
 * final `{ nodes, edges }` arrays the template renders — applying the drop
 * rules and refusing to emit when an edge would dangle (the Cytoscape-crash
 * bug class this feature kills).
 */

/** Statuses whose nodes are dropped from the graph entirely. */
export const DROP_STATUSES = new Set(['COMPLETE', 'SUPERSEDED', 'KILLED']);

/** UPPERCASE feature status -> lowercase template status vocabulary. */
const STATUS_MAP = {
  PLANNED: 'planned',
  IN_PROGRESS: 'in_progress',
  PARTIAL: 'partial',
  PARKED: 'parked',
  BLOCKED: 'blocked',
};

export class DanglingEdgeError extends Error {
  /** @param {{from:string,to:string,kind:string}[]} dangling */
  constructor(dangling) {
    const lines = dangling.map((d) => `  ${d.from} --${d.kind}--> ${d.to}  (${d.to} is not a known feature)`);
    super(`roadmap-graph: refusing to emit — ${dangling.length} dangling edge(s):\n${lines.join('\n')}`);
    this.code = 'DANGLING_EDGE';
    this.dangling = dangling;
  }
}

/**
 * @typedef {object} CollectedNode
 * @property {string} id
 * @property {string} status      UPPERCASE source status
 * @property {string} [name]
 * @property {string} [priority]
 * @property {string} [track]
 * @property {string} [desc]
 *
 * @typedef {object} RawEdge
 * @property {string} from   prerequisite (source)
 * @property {string} to     dependent (target)
 * @property {'dep'|'concurrent'} type
 */

/**
 * Build the final graph from collected inputs.
 * @param {{ nodes: CollectedNode[], rawEdges: RawEdge[], knownCodes: Set<string> }} inputs
 * @returns {{ nodes: object[], edges: object[], dropped: string[] }}
 * @throws {DanglingEdgeError} when any non-dropped edge points at an unknown code
 */
export function buildGraph({ nodes, rawEdges, knownCodes }) {
  const known = knownCodes instanceof Set ? knownCodes : new Set(knownCodes || []);

  const dropped = [];
  const kept = new Map(); // id -> rendered node
  for (const n of nodes) {
    if (DROP_STATUSES.has(n.status)) {
      dropped.push(n.id);
      continue;
    }
    kept.set(n.id, renderNode(n));
  }

  const dangling = [];
  const seen = new Set();
  const edges = [];
  for (const e of rawEdges) {
    // Dangling = endpoint not a known feature anywhere (typo / never existed).
    const fromUnknown = !known.has(e.from);
    const toUnknown = !known.has(e.to);
    if (fromUnknown || toUnknown) {
      dangling.push({ from: e.from, to: e.to, kind: e.type });
      continue;
    }
    // Known but not rendered (dropped by status) -> silently drop the edge.
    if (!kept.has(e.from) || !kept.has(e.to)) continue;

    const key = `${e.type}|${e.from}|${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: e.from, target: e.to, type: e.type });
  }

  if (dangling.length > 0) throw new DanglingEdgeError(dangling);

  const nodeList = [...kept.values()];
  // kept preserves insertion order (already phase->position->code sorted by caller);
  // sort edges for deterministic, idempotent output.
  edges.sort((a, b) =>
    a.type.localeCompare(b.type) ||
    a.source.localeCompare(b.source) ||
    a.target.localeCompare(b.target));

  return { nodes: nodeList, edges, dropped };
}

function renderNode(n) {
  const name = n.name || n.id;
  const status = STATUS_MAP[n.status] || String(n.status || '').toLowerCase();
  const priority = ['high', 'medium', 'low'].includes(n.priority) ? n.priority : 'medium';
  const track = n.track || 'standalone';
  const desc = n.desc || '';
  // label: code + short name, wrapped by the template at render time.
  const shortName = name.length > 48 ? name.slice(0, 45) + '…' : name;
  return { id: n.id, label: `${n.id}\n${shortName}`, name, status, priority, track, desc };
}

/**
 * Normalize a feature's deps.yaml into directed raw edges.
 * @param {string} code
 * @param {{depends_on?:string[], concurrent_with?:string[], blocks?:string[]}} deps
 * @returns {RawEdge[]}
 */
export function depsToEdges(code, deps) {
  const out = [];
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
  for (const dep of arr(deps?.depends_on)) out.push({ from: dep, to: code, type: 'dep' });
  for (const blk of arr(deps?.blocks)) out.push({ from: code, to: blk, type: 'dep' });
  for (const sib of arr(deps?.concurrent_with)) {
    // canonicalize undirected concurrent edges so A+B never emit twice
    const [a, b] = code < sib ? [code, sib] : [sib, code];
    out.push({ from: a, to: b, type: 'concurrent' });
  }
  return out;
}
