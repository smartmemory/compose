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
 *   tap on a node    → selectStep(id)
 *   cxttap on a node → confirm + deleteStep(id)
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

// Build the multi-line node label: id / agent-or-function / truncated intent.
function stepLabel(step) {
  const lines = [step.id || '(unnamed)'];
  const sub = step.agent || (step.function ? `fn:${step.function}` : step.kind);
  if (sub) lines.push(truncate(sub, 28));
  if (step.intent) lines.push(truncate(step.intent, 40));
  return lines.join('\n');
}

// Translate the selected flow's steps into cytoscape elements. The cytoscape
// element id is a synthetic per-index id (n0, n1, …), NOT step.id — a transient
// duplicate step id (e.g. mid-rename) would otherwise make the cytoscape
// constructor throw and break the canvas. The real id rides in data.stepId.
function toElements(steps, warningsByStepId) {
  const elements = [];
  const elemIdByStep = new Map(); // step.id -> first element id (for edge endpoints)
  steps.forEach((step, i) => {
    const elemId = `n${i}`;
    if (!elemIdByStep.has(step.id)) elemIdByStep.set(step.id, elemId);
    elements.push({
      data: {
        id: elemId,
        stepId: step.id,
        label: stepLabel(step),
        hasWarning: (warningsByStepId?.[step.id]?.length > 0) ? 1 : 0,
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

const PipelineEditorCanvas = forwardRef(function PipelineEditorCanvas(_props, ref) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const isDark = useTheme();
  const cyColors = isDark ? CY_DARK : CY_LIGHT;

  const model = useVisionStore(s => s.editorModel);
  const selectedFlow = useVisionStore(s => s.editorSelectedFlow);
  const selectedStep = useVisionStore(s => s.editorSelectedStep);
  const errors = useVisionStore(s => s.editorErrors);
  const selectStep = useVisionStore(s => s.selectStep);
  const deleteStep = useVisionStore(s => s.deleteStep);

  const steps = model && selectedFlow ? flowSteps(model, selectedFlow) : [];
  // Re-key on flow + ids + labels so the canvas rebuilds on any structural edit.
  const renderKey = JSON.stringify({
    flow: selectedFlow,
    steps: steps.map(s => ({ id: s.id, l: stepLabel(s), d: s.depends_on, w: errors?.warningsByStepId?.[s.id]?.length || 0 })),
  });

  // Re-layout helper exposed to the toolbar.
  useImperativeHandle(ref, () => ({
    relayout: () => {
      const cy = cyRef.current;
      if (cy) { cy.layout(LR_LAYOUT).run(); cy.fit(undefined, 40); }
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const cy = cytoscape({
      container: containerRef.current,
      elements: toElements(steps, errors?.warningsByStepId),
      style: buildStyle(cyColors),
      layout: LR_LAYOUT,
      minZoom: 0.2, maxZoom: 3, wheelSensitivity: 0.3, boxSelectionEnabled: false,
    });
    cyRef.current = cy;

    cy.on('tap', 'node', (evt) => selectStep(evt.target.data('stepId')));
    cy.on('cxttap', 'node', (evt) => {
      const id = evt.target.data('stepId');
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm(`Delete step "${id}"?`)) {
        deleteStep(id);
      }
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
      <div ref={containerRef} className="w-full h-full" data-testid="pipeline-editor-canvas" />
    </div>
  );
});

export default PipelineEditorCanvas;

// Cytoscape doesn't survive Vite HMR — force full remount on edit.
if (import.meta.hot) import.meta.hot.accept();
