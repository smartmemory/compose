/**
 * PipelineEditorCanvas — COMP-PIPE-EDIT-1 / T4.
 *
 * A cytoscape canvas that renders ONLY the editor's currently selected flow:
 * one node per step (multi-line label: id / agent-or-function / truncated
 * intent) with directed edges drawn from each step's `depends_on`.
 *
 * The model in useVisionStore is the single source of truth; cytoscape is a
 * pure render+select surface (mirrors the lifecycle pattern in
 * src/components/GraphRenderer.jsx — `cytoscape.use(cytoscapeDagre)`, dagre
 * layout, rebuild-on-change).
 *
 *   tap on a node    → selectStep(id)   (normal mode)
 *   cxttap on a node → confirm + deleteStep(id)
 *   cxttap on an edge→ confirm + removeDependency(target, source)
 *
 * COMP-PIPE-EDIT-3 — Connect mode (toolbar-controlled via the `connectMode`
 * prop): first node tap = source (highlighted), second node tap = target →
 * addDependency(targetStepId, sourceStepId) (edge source→target means "target
 * depends_on source", matching the depends_on edge render). Tapping the same
 * node again cancels. Invalid attempts (cycle/self/dangling) don't mutate; the
 * store surfaces a message and the pending source is cleared.
 *
 * Steps whose id has a validation warning (editorErrors.warningsByStepId) carry
 * a red badge border so the canvas mirrors the inspector's inline errors.
 */
import React, { useRef, useEffect, useState, useImperativeHandle, forwardRef } from 'react';
import cytoscape from 'cytoscape';
import cytoscapeDagre from 'cytoscape-dagre';
import { useVisionStore } from './useVisionStore.js';
import { flowSteps } from '../../lib/pipeline-model.js';

cytoscape.use(cytoscapeDagre);

// Cytoscape can't resolve CSS custom properties — hex mirrors per theme,
// matching GraphRenderer.jsx so the two canvases look consistent.
const CY_DARK = {
  surface: '#0e0e19', overlay: '#161625', text: '#f1f5f9',
  textMuted: '#475569', border: '#334155', accent: '#FBBF24', danger: '#ef4444',
};
const CY_LIGHT = {
  surface: '#FAFAFA', overlay: '#F5F5F5', text: '#0a0a0a',
  textMuted: '#a3a3a3', border: '#d4d4d4', accent: '#FBBF24', danger: '#dc2626',
};

