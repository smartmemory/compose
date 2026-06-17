/**
 * test-bootstrap.js — Framework detection and test scaffold generation.
 *
 * Item 125: detectTestFramework(cwd) — inspect config files, package.json devDeps,
 *           and pyproject.toml to identify the active test framework.
 *
 * Item 126: scaffoldTestFramework(cwd, language) — create minimal test scaffolding
 *           when no framework is detected.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function _readText(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Item 125: detectTestFramework
// ---------------------------------------------------------------------------

/**
 * Detect which test framework is configured in the given directory.
 *
 * Checks (in order):
 *   1. Well-known config file names on disk
 *   2. package.json devDependencies / dependencies
 *   3. pyproject.toml [tool.pytest]
 *
 * @param {string} cwd - Directory to inspect
 * @returns {{ framework: string, runner: string, configFile: string|null, command: string }|null}
 */
export function detectTestFramework(cwd) {
  // --- Config-file checks ---

  const configChecks = [
    // Vitest
    {
      files: ['vitest.config.js', 'vitest.config.ts', 'vitest.config.mjs', 'vitest.config.cjs'],
      framework: 'vitest',
      runner: 'vitest',
      command: 'npx vitest run',
    },
    // Jest
    {
      files: [
        'jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs',
        'jest.config.json',
      ],
      framework: 'jest',
      runner: 'jest',
      command: 'npx jest',
    },
    // Mocha
    {
      files: ['.mocharc.js', '.mocharc.cjs', '.mocharc.yaml', '.mocharc.yml', '.mocharc.json'],
      framework: 'mocha',
      runner: 'mocha',
      command: 'npx mocha',
    },
    // pytest — config file forms
    {
      files: ['pytest.ini', 'conftest.py'],
      framework: 'pytest',
      runner: 'pytest',
      command: 'pytest',
    },
    // setup.cfg with [tool:pytest]
    {
      files: ['setup.cfg'],
      framework: 'pytest',
      runner: 'pytest',
      command: 'pytest',
      // validated below — only if [tool:pytest] section present
      contentCheck: (content) => content.includes('[tool:pytest]'),
    },
  ];

  for (const check of configChecks) {
    for (const filename of check.files) {
      const fullPath = join(cwd, filename);
      if (!existsSync(fullPath)) continue;

      if (check.contentCheck) {
        const content = _readText(fullPath);
        if (!content || !check.contentCheck(content)) continue;
      }

      return {
        framework: check.framework,
        runner: check.runner,
        configFile: filename,
        command: check.command,
      };
    }
  }

  // --- Go: *_test.go files ---
  {
    const goMod = join(cwd, 'go.mod');
    if (existsSync(goMod)) {
      return {
        framework: 'go-test',
        runner: 'go',
        configFile: 'go.mod',
        // -v emits per-test "--- PASS:/FAIL:" verdicts so parseTestSummary can
        // count tests (COMP-TEST-BOOTSTRAP-4); plain `go test` prints only a
        // package-level ok/FAIL with no counts.
        command: 'go test -v ./...',
      };
    }
  }

  // --- Rust: Cargo.toml ---
  {
    const cargoToml = join(cwd, 'Cargo.toml');
    if (existsSync(cargoToml)) {
      const content = _readText(cargoToml);
      if (content) {
        return {
          framework: 'cargo-test',
          runner: 'cargo',
          configFile: 'Cargo.toml',
          command: 'cargo test',
        };
      }
    }
  }

  // --- pyproject.toml with [tool.pytest] ---
  {
    const pyproject = join(cwd, 'pyproject.toml');
    const content = _readText(pyproject);
    if (content && content.includes('[tool.pytest')) {
      return {
        framework: 'pytest',
        runner: 'pytest',
        configFile: 'pyproject.toml',
        command: 'pytest',
      };
    }
  }

  // --- package.json devDependencies / dependencies ---
  {
    const pkgPath = join(cwd, 'package.json');
    const pkg = _readJSON(pkgPath);
    if (pkg) {
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };

      // Ordered: prefer vitest > jest > mocha > ava > tap
      if (allDeps['vitest']) {
        return {
          framework: 'vitest',
          runner: 'vitest',
          configFile: 'package.json',
          command: 'npx vitest run',
        };
      }
      if (allDeps['jest'] || allDeps['ts-jest'] || allDeps['babel-jest']) {
        return {
          framework: 'jest',
          runner: 'jest',
          configFile: 'package.json',
          command: 'npx jest',
        };
      }
      if (allDeps['mocha']) {
        return {
          framework: 'mocha',
          runner: 'mocha',
          configFile: 'package.json',
          command: 'npx mocha',
        };
      }
      if (allDeps['ava']) {
        return {
          framework: 'ava',
          runner: 'ava',
          configFile: 'package.json',
          command: 'npx ava',
        };
      }
      if (allDeps['tap']) {
        return {
          framework: 'tap',
          runner: 'tap',
          configFile: 'package.json',
          command: 'npx tap',
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Item 126: scaffoldTestFramework
// ---------------------------------------------------------------------------

/**
 * Create a minimal test scaffold if no framework is detected.
 * Only runs when detectTestFramework(cwd) returns null.
 *
 * @param {string} cwd      - Project root directory
 * @param {string} language - 'node' | 'python' | 'go' | 'rust'
 * @returns {{ framework: string, configFile: string, testDir: string, command: string }}
 */
export function scaffoldTestFramework(cwd, language) {
  const existing = detectTestFramework(cwd);
  if (existing) return existing;

  switch (language) {
    case 'python': {
      const testDir = join(cwd, 'tests');
      mkdirSync(testDir, { recursive: true });

      const conftest = join(cwd, 'conftest.py');
      if (!existsSync(conftest)) {
        writeFileSync(conftest, [
          '# conftest.py — pytest configuration and shared fixtures',
          'import pytest',
          '',
          '# Add project root to sys.path so tests can import the package.',
          'import sys, os',
          'sys.path.insert(0, os.path.dirname(__file__))',
          '',
        ].join('\n'), 'utf-8');
      }

      const initTest = join(testDir, 'test_golden.py');
      if (!existsSync(initTest)) {
        writeFileSync(initTest, [
          '"""Golden flow placeholder — replace with real lifecycle tests."""',
          '',
          'def test_placeholder():',
          '    """Minimal placeholder that passes until real tests are written."""',
          '    assert True',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'pytest',
        configFile: 'conftest.py',
        testDir: 'tests',
        command: 'pytest',
      };
    }

    case 'go': {
      // Find first .go file to derive the package name, defaulting to 'main'
      let packageName = 'main';
      try {
        const goFiles = readdirSync(cwd).filter(
          f => f.endsWith('.go') && !f.endsWith('_test.go')
        );
        if (goFiles.length > 0) {
          const src = _readText(join(cwd, goFiles[0]));
          const m = src?.match(/^package\s+(\w+)/m);
          if (m) packageName = m[1];
        }
      } catch { /* use default */ }

      const testFile = join(cwd, 'golden_test.go');
      if (!existsSync(testFile)) {
        writeFileSync(testFile, [
          `package ${packageName}`,
          '',
          'import "testing"',
          '',
          '// TestGoldenFlow is a placeholder — replace with real lifecycle tests.',
          'func TestGoldenFlow(t *testing.T) {',
          '  // TODO: implement golden flow test',
          '}',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'go-test',
        configFile: 'golden_test.go',
        testDir: '.',
        // -v so parseTestSummary can count per-test verdicts (COMP-TEST-BOOTSTRAP-4).
        command: 'go test -v ./...',
      };
    }

    case 'rust': {
      const testDir = join(cwd, 'tests');
      mkdirSync(testDir, { recursive: true });

      const testFile = join(testDir, 'golden.rs');
      if (!existsSync(testFile)) {
        writeFileSync(testFile, [
          '//! Golden flow placeholder — replace with real lifecycle tests.',
          '',
          '#[test]',
          'fn placeholder() {',
          '    // TODO: implement golden flow test',
          '}',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'cargo-test',
        configFile: 'tests/golden.rs',
        testDir: 'tests',
        command: 'cargo test',
      };
    }

    case 'node':
    default: {
      const testDir = join(cwd, 'test');
      mkdirSync(testDir, { recursive: true });

      // Prefer vitest if package.json exists; otherwise scaffold bare vitest config
      const pkgPath = join(cwd, 'package.json');
      const pkg = _readJSON(pkgPath);
      const useVitest = !pkg?.devDependencies?.jest && !pkg?.dependencies?.jest;

      if (useVitest) {
        const configPath = join(cwd, 'vitest.config.js');
        if (!existsSync(configPath)) {
          writeFileSync(configPath, [
            '// vitest.config.js — generated by Compose test-bootstrap',
            "import { defineConfig } from 'vitest/config';",
            '',
            'export default defineConfig({',
            '  test: {',
            "    include: ['test/**/*.test.{js,ts}'],",
            '  },',
            '});',
            '',
          ].join('\n'), 'utf-8');
        }

        const setupPath = join(testDir, 'setup.js');
        if (!existsSync(setupPath)) {
          writeFileSync(setupPath, [
            '// test/setup.js — shared test helpers',
            "// Import this in tests via: import './setup.js'",
            '',
            '// Example: assert helpers, fixtures, shared state',
            '',
          ].join('\n'), 'utf-8');
        }

        return {
          framework: 'vitest',
          configFile: 'vitest.config.js',
          testDir: 'test',
          command: 'npx vitest run',
        };
      }

      // Jest fallback
      const configPath = join(cwd, 'jest.config.js');
      if (!existsSync(configPath)) {
        writeFileSync(configPath, [
          '// jest.config.js — generated by Compose test-bootstrap',
          "export default { testMatch: ['**/test/**/*.test.js'] };",
          '',
        ].join('\n'), 'utf-8');
      }

      const setupPath = join(testDir, 'setup.js');
      if (!existsSync(setupPath)) {
        writeFileSync(setupPath, [
          '// test/setup.js — shared test helpers',
          '',
        ].join('\n'), 'utf-8');
      }

      return {
        framework: 'jest',
        configFile: 'jest.config.js',
        testDir: 'test',
        command: 'npx jest',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// COMP-TEST-BOOTSTRAP-4: parseTestSummary
// ---------------------------------------------------------------------------

const _UNPARSED = Object.freeze({ test_count: 0, pass_rate: 0, parsed: false });

/** Strip ANSI color/escape codes so regexes match raw text. */
function _stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** First capture group as an int, or null if no match. */
function _int(m) {
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Build a result from pass/fail counts. The denominator is passed+failed only —
 * skipped/pending/ignored tests are excluded from the rate (a fully-skipped run
 * is not "100% passing"; a run with zero verdicts degrades to parsed:false).
 */
function _fromCounts(passed, failed) {
  const total = passed + failed;
  if (total <= 0) return _UNPARSED;
  // Round to 2 decimals; an all-pass run yields exactly 100.
  const pass_rate = Math.round((passed / total) * 10000) / 100;
  return { test_count: total, pass_rate, parsed: true };
}

function _parseVitest(out) {
  // "      Tests  2 failed | 10 passed (12)"  /  "      Tests  12 passed (12)"
  // Match the "Tests" line specifically, not the "Test Files" line.
  const line = out.match(/^[^\S\n]*Tests[^\S\n]+(.+)$/m);
  if (!line) return _UNPARSED;
  const passed = _int(line[1].match(/(\d+)\s+passed/));
  const failed = _int(line[1].match(/(\d+)\s+failed/));
  if (passed === null && failed === null) return _UNPARSED;
  return _fromCounts(passed ?? 0, failed ?? 0);
}

function _parseJest(out) {
  // "Tests:       2 failed, 10 passed, 12 total"
  const line = out.match(/^[^\S\n]*Tests:[^\S\n]+(.+)$/m);
  if (!line) return _UNPARSED;
  const passed = _int(line[1].match(/(\d+)\s+passed/));
  const failed = _int(line[1].match(/(\d+)\s+failed/));
  if (passed === null && failed === null) return _UNPARSED;
  return _fromCounts(passed ?? 0, failed ?? 0);
}

function _parseMocha(out) {
  // "  10 passing (24ms)" + optional "  2 failing"; pending excluded.
  const passed = _int(out.match(/(\d+)\s+passing/));
  const failed = _int(out.match(/(\d+)\s+failing/));
  if (passed === null && failed === null) return _UNPARSED;
  return _fromCounts(passed ?? 0, failed ?? 0);
}

function _parsePytest(out) {
  // "===== 2 failed, 9 passed, 1 error, 1 skipped in 0.50s =====" / "12 passed in 0.34s"
  const passed = _int(out.match(/(\d+)\s+passed/));
  const failed = _int(out.match(/(\d+)\s+failed/));
  const errors = _int(out.match(/(\d+)\s+error/)); // "error"/"errors"
  if (passed === null && failed === null && errors === null) return _UNPARSED;
  return _fromCounts(passed ?? 0, (failed ?? 0) + (errors ?? 0));
}

function _parseGoTest(out) {
  // Requires verbose output (`go test -v`): per-test "--- PASS:" / "--- FAIL:" lines.
  // Without -v there are no per-test verdicts to count → degrade.
  const passed = (out.match(/^[^\S\n]*--- PASS:/gm) || []).length;
  const failed = (out.match(/^[^\S\n]*--- FAIL:/gm) || []).length;
  if (passed + failed === 0) return _UNPARSED;
  return _fromCounts(passed, failed);
}

function _parseCargo(out) {
  // Sum every "test result: <ok|FAILED>. N passed; M failed; ..." line
  // (a crate emits one per unit/integration/doc target).
  const re = /test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/g;
  let passed = 0, failed = 0, found = false, m;
  while ((m = re.exec(out)) !== null) {
    passed += parseInt(m[1], 10);
    failed += parseInt(m[2], 10);
    found = true;
  }
  if (!found) return _UNPARSED;
  return _fromCounts(passed, failed);
}

/**
 * Extract a structured test-result summary from raw test-runner stdout.
 *
 * Pure and total: any framework it can't read — or output it can't recognize —
 * degrades to `{ test_count: 0, pass_rate: 0, parsed: false }` rather than
 * guessing. Callers MUST treat `parsed:false` as "no signal" and never as a
 * failing gate (see lib/build.js ship path).
 *
 * @param {string|null} framework - value from detectTestFramework().framework
 *   (vitest | jest | mocha | pytest | go-test | cargo-test; others degrade)
 * @param {string|null} stdout - combined stdout+stderr of the test run
 * @returns {{ test_count: number, pass_rate: number, parsed: boolean }}
 */
export function parseTestSummary(framework, stdout) {
  if (!framework || typeof stdout !== 'string' || stdout.length === 0) return _UNPARSED;
  const out = _stripAnsi(stdout);
  switch (framework) {
    case 'vitest': return _parseVitest(out);
    case 'jest': return _parseJest(out);
    case 'mocha': return _parseMocha(out);
    case 'pytest': return _parsePytest(out);
    case 'go-test': return _parseGoTest(out);
    case 'cargo-test': return _parseCargo(out);
    default: return _UNPARSED; // ava, tap, unknown
  }
}

/**
 * The ship gate: derive a `tests_pass` boolean from a parsed summary.
 *
 * - parsed:  pass only when at least one test ran AND every test passed.
 * - unparsed (or absent): degrade to `true` — an unreadable summary is "no
 *   signal", never a failing gate. This is the safety valve that keeps the
 *   gate from misfiring on frameworks/output the parser can't read.
 *
 * @param {{ test_count: number, pass_rate: number, parsed: boolean }|null} summary
 * @returns {boolean}
 */
export function deriveTestsPass(summary) {
  if (!summary || !summary.parsed) return true;
  return summary.test_count >= 1 && summary.pass_rate === 100;
}
