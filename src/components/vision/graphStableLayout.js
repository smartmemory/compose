/**
 * graphStableLayout.js — the same card set gets the same fcose layout, every build.
 *
 * fcose defaults to `randomize: true`, which throws away every starting position and picks new ones, so each rebuild
 * (Status filter, group toggle) reshuffled the cards. The read-only project graph restores nothing, so it showed it.
 * Instead: start each card at a point hashed from its id, and tell fcose to keep it (`randomize: false`). The start
 * depends only on the id and the card count, never on element order.
 */

/** Two independent FNV-1a 32-bit hashes of `id` mapped to [0, 1): one for x, one for y. */
function unitPair(id) {
  let hx = 0x811c9dc5, hy = 0x01000193;
  for (let i = 0; i < id.length; i++) {
    hx = Math.imul(hx ^ id.charCodeAt(i), 0x01000193);
    hy = Math.imul(hy ^ id.charCodeAt(i), 0x85ebca6b);
  }
  hy = Math.imul(hy ^ (hy >>> 15), 0x2c1b3c6d);
  return [(hx >>> 0) / 2 ** 32, (hy >>> 0) / 2 ** 32];
}

/**
 * Give every card node (not an edge, not a group box) a starting `position` hashed from its id, and return the elements
 * in id order: fcose sums forces in element order, so a shuffled input would differ in the 14th decimal otherwise.
 */
export function seedPositions(elements) {
  elements = [...elements].sort((a, b) => String(a.data?.id).localeCompare(String(b.data?.id)));
  const cards = elements.filter(el => el.data && el.data.source == null && !el.data.isGroup);
  const span = Math.max(400, 250 * Math.sqrt(cards.length));
  return elements.map((el) => {
    if (!el.data || el.data.source != null || el.data.isGroup) return el;
    const [u, v] = unitPair(String(el.data.id));
    return { ...el, position: { x: (u - 0.5) * span, y: (v - 0.5) * span } };
  });
}

/** fcose option that keeps the seeded starting positions instead of randomizing them. */
export const STABLE_FCOSE = { randomize: false };
