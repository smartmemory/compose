/**
 * inject-schema.js — Append a JSON-Schema instruction block to an agent prompt
 * so the response includes a structured JSON code-block at the end.
 */

/**
 * @param {string} prompt
 * @param {object} schema  JSON Schema object
 * @returns {string}
 */
export function injectSchema(prompt, schema) {
  return (
    `${prompt}\n\n` +
    `IMPORTANT: After completing the task, include a JSON code block at the very end ` +
    `of your response matching this schema:\n` +
    '```json\n' +
    `${JSON.stringify(schema, null, 2)}\n` +
    '```\n' +
    `The JSON block must be the last thing in your response.`
  );
}
