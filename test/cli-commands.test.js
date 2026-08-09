/**
 * cli-commands.test.js — COMP-AUDIT-13.
 *
 * The single command table (lib/cli-commands.js) must stay in lockstep with the
 * real dispatch in bin/compose.js, and both --help and docs/cli.md must surface
 * every command. These tests are the drift guard that keeps installed capability
 * from going invisible again.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMMANDS, COMMAND_GROUPS, allCommandTokens, renderHelp, renderCommandIndex,
} from '../lib/cli-commands.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse the real top-level command tokens from bin/compose.js dispatch. */
function dispatchTokens() {
  const src = readFileSync(join(REPO_ROOT, 'bin', 'compose.js'), 'utf-8');
  const tokens = new Set();
  for (const line of src.split('\n')) {
    // Top-level dispatch branches only: `if (cmd === ...` / `} else if (cmd === ...`.
    if (!/^(?:if|\} else if) \(cmd === /.test(line)) continue;
    for (const m of line.matchAll(/cmd === '([^']+)'/g)) tokens.add(m[1]);
  }
  return tokens;
}

describe('COMP-AUDIT-13 — command table drift guard', () => {
  test('every real dispatch token is in the command table', () => {
    const dispatched = dispatchTokens();
    const known = new Set(allCommandTokens());
    const missing = [...dispatched].filter((t) => !known.has(t));
    assert.deepEqual(
      missing, [],
      `bin/compose.js dispatches these commands with no row in lib/cli-commands.js: ${missing.join(', ')}`,
    );
  });

  test('every command table token is a real dispatch branch', () => {
    const dispatched = dispatchTokens();
    const orphan = allCommandTokens().filter((t) => !dispatched.has(t));
    assert.deepEqual(
      orphan, [],
      `lib/cli-commands.js lists commands that bin/compose.js never dispatches: ${orphan.join(', ')}`,
    );
  });

  test('command tokens are unique across the table', () => {
    const all = allCommandTokens();
    assert.equal(all.length, new Set(all).size, 'duplicate command token in COMMANDS');
  });

  test('every command belongs to a declared group', () => {
    for (const c of COMMANDS) {
      assert.ok(COMMAND_GROUPS.includes(c.group), `${c.name} has unknown group "${c.group}"`);
    }
  });
});

describe('COMP-AUDIT-13 — help and docs completeness', () => {
  test('--help renderer names every command', () => {
    const help = renderHelp();
    for (const c of COMMANDS) {
      assert.ok(help.includes(c.name), `compose --help omits "${c.name}"`);
    }
  });

  test('docs/cli.md documents every command', () => {
    const cli = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf-8');
    for (const c of COMMANDS) {
      assert.ok(cli.includes(`\`compose ${c.name}\``), `docs/cli.md omits "compose ${c.name}"`);
    }
  });

  test('docs/cli.md embeds the current generated Command Index', () => {
    const cli = readFileSync(join(REPO_ROOT, 'docs', 'cli.md'), 'utf-8');
    assert.ok(
      cli.includes(renderCommandIndex()),
      'docs/cli.md Command Index is stale — regenerate it from lib/cli-commands.js renderCommandIndex()',
    );
  });
});
