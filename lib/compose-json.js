/**
 * compose-json.js — the one strict read of `.compose/compose.json` for gates.
 *
 * COMP-SETUP-PREFLIGHT-1 fix round 1 (P-2). A gate that reads this file has two
 * honest answers: the file is absent (the project opted into nothing), or the file
 * says something. A file that exists but cannot be parsed is neither: reading it as
 * "absent" turned off the run lock, every project check, the flow gate and the
 * completion guard on a trailing comma, with every line looking normal. So an
 * unreadable file throws, naming the file and the parse error, and each gate turns
 * that into its own loud refusal.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class ComposeConfigUnreadable extends Error {
  constructor(file, cause) {
    super(`${file} is not valid JSON: ${cause?.message ?? cause}`);
    this.name = 'ComposeConfigUnreadable';
    this.code = 'COMPOSE_CONFIG_UNREADABLE';
    this.file = file;
  }
}

/**
 * @param {string} root  project root (the directory holding `.compose/`)
 * @returns {object|null}  the parsed config, or null only when the file does not exist
 * @throws {ComposeConfigUnreadable}  when the file exists but cannot be read or parsed
 */
export function readComposeJson(root) {
  const file = join(root, '.compose', 'compose.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new ComposeConfigUnreadable(file, err);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ComposeConfigUnreadable(file, err);
  }
}
