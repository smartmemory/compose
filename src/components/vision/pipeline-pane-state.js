/**
 * pipeline-pane-state.js — COMP-PIPE-EDIT-CHAT-PANE-1. Pure rules for the Flow editor's
 * right pane: which pane shows, when a selection hands over to the inspector, and when a
 * chat proposal may be applied. No React, no store, so both sides test it directly.
 *
 * pane:  'auto' | 'chat' | 'contracts' | 'yaml'
 * shown: 'inspector' | 'chat' | 'contracts' | 'yaml'   (what resolvePane returns)
 */
import YAML from 'yaml';
import { modelToYamlObject } from '../../lib/pipeline-model.js';

/** Mirrors server/pipeline-chat-prompt.js MAX_INPUT_TOKENS; the client refuses first (the global body parser is 100kb). */
export const MAX_CHAT_INPUT_TOKENS = 40_000;
/** Prompt text the server adds around the spec and history, so the client estimate is not optimistic. */
const PROMPT_OVERHEAD_TOKENS = 1_500;

export const STALE_MESSAGE = 'Spec changed, ask again';

/** `auto` follows the selection: a step → inspector, none → chat. The rest pin their pane. */
export function resolvePane(pane, selectedStep) {
  if (pane === 'chat' || pane === 'contracts' || pane === 'yaml') return pane;
  return selectedStep != null ? 'inspector' : 'chat';
}

/** Selecting a (different) step hands the pane to the inspector, even from contracts or YAML. */
export function paneOnSelect(pane, prevStep, nextStep) {
  return nextStep != null && nextStep !== prevStep ? 'auto' : pane;
}

/** A toolbar toggle: pressing the active pane's button returns to `auto`. */
export function paneToggle(pane, target) {
  return pane === target ? 'auto' : target;
}

/** The YAML pane's own projection (YamlPane.jsx serializeModel), so chat sees what the user sees. */
export function serializeSpec(model) {
  if (!model) return '';
  try { return YAML.stringify(modelToYamlObject(model)); } catch { return ''; }
}

/** sha-256 hex where WebCrypto exists, else a 53-bit string hash (equality checks only, never security). */
export async function hashText(text) {
  const s = String(text ?? '');
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof TextEncoder !== 'undefined') {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `f${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}`;
}

/** Tokens a turn would send, by the same four-characters-a-token rule as the server. */
export function estimateChatTokens(yaml, message) {
  return Math.ceil((String(yaml ?? '').length + String(message ?? '').length) / 4) + PROMPT_OVERHEAD_TOKENS;
}

/**
 * Why Apply is off, or null when it may run. Order is the order a user can act on:
 * read-only, a bad proposal, a pending YAML pane buffer, then a stale base.
 */
export function applyBlockReason({ proposal, currentHash, readOnly, bufferPending }) {
  if (!proposal) return 'No proposal';
  if (readOnly) return 'This spec is read-only';
  if (!proposal.valid) return proposal.error || 'The proposal is not valid';
  if (bufferPending) return 'Resolve the YAML pane first';
  if (currentHash == null || currentHash !== proposal.baseHash) return STALE_MESSAGE;
  return null;
}
