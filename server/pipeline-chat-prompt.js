/**
 * pipeline-chat-prompt.js — COMP-PIPE-EDIT-CHAT-PANE-1. Pure helpers for the Flow
 * editor's spec chat: prompt builder, input-size cap, fenced-yaml extraction.
 * No I/O, so the route test and the UI can both lean on the same rules.
 */
import { createHash } from 'node:crypto';

/** The most input one turn may carry (design §5: worst case ≈ $0.25 per message). */
export const MAX_INPUT_TOKENS = 40_000;
/** Turns of history replayed in the prompt (text only). */
export const HISTORY_TURNS = 12;
/** Rough token estimate. Four characters a token over-counts YAML slightly, which is the safe side. */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / 4);

export const hashText = (text) => createHash('sha256').update(String(text ?? '')).digest('hex');

const SYSTEM = `You are the spec assistant inside Compose's Flow editor. The user is editing one Stratum pipeline spec (YAML). You have NO tools: you cannot read files or run anything. Everything you know about the spec is in this message.

Rules:
- Answer in short plain text first.
- To propose an edit, include exactly ONE fenced \`\`\`yaml block holding the COMPLETE proposed spec (never a fragment or a diff). The editor shows it as a diff and the user decides whether to apply it. Nothing is written until they apply and save.
- Keep the spec's existing version, contracts and step ids unless the user asks to change them. Shipped specs are \`version: 1\` and order steps with \`after:\`.
- If the validation errors listed below are relevant, fix them in the proposal.
- If no edit is needed, do not include a yaml block.`;

const cut = (text, n) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One-line stand-in for a past proposal so history never carries full YAML. */
export function summarizeProposal(reply) {
  const prose = String(reply ?? '').replace(/```[\s\S]*?```/g, '').trim();
  return `proposed: ${cut(prose, 140) || 'a spec edit'}`;
}

/**
 * @param {{yaml:string, message:string, selectedFlow?:string|null, selectedStep?:string|null,
 *   errors?:string[], history?:{role:string,text:string,proposed?:string}[]}} args
 */
export function buildPrompt({ yaml, message, selectedFlow, selectedStep, errors, history }) {
  const turns = (history || []).slice(-HISTORY_TURNS).map((m) => {
    const body = m.role === 'assistant' && m.proposed ? `${cut(m.text, 600)}\n[${m.proposed}]` : cut(m.text, 1200);
    return `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${body}`;
  });
  const errs = Array.isArray(errors) ? errors.filter(Boolean).slice(0, 20) : [];
  return [
    SYSTEM,
    '',
    `Selected flow: ${selectedFlow || '(none)'}`,
    `Selected step: ${selectedStep || '(none)'}`,
    `Validation errors (${errs.length}):${errs.length ? `\n${errs.map((e) => `- ${cut(e, 300)}`).join('\n')}` : ' none'}`,
    '',
    'Current spec (in-memory, unsaved edits included):',
    '```yaml',
    String(yaml ?? '').trimEnd(),
    '```',
    '',
    turns.length ? `Conversation so far:\n${turns.join('\n')}\n` : '',
    `User: ${String(message ?? '').trim()}`,
  ].join('\n');
}

/** `{ok:true, tokens}` or `{ok:false, tokens, cap}` — checked before any dispatch. */
export function checkInputSize(prompt) {
  const tokens = estimateTokens(prompt);
  return tokens > MAX_INPUT_TOKENS ? { ok: false, tokens, cap: MAX_INPUT_TOKENS } : { ok: true, tokens };
}

/**
 * Pull the proposal out of a reply. Only the first fenced yaml block counts.
 * @returns {{text:string, yaml:string|null}} text is the reply with that block removed.
 */
export function extractProposal(reply) {
  const src = String(reply ?? '');
  const m = /```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)```/i.exec(src);
  if (!m) return { text: src.trim(), yaml: null };
  const text = (src.slice(0, m.index) + src.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  return { text, yaml: m[1].replace(/\s+$/, '') + '\n' };
}
