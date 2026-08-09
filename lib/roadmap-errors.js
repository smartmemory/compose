/**
 * roadmap-errors.js — typed errors for the ROADMAP.md write path
 * (COMP-CONFLICT-MERGE).
 *
 * Lives in its own module so both `roadmap-preservers.js` (which raises the
 * unbalanced-marker error) and `roadmap-residue.js` (which raises the prose-loss
 * error) can import them without an import cycle.
 */

/**
 * Regenerating ROADMAP.md would drop hand-authored content the generator cannot
 * account for. Carries the lost lines with their nearest heading and a
 * remediation naming the exact marker to add. This is the typed-error shape
 * IDEA-2 asks for, scoped to one writer.
 */
export class RoadmapProseLossError extends Error {
  /** @param {Array<{lineNo:number, text:string, nearestHeading:string|null}>} lines */
  constructor(lines) {
    super(`ROADMAP.md regeneration would drop ${lines.length} hand-authored line(s)`);
    this.name = 'RoadmapProseLossError';
    this.code = 'ROADMAP_PROSE_LOSS';
    this.lines = lines;
    this.source_of_truth = 'ROADMAP.md';
    this.remediation =
      'Wrap the lost lines in <!-- preserved-section: <id> --> … <!-- /preserved-section -->, ' +
      'or re-run with --protect to do that automatically, or --accept-loss to write anyway.';
  }
}

/**
 * A preserved-section open marker with no matching close. Left unfixed, the
 * content it was meant to protect is silently discarded on regen — a typo'd
 * close deletes exactly what it was guarding.
 */
export class RoadmapUnbalancedMarkerError extends Error {
  /** @param {Array<{id:string, lineNo:number}>} markers */
  constructor(markers) {
    super(`ROADMAP.md has ${markers.length} unbalanced preserved-section marker(s)`);
    this.name = 'RoadmapUnbalancedMarkerError';
    this.code = 'ROADMAP_UNBALANCED_MARKER';
    this.markers = markers;
    this.source_of_truth = 'ROADMAP.md';
    this.remediation =
      'Add a matching <!-- /preserved-section --> close for each open marker listed above.';
  }
}

/**
 * Two preserved-sections share an id. They are keyed by id in a Map, so the
 * second overwrites the first and its content is dropped on regen — and because
 * the content is inside markers, the residue check treats it as safe and never
 * flags the loss. Fail loud instead.
 */
export class RoadmapDuplicateMarkerError extends Error {
  /** @param {Array<{id:string, lineNo:number}>} markers  the DUPLICATE occurrences */
  constructor(markers) {
    super(`ROADMAP.md has ${markers.length} duplicate preserved-section id(s)`);
    this.name = 'RoadmapDuplicateMarkerError';
    this.code = 'ROADMAP_DUPLICATE_MARKER';
    this.markers = markers;
    this.source_of_truth = 'ROADMAP.md';
    this.remediation =
      'Give each preserved-section a unique id — a repeated id silently drops all but the last block.';
  }
}
