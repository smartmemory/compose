/**
 * render.js — render the roadmap-graph HTML from the packaged template by
 * replacing the @generated data regions (COMP-ROADMAP-GRAPH-1).
 *
 * Deterministic: identical inputs produce byte-identical output (no wall-clock
 * timestamps), which underpins the `--check` idempotency guarantee.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, 'template.html');

const REGIONS = {
  config: ['/* @generated:config:start */', '/* @generated:config:end */'],
  nodes: ['/* @generated:nodes:start */', '/* @generated:nodes:end */'],
  edges: ['/* @generated:edges:start */', '/* @generated:edges:end */'],
};

/**
 * @param {{ nodes: object[], edges: object[], config: object }} input
 * @returns {string} full HTML document
 */
export function renderGraphHtml({ nodes, edges, config }) {
  let html = readFileSync(TEMPLATE_PATH, 'utf-8');
  const cfg = {
    title: config?.title || 'Roadmap Dependency Graph',
    subtitle: config?.subtitle || '',
    tracks: config?.tracks || {},
  };
  html = replaceRegion(html, 'config', `const GRAPH_CONFIG = ${stable(cfg)};`);
  html = replaceRegion(html, 'nodes', `const nodes = ${stable(nodes)};`);
  html = replaceRegion(html, 'edges', `const edges = ${stable(edges)};`);
  return html;
}

function replaceRegion(html, key, body) {
  const [start, end] = REGIONS[key];
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s === -1 || e === -1 || e < s) {
    throw new Error(`roadmap-graph template missing @generated:${key} region`);
  }
  return html.slice(0, s + start.length) + '\n' + body + '\n' + html.slice(e);
}

// Stable JSON serialization with sorted object keys for deterministic output.
function stable(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