function useTheme() {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'));
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const obs = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

function buildStyle(c) {
  return [
    {
      selector: 'node',
      style: {
        'label': 'data(label)', 'text-valign': 'center', 'text-halign': 'center',
        'text-wrap': 'wrap', 'text-max-width': '150px', 'font-size': '10px',
        'font-family': 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        'color': c.text, 'background-color': c.overlay,
        'border-width': 1, 'border-color': c.border, 'border-opacity': 0.8,
        'width': 170, 'height': 64, 'shape': 'round-rectangle',
        'text-outline-width': 0, 'padding': '6px',
      },
    },
    { selector: 'node:selected', style: { 'border-width': 2, 'border-opacity': 1, 'border-color': c.accent } },
    { selector: 'node[hasWarning = 1]', style: { 'border-color': c.danger, 'border-width': 2, 'border-opacity': 1 } },
    // COMP-PIPE-EDIT-3: the pending connect-source node + a transient flash.
    { selector: 'node.connect-source', style: { 'border-color': c.accent, 'border-width': 3, 'border-opacity': 1, 'background-color': c.overlay } },
    // COMP-PIPE-EDIT-5: members of the multi-select collapse group.
    { selector: 'node.multi-select', style: { 'border-color': c.accent, 'border-width': 3, 'border-style': 'dashed', 'border-opacity': 1 } },
    { selector: '.connect-flash', style: { 'border-color': c.danger, 'border-width': 3, 'border-opacity': 1, 'line-color': c.danger, 'target-arrow-color': c.danger } },
    {
      selector: 'edge',
      style: {
        'width': 1.2, 'line-color': c.textMuted, 'target-arrow-color': c.textMuted,
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
        'arrow-scale': 0.8, 'opacity': 0.6,
      },
    },
  ];
}

const LR_LAYOUT = { name: 'dagre', rankDir: 'LR', rankSep: 90, nodeSep: 45, padding: 40 };

function truncate(str, n) {
  if (!str) return '';
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Resolve a flow-step's sub-flow ports for the label (COMP-PIPE-EDIT-5). Returns
// { inputs: string[], output: string|null } from model._doc.flows[<subName>], or
// null for non-flow steps / when the sub-flow def isn't present.
function subflowPorts(step, model) {
  if (step.kind !== 'flow') return null;
  const subName = step._extra?.flow;
  if (!subName) return null;
  const def = model?._doc?.flows?.[subName];
  if (!def || typeof def !== 'object') return { inputs: [], output: null, name: subName };
  const inputs = def.input && typeof def.input === 'object' ? Object.keys(def.input) : [];
  const output = (def.output != null && def.output !== '') ? String(def.output) : null;
  return { inputs, output, name: subName };
}

// Build the multi-line node label: id / agent-or-function / truncated intent.
// For a sub-flow (kind:'flow') step, append the input port keys + output contract
// as text (COMP-PIPE-EDIT-5: ports are rendered as text, not real handles).
function stepLabel(step, model) {
  const lines = [step.id || '(unnamed)'];
  const ports = subflowPorts(step, model);
  if (ports) {
    lines.push(truncate(`⊟ flow: ${ports.name}`, 28));
    if (ports.inputs.length) lines.push(truncate(`in: ${ports.inputs.join(', ')}`, 36));
    if (ports.output) lines.push(truncate(`out: ${ports.output}`, 36));
    return lines.join('\n');
  }
  const sub = step.agent || (step.function ? `fn:${step.function}` : step.kind);
  if (sub) lines.push(truncate(sub, 28));
  if (step.intent) lines.push(truncate(step.intent, 40));
  return lines.join('\n');
}

// Translate the selected flow's steps into cytoscape elements. The cytoscape
// element id is a synthetic per-index id (n0, n1, …), NOT step.id — a transient
// duplicate step id (e.g. mid-rename) would otherwise make the cytoscape
// constructor throw and break the canvas. The real id rides in data.stepId.
function toElements(steps, warningsByStepId, model) {
  const elements = [];
  const elemIdByStep = new Map(); // step.id -> first element id (for edge endpoints)
  steps.forEach((step, i) => {
    const elemId = `n${i}`;
    if (!elemIdByStep.has(step.id)) elemIdByStep.set(step.id, elemId);
    elements.push({
      data: {
        id: elemId,
        stepId: step.id,
        label: stepLabel(step, model),
        hasWarning: (warningsByStepId?.[step.id]?.length > 0) ? 1 : 0,
        // COMP-PIPE-EDIT-5: flow-step nodes are double-tappable to expand.
        isFlow: step.kind === 'flow' ? 1 : 0,
        flowName: step.kind === 'flow' ? (step._extra?.flow || '') : '',
      },
    });
  });
  steps.forEach((step, i) => {
    for (const dep of (step.depends_on || [])) {
      const source = elemIdByStep.get(dep);
      if (source) {
        // Edge points from the dependency to the dependent step (data flow order).
        elements.push({ data: { id: `e-${source}-n${i}`, source, target: `n${i}` } });
      }
    }
  });
  return elements;
}

const PipelineEditorCanvas = forwardRef(function PipelineEditorCanvas(
  { connectMode = false, multiSelect = [], onMultiSelectChange, onExpand } = {},
  ref,
) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const isDark = useTheme();
  const cyColors = isDark ? CY_DARK : CY_LIGHT;

  const model = useVisionStore(s => s.editorModel);
  const selectedFlow = useVisionStore(s => s.editorSelectedFlow);
  const selectedStep = useVisionStore(s => s.editorSelectedStep);
  const errors = useVisionStore(s => s.editorErrors);
  const readOnly = useVisionStore(s => s.editorReadOnly);
  const selectStep = useVisionStore(s => s.selectStep);
  const deleteStep = useVisionStore(s => s.deleteStep);
  const addDependency = useVisionStore(s => s.addDependency);
  const removeDependency = useVisionStore(s => s.removeDependency);

  // COMP-PIPE-EDIT-5: live refs for the multi-select set + callbacks so the
  // cytoscape handlers (bound once per rebuild) read current values without a
  // rebuild, mirroring the connect-mode ref pattern.
  const multiSelectRef = useRef(multiSelect);
  const onMultiSelectChangeRef = useRef(onMultiSelectChange);
  const onExpandRef = useRef(onExpand);
  const readOnlyRef = useRef(readOnly);
  useEffect(() => { multiSelectRef.current = multiSelect; }, [multiSelect]);
  useEffect(() => { onMultiSelectChangeRef.current = onMultiSelectChange; }, [onMultiSelectChange]);
  useEffect(() => { onExpandRef.current = onExpand; }, [onExpand]);
  useEffect(() => { readOnlyRef.current = readOnly; }, [readOnly]);

  // Live refs so the cytoscape tap handlers (bound once per graph rebuild) read
  // current connect-mode + pending-source without forcing a graph rebuild.
  const connectModeRef = useRef(connectMode);
  useEffect(() => {
    connectModeRef.current = connectMode;
    // Leaving connect mode clears any half-finished pending source.
    if (!connectMode) {
      pendingSourceRef.current = null;
      const cy = cyRef.current;
      if (cy) cy.nodes().removeClass('connect-source');
    }
  }, [connectMode]);
  const pendingSourceRef = useRef(null); // step id of the pending connect source

  const steps = model && selectedFlow ? flowSteps(model, selectedFlow) : [];
  // Re-key on flow + ids + labels so the canvas rebuilds on any structural edit.
  const renderKey = JSON.stringify({
    flow: selectedFlow,
    steps: steps.map(s => ({ id: s.id, l: stepLabel(s, model), d: s.depends_on, w: errors?.warningsByStepId?.[s.id]?.length || 0 })),
  });

  // Re-layout helper, shared by the toolbar (imperative handle) and the
  // connect-mode wire success path.
  const runLayout = () => {
    const cy = cyRef.current;
    if (cy) { cy.layout(LR_LAYOUT).run(); cy.fit(undefined, 40); }
  };
  useImperativeHandle(ref, () => ({ relayout: runLayout }), []);

  // Flash a node/edge red briefly to signal a rejected connect attempt.
  const flash = (ele) => {
    if (!ele || !ele.length) return;
    ele.addClass('connect-flash');
    setTimeout(() => { try { ele.removeClass('connect-flash'); } catch { /* destroyed */ } }, 600);
  };

  useEffect(() => {
    if (!containerRef.current) return undefined;
    // A flow/spec switch (or any structural edit) rebuilds the graph — drop any
    // half-finished connect source so a second tap can't wire to a step id from
    // the previous flow (which would hit the dangling-edge reject path).
    pendingSourceRef.current = null;
    const cy = cytoscape({
      container: containerRef.current,
      elements: toElements(steps, errors?.warningsByStepId, model),
      style: buildStyle(cyColors),
      layout: LR_LAYOUT,
      minZoom: 0.2, maxZoom: 3, wheelSensitivity: 0.3, boxSelectionEnabled: false,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      const stepId = node.data('stepId');
      // Normal mode: tap = select. Shift-tap = toggle into the collapse multi-
      // select set (COMP-PIPE-EDIT-5; disabled for read-only specs).
      if (!connectModeRef.current) {
        const shift = !!(evt.originalEvent && evt.originalEvent.shiftKey);
        if (shift && !readOnlyRef.current && onMultiSelectChangeRef.current) {
          const cur = multiSelectRef.current || [];
          const next = cur.includes(stepId) ? cur.filter(id => id !== stepId) : [...cur, stepId];
          onMultiSelectChangeRef.current(next);
          return;
        }
        selectStep(stepId);
        return;
      }

      // Connect mode. First tap picks the source; second tap on a DIFFERENT node
      // wires source→target == addDependency(target, source). Re-tapping the same
      // node cancels.
      const pending = pendingSourceRef.current;
      if (!pending) {
        pendingSourceRef.current = stepId;
        cy.nodes().removeClass('connect-source');
        node.addClass('connect-source');
        return;
      }
      if (pending === stepId) {
        // Cancel the pending source.
        pendingSourceRef.current = null;
        cy.nodes().removeClass('connect-source');
        return;
      }
      // Wire: edge pending(source) → stepId(target) means target depends_on source.
      const ok = addDependency(stepId, pending);
      pendingSourceRef.current = null;
      cy.nodes().removeClass('connect-source');
      if (ok) runLayout();
      else flash(node);
    });

    cy.on('cxttap', 'node', (evt) => {
      // Right-click delete is only offered in normal mode (connect mode owns taps).
      if (connectModeRef.current) return;
      const id = evt.target.data('stepId');
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(`Delete step "${id}"?`)) {
        deleteStep(id);
      }
    });

    // cxttap on an EDGE → confirm → removeDependency(target, source). The edge's
    // source/target nodes carry the real step ids in data.stepId.
    cy.on('cxttap', 'edge', (evt) => {
      const edge = evt.target;
      const sourceStepId = cy.getElementById(edge.data('source')).data('stepId');
      const targetStepId = cy.getElementById(edge.data('target')).data('stepId');
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined'
        && window.confirm(`Remove dependency "${targetStepId}" → "${sourceStepId}"?`)) {
        removeDependency(targetStepId, sourceStepId);
      }
    });

    // COMP-PIPE-EDIT-5: double-tap a sub-flow (kind:'flow') node to expand it —
    // open the referenced sub-flow for editing (reuses the flow switcher).
    cy.on('dbltap', 'node', (evt) => {
      if (connectModeRef.current) return;
      const node = evt.target;
      if (node.data('isFlow') !== 1) return;
      const fl = node.data('flowName');
      if (fl && onExpandRef.current) onExpandRef.current(fl);
    });

    cy.on('layoutstop', () => cy.fit(undefined, 40));

    return () => { cy.destroy(); cyRef.current = null; };
  // Rebuild whenever the rendered content or theme changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey, isDark]);

  // Keep the cytoscape selection in sync with the store's selected step.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().unselect();
    if (selectedStep) {
      const node = cy.nodes(`[stepId = "${selectedStep}"]`);
      if (node && node.length) node.select();
    }
  }, [selectedStep, renderKey]);

  // COMP-PIPE-EDIT-5: paint the multi-select collapse group imperatively (no
  // rebuild) — mirrors the single-selection sync above.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass('multi-select');
    for (const id of (multiSelect || [])) {
      const node = cy.nodes(`[stepId = "${id}"]`);
      if (node && node.length) node.addClass('multi-select');
    }
  }, [multiSelect, renderKey]);

  if (!model || !selectedFlow) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
        Select a spec and a flow to edit.
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
        Flow "{selectedFlow}" has no steps. Use “Add step” to create one.
      </div>
    );
  }

  return (
    <div className="w-full h-full relative bg-background">
      {connectMode && (
        <div
          className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-2.5 py-1 rounded-full text-[10px] bg-accent/15 text-accent border border-accent/40 pointer-events-none"
          data-testid="connect-mode-hint"
        >
          Connect mode: tap a source step, then a target. Tap the same node to cancel.
        </div>
      )}
      <div
        ref={containerRef}
        className={connectMode ? 'w-full h-full cursor-crosshair' : 'w-full h-full'}
        data-testid="pipeline-editor-canvas"
      />
    </div>
  );
});

export default PipelineEditorCanvas;

// Cytoscape doesn't survive Vite HMR — force full remount on edit.
if (import.meta.hot) import.meta.hot.accept();
