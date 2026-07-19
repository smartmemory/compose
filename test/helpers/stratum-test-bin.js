import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const TS_MCP_BIN = resolveTestBin('mcp');
export const TS_CLI_BIN = resolveTestBin('cli');
