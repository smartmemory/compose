/**
 * maya-config.js — COMP-FOH FOH-6 S1
 *
 * Config readers for the Maya colleague coupling. Leaf module (no fetch, no
 * state writes), mirroring lib/smartmemory-config.js: uncached direct reads of
 * `.compose/compose.json`, try/catch → absent on missing/malformed.
 *
 * The feature switch is the PRESENCE of the `maya` block (design-foh-6.md
 * §Config): absent means "not installed" (no chrome button), which is a
 * different state from "installed but degraded" (a funnel).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readComposeJson(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, '.compose', 'compose.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * The `maya` block, or null when the feature is not installed.
 * @param {string} cwd
 * @returns {{ baseUrl?: string, auth?: { mode?: 'provision'|'static' } } | null}
 */
export function getMayaConfig(cwd) {
  const block = readComposeJson(cwd).maya;
  return block && typeof block === 'object' ? block : null;
}

/**
 * The fluid SmartMemory workspace id — the value the colleague identity's
 * workspace claim must NOT equal (shallow-binding isolation, design §2).
 * @param {string} cwd
 * @returns {string | null}
 */
export function getFluidWorkspaceId(cwd) {
  const ws = readComposeJson(cwd).fluid?.smartmemory?.workspaceId;
  return typeof ws === 'string' && ws ? ws : null;
}

/**
 * Whether the fluid provider is SmartMemory-backed. The colleague never runs
 * degraded (COLLEAGUE-ALL-IN): on the local floor the panel is a
 * connect-SmartMemory funnel, not a plain chat.
 * @param {string} cwd
 */
export function hasSmartmemoryFluidProvider(cwd) {
  return readComposeJson(cwd).fluid?.provider === 'smartmemory';
}
