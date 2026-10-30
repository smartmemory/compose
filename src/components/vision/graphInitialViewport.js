/**
 * graphInitialViewport.js — pure initial-viewport rule for the Graph (COMP-AUDIT-18).
 *
 * With many items "fit everything" shrinks the labels below legible size. After
 * the first layout the Graph fits, and if the fitted zoom is under
 * READABLE_ZOOM it zooms to that floor, centred on (in order) the focused
 * feature's node, the first in-progress feature, the centre of the largest
 * group. Positions, not node counts, drive it: the fitted zoom depends on the
 * bounding box and the container size.
 *
 * READABLE_ZOOM: the 9px node label renders at >= 10px (1.1 gives 9.9px).
 */
export const READABLE_ZOOM = 1.12;

/**
 * @param {{fittedZoom: number, candidates?: {focused?: {x:number,y:number}|null, inProgress?: {x:number,y:number}|null, largestGroup?: {x:number,y:number}|null}}} args
 * @returns {{zoom: number, centre: {x:number,y:number}|null}} `centre` null means "keep the fitted view" when the
 *   fit was already readable, else "centre of the whole graph" (no candidate had a position).
 */
export function graphInitialViewport({ fittedZoom, candidates = {} }) {
  if (!(fittedZoom < READABLE_ZOOM)) return { zoom: fittedZoom, centre: null };
  const centre = candidates.focused || candidates.inProgress || candidates.largestGroup || null;
  return { zoom: READABLE_ZOOM, centre };
}

/**
 * Centre (mean position) of the group with the most nodes; ties go to the
 * group seen first. Nodes without a group or a finite position are ignored.
 * @param {{group: string|null, x: number, y: number}[]} nodes
 * @returns {{x:number,y:number}|null}
 */
export function largestGroupCentre(nodes) {
  const groups = new Map();
  for (const n of nodes || []) {
    if (!n.group || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    if (!groups.has(n.group)) groups.set(n.group, []);
    groups.get(n.group).push(n);
  }
  let best = null;
  for (const members of groups.values()) {
    if (!best || members.length > best.length) best = members;
  }
  if (!best) return null;
  return {
    x: best.reduce((sum, n) => sum + n.x, 0) / best.length,
    y: best.reduce((sum, n) => sum + n.y, 0) / best.length,
  };
}
