/**
 * graphStableLayout.js — the same card set gets the same fcose layout, every build.
 *
 * fcose lays out from random starting points (`randomize: true`, its spectral pass), so each rebuild (Status filter,
 * group toggle) reshuffled the cards. fcose exposes no seed, but every random number it draws comes from `Math.random`
 * while the `cytoscape({ layout })` constructor runs it (synchronously). So: sort the elements into a fixed order, and
 * build under a seeded `Math.random`, restored as soon as the constructor returns.
 *
 * Not `randomize: false` from hashed start points: that puts fcose in incremental mode (cooling capped at 0.3, 100 px a
 * step), a polish pass that barely moves anything, and the grouped graph came out about 7x the edge length
 * (COMP-GRAPH-STABLE-LAYOUT-1 review H1).
 */

export const LAYOUT_SEED = 0x5eed1a7;

/** mulberry32: a small, fast, seeded PRNG returning [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Elements in id order. fcose sums forces in element order, so a shuffled input would differ in the last decimals.
 * A plain `<` compare, not `localeCompare`: collation depends on the browser locale (review L1).
 */
export function sortElements(elements) {
  const key = el => String(el.data?.id);
  return [...elements].sort((a, b) => {
    const ka = key(a), kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Run `build` (the `cytoscape({...})` call) with `Math.random` seeded, and put the original back whatever happens. */
export function withSeededRandom(build, seed = LAYOUT_SEED) {
  const original = Math.random;
  Math.random = mulberry32(seed);
  try {
    return build();
  } finally {
    Math.random = original;
  }
}
