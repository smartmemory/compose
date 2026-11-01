/**
 * graphAfterLayout.js — the one synchronous step GraphView runs right after `cytoscape({ layout })`.
 *
 * The constructor runs fcose to completion before it returns, so nothing registered afterwards (a `layoutstop`
 * listener) can see that layout. Saved and dragged positions must be put back here, on every rebuild, or fcose's
 * randomized layout replaces the owner's.
 */
export function settleAfterLayout(cy, { savedLoaded, applySavedAndCapture, separateLayout, applyReadableViewport }) {
  if (savedLoaded) applySavedAndCapture(cy);
  separateLayout(cy);
  cy.fit(undefined, 30);
  applyReadableViewport(cy);
}
