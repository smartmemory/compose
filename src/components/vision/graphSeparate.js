/**
 * graphSeparate.js — pure overlap removal for the Graph's boxes (COMP-WIKI-GRAPH-SURFACES-1).
 *
 * fcose is a force layout: it never promises that two nodes do not overlap, and its ideal edge length (120) is shorter
 * than a card (150 x 60), so two linked cards are pulled closer than one card's width. On a sparse store that leaves a
 * few overlaps; on a dense merged project graph (SmartMemory: 578 edges over 582 active cards) it left 236 cards
 * covering each other's labels, and the saved layout files carry the same overlaps (SmartMemory 156 pairs, Compose 71).
 *
 * This pass runs after the layout and the saved positions. A few passes of pairwise push-apart first spread the dense
 * clumps, then boxes are placed one at a time, biggest first, then nearest the centre, each at the free spot nearest where
 * it was: a box that hits placed boxes tries the spots that just clear each box it hits (left, right, above, below) and
 * all of them at once, nearest first. Every box ends at least `gap` from every other, and the same input always gives the
 * same output. (Push-apart alone still had 303 overlapping pairs after 300 passes on the SmartMemory graph: dense clumps
 * oscillate. Placement alone took over 1 s there, with 17 to 51 boxes sent past the search.)
 */

/**
 * @param {{id: string, x: number, y: number, w: number, h: number}[]} boxes centre x, y and full width, height
 * @param {{gap?: number, maxTries?: number}} [opts] `maxTries`: candidate spots tried per box before the ring walk
 * @returns {{positions: Map<string, {x: number, y: number}>, unplaced: string[]}}
 *   `positions`: the boxes that moved, with their new centres. `unplaced`: ids that found no free spot within `maxTries`
 *   of the best-first search and went to the last resort, the nearest free spot on a ring-by-ring grid walk around their
 *   place (still no overlap, a little farther from their place than the rest: the caller warns, never hides it).
 */
export function separateBoxes(input, { gap = 16, maxTries = 4000, relax = 60 } = {}) {
  const n = input.length;
  const positions = new Map();
  const unplaced = [];
  if (n < 2) return { positions, unplaced };
  const boxes = relaxBoxes(input, gap, relax);
  let cx = 0, cy = 0;
  for (const b of boxes) { cx += b.x; cy += b.y; }
  cx /= n; cy /= n;
  // Big boxes first (a group is moved whole, and finds no room once small cards fill the gaps), then nearest the centre.
  const area = (b) => b.w * b.h, far = (b) => Math.hypot(b.x - cx, b.y - cy);
  const order = boxes.map((_, i) => i).sort((a, b) => area(boxes[b]) - area(boxes[a]) || far(boxes[a]) - far(boxes[b]) || a - b);
  const grid = new SpatialGrid(Math.max(64, ...boxes.map((b) => Math.max(b.w, b.h) + gap)));
  const placed = []; // {x, y, hw, hh}

  for (const i of order) {
    const b = boxes[i];
    const hw = b.w / 2 + gap / 2, hh = b.h / 2 + gap / 2;
    const heap = new MinHeap();
    const seen = new Set();
    const offer = (x, y) => {
      const key = `${Math.round(x)},${Math.round(y)}`;
      if (seen.has(key)) return;
      seen.add(key);
      heap.push(Math.hypot(x - b.x, y - b.y), x, y);
    };
    offer(b.x, b.y);
    let at = null;
    for (let tries = 0; tries < maxTries && heap.size; tries++) {
      const [, x, y] = heap.pop();
      const hits = grid.hits(placed, x, y, hw, hh);
      if (!hits.length) { at = { x, y }; break; }
      // The spots that clear each box hit, and the spots that clear all of them at once (a big group in a crowd needs those).
      let x1 = Infinity, x2 = -Infinity, y1 = Infinity, y2 = -Infinity;
      for (const k of hits) {
        const p = placed[k];
        offer(p.x - p.hw - hw, y); offer(p.x + p.hw + hw, y);
        offer(x, p.y - p.hh - hh); offer(x, p.y + p.hh + hh);
        x1 = Math.min(x1, p.x - p.hw); x2 = Math.max(x2, p.x + p.hw); y1 = Math.min(y1, p.y - p.hh); y2 = Math.max(y2, p.y + p.hh);
      }
      if (hits.length > 1) { offer(x1 - hw, y); offer(x2 + hw, y); offer(x, y1 - hh); offer(x, y2 + hh); }
    }
    if (!at) {
      // No free spot within maxTries: walk outward ring by ring on a grid around the box's own place and take the nearest
      // free spot of the first ring that has one. Space is unbounded and the placed boxes are finite, so a ring is free at last.
      const step = Math.min(b.w, b.h) / 2 + gap;
      for (let r = 1; !at; r++) {
        let bestD = Infinity;
        for (let gx = -r; gx <= r; gx++) {
          for (let gy = -r; gy <= r; gy++) {
            if (Math.max(Math.abs(gx), Math.abs(gy)) !== r) continue;
            const x = b.x + gx * step, y = b.y + gy * step, d = Math.hypot(gx, gy);
            if (d < bestD && !grid.hits(placed, x, y, hw, hh).length) { bestD = d; at = { x, y }; }
          }
        }
      }
      unplaced.push(b.id);
    }
    const k = placed.push({ x: at.x, y: at.y, hw, hh }) - 1;
    grid.add(k, at.x, at.y, hw, hh);
    if (at.x !== input[i].x || at.y !== input[i].y) positions.set(b.id, at);
  }
  return { positions, unplaced };
}

