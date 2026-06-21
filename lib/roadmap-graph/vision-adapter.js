/**
 * vision-adapter.js — COMP-ROADMAP-GRAPH-2.
 *
 * Converts a VisionStore's items + connections into the
 * { nodes, rawEdges, knownCodes, warnings } shape that buildGraph() consumes
 * (the same shape collect.js produces from feature.json/deps.yaml). This is the
 * single seam that lets the cockpit/vision model drive the one canonical
 * renderer (buildGraph -> renderGraphHtml).
 *
 * The adapter is source-agnostic: it is fed the LIVE in-memory store (cockpit
 * export routes) or a freshly-seeded throwaway store (canonical headless
 * generation). Both go through this one function.
 */

// Vision connection vocab -> graph edge vocab. Mirrors the dependency/parallel
// split the static path encodes in deps.yaml (depends_on/blocks -> dep,
// concurrent_with -> concurrent).
const VISION_EDGE_TYPE_MAP = {
  blocks: 'dep',
  informs: 'dep',
  implements: 'dep',
  supports: 'concurrent',
  contradicts: 'concurrent',
};

// Vision status (lowercase, 9 values) -> buildGraph input status (UPPERCASE).
// COMPLETE/KILLED/SUPERSEDED are DROP_STATUSES in model.js and get dropped there.
const VISION_STATUS_MAP = {
  planned: 'PLANNED',
  ready: 'PLANNED',
  in_progress: 'IN_PROGRESS',
  review: 'IN_PROGRESS',
  complete: 'COMPLETE',
  blocked: 'BLOCKED',
  parked: 'PARKED',
  killed: 'KILLED',
  superseded: 'SUPERSEDED',
};

function toUpperStatus(status) {
  return VISION_STATUS_MAP[status] || String(status || '').toUpperCase() || 'PLANNED';
}

/**
 * Remove `Track:` / `Priority:` annotation lines from a description so the
 * graph `desc` is clean prose. The static path reads these from structured
 * metadata; the cockpit historically encoded them inline.
 */
function stripTrackPriority(description) {
  if (!description) return '';
  return String(description)
    .split('\n')
    .filter((line) => !/^\s*(track|priority)\s*:/i.test(line))
    .join('\n')
    .trim();
}

/**
 * @param {Array} items - vision items (e.g. [...store.items.values()])
 * @param {Array} connections - vision connections (e.g. [...store.connections.values()])
 * @param {{externalPrefixes?: string[]}} [opts]
 * @returns {{nodes: object[], rawEdges: object[], knownCodes: Set<string>, warnings: string[]}}
 */
export function visionToGraphInputs(items, connections, { externalPrefixes = [] } = {}) {
  const isExternal = (code) => externalPrefixes.some((p) => code && code.startsWith(p));
  const warnings = [];
  const nodes = [];
  const knownCodes = new Set();
  const idToCode = new Map();

  for (const it of items || []) {
    if (it.type !== 'feature') continue;
    // The live store carries the canonical code in lifecycle.featureCode
    // (set via updateLifecycle); the top-level featureCode and title are
    // fallbacks. Mirror the precedence the export route used historically.
    const code = it.lifecycle?.featureCode || it.featureCode || it.title;
    if (!code) continue;
    idToCode.set(it.id, code);
    knownCodes.add(code);
    // External-prefixed codes are known (so edges to them don't dangle) but are
    // not rendered as nodes — buildGraph silently drops their edges.
    if (isExternal(code)) continue;
    nodes.push({
      id: code,
      status: toUpperStatus(it.status),
      name: it.title || code,
      priority: it.priority || 'medium',
      track: it.group || 'standalone',
      desc: stripTrackPriority(it.description),
    });
  }

  const rawEdges = [];
  for (const c of connections || []) {
    const fromCode = idToCode.get(c.fromId);
    const toCode = idToCode.get(c.toId);
    if (!fromCode || !toCode) {
      const bad = !fromCode ? c.fromId : c.toId;
      warnings.push(`connection ${c.id}: endpoint ${bad} is not a feature node (unresolved) — dropped`);
      continue;
    }
    const type = VISION_EDGE_TYPE_MAP[c.type];
    if (!type) {
      warnings.push(`connection ${c.id}: unmapped connection type "${c.type}" — dropped`);
      continue;
    }
    rawEdges.push({ from: fromCode, to: toCode, type });
  }

  return { nodes, rawEdges, knownCodes, warnings };
}

export { VISION_EDGE_TYPE_MAP, VISION_STATUS_MAP };
