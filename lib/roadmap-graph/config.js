/**
 * config.js — read `.compose/compose.json#roadmap_graph` display config for the
 * roadmap dependency graph generator (COMP-ROADMAP-GRAPH-1).
 *
 * All fields optional. Defaults keep the generator usable with zero config.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

// Default track -> accent color map. Projects override via
// compose.json#roadmap_graph.tracks. 'standalone' is the fallback track.
export const DEFAULT_TRACKS = {
  knowledge: '#0ea5e9',
  distribution: '#10b981',
  governance: '#a855f7',
  agent: '#f59e0b',
  worker: '#ef4444',
  platform: '#ec4899',
  developer: '#f97316',
  async: '#6b7280',
  standalone: '#64748b',
};

export const DEFAULT_OUT = 'roadmap-graph.html';

/**
 * Resolve graph display config for a project root.
 * @param {string} cwd
 * @returns {{ title: string, subtitle: string, tracks: Record<string,string>, out: string }}
 */
export function loadGraphConfig(cwd) {
  let raw = {};
  const cfgPath = join(cwd, '.compose', 'compose.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      raw = (cfg && typeof cfg.roadmap_graph === 'object' && cfg.roadmap_graph) || {};
    } catch { /* fall through to defaults */ }
  }
  const projectName = deriveProjectName(cwd, cfgPath);
  return {
    title: typeof raw.title === 'string' && raw.title ? raw.title : `${projectName} — Roadmap Dependency Graph`,
    subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : '',
    tracks: { ...DEFAULT_TRACKS, ...(raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : {}) },
    out: typeof raw.out === 'string' && raw.out ? raw.out : DEFAULT_OUT,
  };
}

function deriveProjectName(cwd, cfgPath) {
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (typeof cfg.workspaceId === 'string' && cfg.workspaceId) return cfg.workspaceId;
    } catch { /* ignore */ }
  }
  return basename(cwd) || 'Project';
}
