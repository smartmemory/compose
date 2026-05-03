/**
 * post-commit-hook-parser.test.js
 *
 * Tests the qualifier-parsing section of post-commit.template.
 * A small bash harness mirrors the parsing block so we can test it
 * without a real git repo or COMPOSE_NODE/COMPOSE_BIN.
 *
 * Covers Finding 1 from Round-1 Codex review:
 *   - notes value containing "tests_pass=false" must NOT flip tp
 *   - unknown qualifier emits a warning to the log file
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Harness script
// Mirrors the parsing block in post-commit.template exactly.
// Usage: bash harness.sh '<trailer-value>' '<logfile>'
// Outputs: tests_pass=<val>\nnotes=<val>
// ---------------------------------------------------------------------------

const HARNESS_BODY = [
  '#!/usr/bin/env bash',
  'set -u',
  'value="$1"',
  'logfile="$2"',
  'subject="default-subject"',
  '',
  'code=$(echo "$value" | awk \'{print $1}\')',
  'rest=$(echo "$value" | awk \'{$1=""; sub(/^ /, ""); print}\')',
  '',
  'tp="true"',
  'notes="$subject"',
  '',
  // Extract notes="..." first, then strip from rest
  'if [[ "$rest" =~ notes=\\"([^\\"]*)\\" ]]; then',
  '  notes="${BASH_REMATCH[1]}"',
  '  rest="${rest/notes=\\"${BASH_REMATCH[1]}\\"/}"',
  'fi',
  '',
  // Tokenize remaining rest
  'for token in $rest; do',
  '  key="${token%%=*}"',
  '  val="${token#*=}"',
  '  case "$key" in',
  '    tests_pass)',
  '      if [[ "$val" == "true" ]];  then tp="true";  fi',
  '      if [[ "$val" == "false" ]]; then tp="false"; fi',
  '      ;;',
  '    "")',
  '      ;;',
  '    *)',
  '      echo "[$(date -Iseconds)] hook: unknown qualifier \\"$token\\" for $code" | tee -a "$logfile" >&2',
  '      ;;',
  '  esac',
  'done',
  '',
  'echo "tests_pass=$tp"',
  'echo "notes=$notes"',
].join('\n');

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'hook-parser-'));
  const script = join(dir, 'parse.sh');
  writeFileSync(script, HARNESS_BODY, { mode: 0o755 });
  return { dir, script };
}

/**
 * Run the harness with the given trailer value.
 * Returns { tests_pass, notes, log } where log is the log file content (may be empty).
 */
function runParser(script, trailerValue) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-run-'));
  const logFile = join(dir, 'hook.log');
  // Write an empty log so tee has a target even if no warnings fire
  writeFileSync(logFile, '');

  const result = spawnSync('bash', [script, trailerValue, logFile], {
    encoding: 'utf8',
  });

  const pairs = {};
  for (const line of (result.stdout || '').trim().split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    pairs[line.slice(0, eq)] = line.slice(eq + 1);
  }

  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  return { ...pairs, log };
}

// ---------------------------------------------------------------------------

describe('post-commit hook — qualifier parser', () => {
  test('regression: notes value containing "tests_pass=false" does NOT flip tp to false', () => {
    const { script } = makeHarness();
    // Trailer: CODE-1 notes="follow-up: tests_pass=false"
    const result = runParser(script, 'CODE-1 notes="follow-up: tests_pass=false"');
    assert.equal(
      result.tests_pass,
      'true',
      'tp must remain true (default) — tests_pass=false inside notes must not escape and flip the flag'
    );
    assert.equal(
      result.notes,
      'follow-up: tests_pass=false',
      'notes value must be preserved verbatim including the embedded qualifier-like text'
    );
  });

  test('unknown qualifier emits warning to log and tests_pass still parsed', () => {
    const { script } = makeHarness();
    // Trailer: CODE-1 something_else=foo tests_pass=false
    const result = runParser(script, 'CODE-1 something_else=foo tests_pass=false');
    assert.equal(result.tests_pass, 'false', 'tests_pass=false must be parsed alongside unknown qualifiers');
    assert.ok(
      result.log.includes('unknown qualifier') && result.log.includes('something_else=foo'),
      `log must contain warning about unknown qualifier. Got: ${JSON.stringify(result.log)}`
    );
  });

  test('no qualifiers: tp defaults to true', () => {
    const { script } = makeHarness();
    const result = runParser(script, 'CODE-1');
    assert.equal(result.tests_pass, 'true');
  });

  test('explicit tests_pass=true sets tp to true', () => {
    const { script } = makeHarness();
    const result = runParser(script, 'CODE-1 tests_pass=true');
    assert.equal(result.tests_pass, 'true');
  });

  test('explicit tests_pass=false sets tp to false', () => {
    const { script } = makeHarness();
    const result = runParser(script, 'CODE-1 tests_pass=false');
    assert.equal(result.tests_pass, 'false');
  });
});
