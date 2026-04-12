/**
 * cross-layer-audit.js — Cross-layer scope detection for COMP-DEBUG-1.
 *
 * Detects when a bug fix spans multiple repos/layers and should trigger
 * a grep audit before the fix step proceeds.
 *
 * See: docs/features/COMP-DEBUG-1/design.md
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_EXTENSIONS = ['*.py', '*.json', '*.ts', '*.tsx', '*.jsx', '*.yaml'];

const CROSS_LAYER_KEYWORDS = [
  /openai/i, /groq/i, /anthropic/i, /gpt-4/i, /llama/i,
  /config\.json/i, /\.env\b/i, /VITE_/,
  /\brenamed?\b/i, /was previously/i, /changed from/i,
  /\bcaddy\b/i, /\bproxy\b/i, /\bnginx\b/i, /\broute\b/i,
];

/**
 * Load debug discipline config from .compose/compose.json.
 * Returns defaults if no config exists.
 */
export function loadDebugConfig(cwd) {
  const configPath = join(cwd, '.compose', 'compose.json');
  const defaults = { cross_layer_repos: [], cross_layer_extensions: DEFAULT_EXTENSIONS };
  try {
    if (!existsSync(configPath)) return defaults;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const dd = config.debug_discipline ?? {};
    return {
      cross_layer_repos: dd.cross_layer_repos ?? defaults.cross_layer_repos,
      cross_layer_extensions: dd.cross_layer_extensions ?? defaults.cross_layer_extensions,
    };
  } catch {
    return defaults;
  }
}

/**
 * Detects whether a diagnose result indicates cross-layer changes
 * that need a scope expansion audit.
 */
export class CrossLayerAudit {
  constructor(config) {
    this.repos = config.cross_layer_repos ?? [];
    this.extensions = config.cross_layer_extensions ?? DEFAULT_EXTENSIONS;
  }

  /**
   * Check if the diagnose result warrants scope expansion.
   * @param {object} diagnoseResult - output from diagnose step
   * @returns {{ expand: boolean, trigger: string|null }}
   */
  shouldExpand(diagnoseResult) {
    const hint = diagnoseResult?.scope_hint;

    // Structured detection (primary)
    if (hint === 'cross-layer') {
      return { expand: true, trigger: 'scope_hint' };
    }
    if (hint === 'single') {
      return { expand: false, trigger: null };
    }

    // Keyword fallback (when hint is 'unknown' or absent)
    const text = [
      diagnoseResult?.root_cause ?? '',
      diagnoseResult?.summary ?? '',
      ...(diagnoseResult?.affected_layers ?? []),
    ].join(' ');

    for (const kw of CROSS_LAYER_KEYWORDS) {
      const match = text.match(kw);
      if (match) {
        return { expand: true, trigger: `keyword:${match[0]}` };
      }
    }

    return { expand: false, trigger: null };
  }
}
