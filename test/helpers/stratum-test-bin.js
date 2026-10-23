import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// CI-portable resolution of the stratum test bins. Precedence:
//   1. env override (COMPOSE_STRATUM_TS_{MCP,CLI}_BIN)
//   2. adjacent stratum source checkout — the monorepo co-dev case, so local test
//      runs exercise the stratum source you are editing
//   3. installed @smartmemory/stratum package — CI, where there is no sibling; the
//      pinned published dep's compiled bins
// Replaces the absolute hardcoded `/Users/.../stratum/ts/src/*/bin.mjs` consts that
// only existed on one machine and broke the suite in CI.
function resolveTestBin(kind) {
  const envVar = kind === 'mcp' ? 'COMPOSE_STRATUM_TS_MCP_BIN' : 'COMPOSE_STRATUM_TS_CLI_BIN';
  const override = process.env[envVar];
  if (override && existsSync(override)) return override;

  const srcRel = kind === 'mcp' ? 'mcp/bin.mjs' : 'cli/bin.mjs';
  const sibling = resolve(here, '..', '..', '..', 'stratum', 'ts', 'src', srcRel);
  if (existsSync(sibling)) return sibling;

  const distSpecifier = kind === 'mcp'
    ? '@smartmemory/stratum/dist/mcp/main.js'
    : '@smartmemory/stratum/dist/cli/stratum.js';
  try {
    return require.resolve(distSpecifier);
  } catch {
    throw new Error(
      `Cannot resolve the stratum ${kind} bin: no adjacent stratum checkout and `
        + '@smartmemory/stratum is not installed. Install it or place a stratum sibling.',
    );
  }
}

// Import a compiled stratum module (`ir/validate.js`, `connectors/codex.js`, ...) without a
// fixed `../../../stratum` hop. That hop only lands on the sibling checkout when compose sits
// directly under forge/; from a git worktree (`.worktrees/<name>`) it points at
// `.worktrees/stratum` and the import dies with ERR_MODULE_NOT_FOUND (measured 2026-10-24,
// build-wave-golden d3 paid-carry cases). `@smartmemory/stratum` resolves through node_modules
// from wherever compose is checked out, so this works in a worktree, the checkout and CI.
export function importStratumDist(rel) {
  return import(pathToFileURL(require.resolve(`@smartmemory/stratum/dist/${rel}`)).href);
}

export const TS_MCP_BIN = resolveTestBin('mcp');
export const TS_CLI_BIN = resolveTestBin('cli');