/** `iters` passes of pairwise push-apart (each overlapping pair moves apart along the axis that needs less, half each): it
 *  spreads a dense clump outward in a few ms, so the placement after it finds room near nearly every box. It does not
 *  converge on its own (dense clumps oscillate), which is why the placement finishes the job. Returns new box objects. */
function relaxBoxes(boxes, gap, iters) {
  const out = boxes.map((b) => ({ ...b }));
  const order = out.map((_, i) => i);
  for (let it = 0; it < iters; it++) {
    order.sort((a, b) => (out[a].x - out[a].w / 2) - (out[b].x - out[b].w / 2) || a - b);
    let found = 0;
    for (let p = 0; p < order.length; p++) {
      const a = out[order[p]];
      for (let q = p + 1; q < order.length; q++) {
        const b = out[order[q]];
        if (b.x - b.w / 2 >= a.x + a.w / 2 + gap) break;
        const dx = b.x - a.x, dy = b.y - a.y;
        const ox = (a.w + b.w) / 2 + gap - Math.abs(dx), oy = (a.h + b.h) / 2 + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        found++;
        // Coinciding centres: the earlier box keeps the left / top side, so the result never depends on float noise.
        if (ox <= oy) { const s = dx > 0 || (dx === 0 && order[p] < order[q]) ? 1 : -1; a.x -= (s * ox) / 2; b.x += (s * ox) / 2; }
        else { const s = dy > 0 || (dy === 0 && order[p] < order[q]) ? 1 : -1; a.y -= (s * oy) / 2; b.y += (s * oy) / 2; }
      }
    }
    if (!found) break;
  }
  return out;
}

/** Buckets of placed-box indices by cell, so a hit test reads only the cells a box spans. */
class SpatialGrid {
  constructor(cell) { this.cell = cell; this.cells = new Map(); }
  span(x, y, hw, hh, fn) {
    const c = this.cell;
    for (let gx = Math.floor((x - hw) / c); gx <= Math.floor((x + hw) / c); gx++) {
      for (let gy = Math.floor((y - hh) / c); gy <= Math.floor((y + hh) / c); gy++) fn(`${gx},${gy}`);
    }
  }
  add(k, x, y, hw, hh) { this.span(x, y, hw, hh, (key) => { const l = this.cells.get(key); if (l) l.push(k); else this.cells.set(key, [k]); }); }
  /** Placed indices whose box overlaps (x, y, hw, hh) by more than a rounding hair, in index order. */
  hits(placed, x, y, hw, hh) {
    const out = new Set();
    this.span(x, y, hw, hh, (key) => {
      for (const k of this.cells.get(key) ?? []) {
        const p = placed[k];
        if (Math.abs(p.x - x) < p.hw + hw - 1e-6 && Math.abs(p.y - y) < p.hh + hh - 1e-6) out.add(k);
      }
    });
    return [...out].sort((a, b) => a - b);
  }
}

/** A binary min-heap of [priority, x, y]; ties keep insertion order, so the search is deterministic. */
class MinHeap {
  constructor() { this.a = []; this.seq = 0; }
  get size() { return this.a.length; }
  less(i, j) { const a = this.a[i], b = this.a[j]; return a[0] < b[0] || (a[0] === b[0] && a[3] < b[3]); }
  swap(i, j) { const t = this.a[i]; this.a[i] = this.a[j]; this.a[j] = t; }
  push(p, x, y) {
    this.a.push([p, x, y, this.seq++]);
    for (let i = this.a.length - 1; i > 0;) { const u = (i - 1) >> 1; if (!this.less(i, u)) break; this.swap(i, u); i = u; }
  }
  pop() {
    const top = this.a[0], last = this.a.pop();
    if (this.a.length) {
      this.a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.a.length && this.less(l, m)) m = l;
        if (r < this.a.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
}

const boxOf = (id, bb) => ({ id, x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2, w: bb.w, h: bb.h });

/**
 * The Graph's pass over a laid-out cytoscape instance (GraphView runs it after the layout and after the saved positions):
 * first the cards inside each group, then the groups (moved whole, label included) with the cards that sit in no group.
 * Positions it moves are not saved: the pass gives the same result on every load. A box that needed the ring walk is warned about.
 * @param {import('cytoscape').Core} cy
 * @returns {{unplaced: string[]}}
 */
export function separateLayout(cy) {
  const unplaced = [];
  cy.batch(() => {
    cy.nodes(':parent').forEach((p) => {
      const kids = p.children().filter((c) => !c.isParent());
      const r = separateBoxes(kids.map((c) => boxOf(c.id(), c.boundingBox({ includeLabels: false }))));
      r.positions.forEach((pos, id) => cy.getElementById(id).position(pos));
      unplaced.push(...r.unplaced);
    });
  });
  const top = cy.nodes().filter((n) => !n.parent().length);
  const r = separateBoxes(top.map((n) => boxOf(n.id(), n.boundingBox({ includeLabels: n.isParent() }))), { gap: 24 });
  cy.batch(() => {
    r.positions.forEach((pos, id) => {
      const n = cy.getElementById(id);
      if (!n.isParent()) { n.position(pos); return; }
      const bb = n.boundingBox({ includeLabels: true });
      const dx = pos.x - (bb.x1 + bb.x2) / 2, dy = pos.y - (bb.y1 + bb.y2) / 2;
      n.children().forEach((c) => { c.position({ x: c.position('x') + dx, y: c.position('y') + dy }); });
    });
  });
  unplaced.push(...r.unplaced);
  if (unplaced.length) console.warn(`[graph] ${unplaced.length} node(s) found no free spot near their layout place and did not fit the best-first search and were placed near their spot by a ring walk: ${unplaced.slice(0, 5).join(', ')}`);
  return { unplaced };
}
