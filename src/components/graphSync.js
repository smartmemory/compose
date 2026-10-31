/**
 * graphSync.js: how GraphRenderer keeps ONE cytoscape instance (and the user's zoom/pan) across refreshes
 * (COMP-ROADMAP-GRAPH-ZOOM-DRIFT-1). Before this, every change to the element JSON destroyed the instance, re-ran
 * the layout and re-fit, so a builder tick that flipped one node's colour threw the owner's viewport away.
 */

const elementId = (el) => el.data.id ?? `${el.data.source}->${el.data.target}`;

/** Node and edge ids of an element list, sorted so equal sets compare equal. */
export function elementKey(elements) {
  return elements.map(elementId).sort().join('\u0001');
}

/**
 * What a refresh must do. `prev`/`next` carry `{ key: string-of-structural-inputs, setKey }`:
 * key = theme/viewMode/layout (a change here rebuilds the instance), setKey = the node+edge id set.
 * `touched` = the user has zoomed or panned since the last fit.
 * Returns { recreate, relayout, fit, restore }: restore keeps the viewport across a rebuild or relayout.
 */
export function planRefresh(prev, next, touched) {
  if (!prev) return { recreate: true, relayout: true, fit: true, restore: false };
  if (prev.key !== next.key) return { recreate: true, relayout: true, fit: !touched, restore: touched };
  if (prev.setKey !== next.setKey) return { recreate: false, relayout: true, fit: !touched, restore: touched };
  return { recreate: false, relayout: false, fit: false, restore: false };
}

/** Apply `elements` to a live cy in place: add/remove by id, refresh `data()` on the rest. Returns whether the id set changed. */
export function syncElements(cy, elements) {
  const wanted = new Map(elements.map((el) => [elementId(el), el]));
  let setChanged = false;
  cy.batch(() => {
    cy.elements().forEach((ele) => {
      if (!wanted.has(ele.id())) { cy.remove(ele); setChanged = true; }
    });
    const nodes = elements.filter((el) => !el.data.source);
    const edges = elements.filter((el) => el.data.source);
    for (const el of [...nodes, ...edges]) {
      const id = elementId(el);
      const existing = cy.getElementById(id);
      if (existing.nonempty()) {
        const data = { ...el.data };
        for (const k of Object.keys(existing.data())) if (!(k in data) && k !== 'id') data[k] = undefined;
        existing.data(data);
      } else { cy.add(el); setChanged = true; }
    }
  });
  return setChanged;
}
