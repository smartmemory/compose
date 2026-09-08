/**
 * Parse markdown text containing ```decision fenced blocks.
 * Returns { parts: Array<{ type: 'text'|'decision', content: string|object }> }.
 *
 * This module is shared by the shipped server and the browser source. Keep it
 * under lib/ so npm installs do not need the otherwise development-only src/.
 */
export function parseDecisionBlocks(text) {
  const parts = [];
  const regex = /```decision\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }

    const raw = match[1].trim();
    try {
      parts.push({ type: 'decision', content: JSON.parse(raw) });
    } catch {
      parts.push({ type: 'text', content: raw });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', content: text });
  }

  return { parts };
}
