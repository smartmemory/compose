import { existsSync, readFileSync, writeFileSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { execFileSync as _execFileSyncDefault } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Development/monorepo fallback when @smartmemory/stratum is not installed.
export const LIVE_STRATUM_TS_MCP_BIN = resolve(
  __dirname, '..', '..', 'stratum', 'ts', 'src', 'mcp', 'bin.mjs',
);

// The flow/gate SEAM uses the TS `query`/`gate` CLI (not the MCP bin).
export const LIVE_STRATUM_TS_CLI_BIN = resolve(
  __dirname, '..', '..', 'stratum', 'ts', 'src', 'cli', 'bin.mjs',
);

// D1: a valid-format run id (matches the engine's `/^[a-zA-Z0-9-]+$/`) that no
// store will ever hold, so `query flow <SENTINEL>` deterministically returns the
// stratum NOT_FOUND projection — a POSITIVE identity check that does not depend on
// store data (an empty `query flows` array from a fresh store is legitimate and
// indistinguishable from an adversarial `[]`).
const PROBE_SENTINEL_RUN_ID = 'stratum-probe-nonexistent-run-0';

/**
 * D1/C1: POSITIVELY identify a flow/gate binary as one that speaks the stratum
 * query contract, before the adapter trusts it. Existence/executability alone is
 * not enough (a bare `stratum` on $PATH can exist yet answer with "Unknown
 * command" and exit 0), and a shape-agnostic "returns an array" check is spoofed
 * by an adversarial stub emitting `[]` or `[{...}]` — AND a fresh store legitimately
 * returns `[]`. So the probe queries a nonexistent-but-valid run id: a compatible
 * binary echoes it back in the exact NOT_FOUND projection
 * (`{error:{code:"NOT_FOUND", message:"Flow '<id>' not found"}}`). Returns
 * { ok, reason? }; never throws.
 *
 * @param {string} bin
 * @param {{ execFileSync?: Function }} [deps]  test seam
 */
export function probeStratumBin(bin, deps = {}) {
  const execFileSync = deps.execFileSync ?? _execFileSyncDefault;
  // Existence / executability. A configured path must be an executable regular
  // file; a bare command is looked up on $PATH via the query call itself.
  if (typeof bin === 'string' && bin.includes('/')) {
    try {
      if (!statSync(bin).isFile()) return { ok: false, reason: `${bin} is not a regular file` };
      accessSync(bin, fsConstants.X_OK);
    } catch {
      return { ok: false, reason: `${bin} is not an executable file` };
    }
  }
  // The NOT_FOUND projection is written to STDOUT but the CLI exits NON-ZERO for
  // it, so capture stdout whether the call returns (exit 0) or throws (exit != 0).
  let out;
  try {
    out = execFileSync(bin, ['query', 'flow', PROBE_SENTINEL_RUN_ID], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // E3: a TIMEOUT or SIGNAL-terminated run must NEVER be treated as a legitimate
    // non-zero exit — a hung binary can flush partial/garbage stdout that happens to
    // parse. Detect termination BEFORE trusting any captured stdout.
    if (err && (err.killed === true || err.signal != null || err.code === 'ETIMEDOUT')) {
      return { ok: false, reason: `\`${bin} query flow\` timed out or was terminated (${err.signal ?? err.code ?? 'killed'})` };
    }
    const captured = err?.stdout;
    if (typeof captured === 'string' && captured.length > 0) {
      out = captured;
    } else if (captured && typeof captured.toString === 'function' && captured.length) {
      out = captured.toString('utf8');
    } else {
      return { ok: false, reason: `\`${bin} query flow\` failed to run: ${err?.message ?? err}` };
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return {
      ok: false,
      reason: `${bin} does not speak the stratum query contract `
        + `(\`query flow\` returned non-JSON: ${String(out).trim().slice(0, 80)})`,
    };
  }
  // E2: EXACT structural + literal match — not a substring. A JSON argument-parrot
  // that echoes the sentinel anywhere inside a NOT_FOUND envelope must NOT pass. The
  // message must equal the exact projection format the TS CLI emits.
  const code = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed.error?.code : undefined;
  const message = parsed && typeof parsed === 'object' ? parsed.error?.message : undefined;
  const expectedMessage = `Flow '${PROBE_SENTINEL_RUN_ID}' not found`;
  if (code !== 'NOT_FOUND' || message !== expectedMessage) {
    return {
      ok: false,
      reason: `${bin} does not speak the stratum query contract `
        + `(\`query flow <sentinel>\` did not return the exact NOT_FOUND projection; got: ${String(out).trim().slice(0, 120)})`,
    };
  }
  return { ok: true };
}

function configuredEngine(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  const configPath = join(cwd, '.compose', 'compose.json');
  if (!existsSync(configPath)) return undefined;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'))?.capabilities?.stratumEngine;
  } catch {
    return undefined;
  }
}

const PYTHON_LEGACY_ERROR =
  'The Python Stratum engine has been deleted. Use the python-legacy branch for the archived Python runtime.';

/** Resolve env -> project capability -> TS-only runtime. */
export function resolveStratumEngine(cwd = process.cwd()) {
  let value = process.env.COMPOSE_STRATUM_ENGINE;
  if (value === undefined || value === '') value = configuredEngine(cwd);
  if (value === undefined || value === '') return 'ts';
  if (value === 'python') throw new Error(PYTHON_LEGACY_ERROR);
  if (value !== 'ts') throw new Error(`stratumEngine must be "ts", got ${JSON.stringify(value)}`);
  return 'ts';
}

const BIN_CONFIG = {
  mcp: {
    env: 'COMPOSE_STRATUM_TS_MCP_BIN',
    packageBin: 'stratum-mcp',
    sibling: LIVE_STRATUM_TS_MCP_BIN,
  },
  cli: {
    env: 'COMPOSE_STRATUM_TS_CLI_BIN',
    packageBin: 'stratum',
    sibling: LIVE_STRATUM_TS_CLI_BIN,
  },
};

/** Resolve a bin from an installed @smartmemory/stratum package, if present. */
function resolveInstalledBin(packageBin, requireResolve) {
  let packageJsonPath;
  try {
    // The dependency line is intentionally added only when Stratum is published.
    packageJsonPath = requireResolve('@smartmemory/stratum/package.json');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      return undefined;
    }
    throw error;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const relativeBin = typeof packageJson.bin === 'object'
      ? packageJson.bin?.[packageBin]
      : undefined;
    if (typeof relativeBin !== 'string') return undefined;
    return resolve(dirname(packageJsonPath), relativeBin);
  } catch {
    return undefined;
  }
}

/**
 * Resolve env -> installed dependency -> sibling checkout, checking every
 * candidate before returning it.
 *
 * @param {'mcp'|'cli'} kind
 * @param {string} [cwd]
 * @param {{env?: object, requireResolve?: Function, siblingBins?: object}} [deps]
 */
export function resolveStratumBin(kind, cwd = process.cwd(), deps = {}) {
  const config = BIN_CONFIG[kind];
  if (!config) throw new Error(`Unknown Stratum bin kind: ${JSON.stringify(kind)}`);

  const env = deps.env ?? process.env;
  const envCandidate = env[config.env]
    // Backwards compatibility for the pre-chain flow/gate override.
    || (kind === 'cli' ? env.COMPOSE_STRATUM_TS_BIN : undefined);
  if (envCandidate && existsSync(envCandidate)) return envCandidate;

  const installedCandidate = resolveInstalledBin(
    config.packageBin,
    deps.requireResolve ?? require.resolve.bind(require),
  );
  if (installedCandidate && existsSync(installedCandidate)) return installedCandidate;

  const siblingCandidate = deps.siblingBins?.[kind] ?? config.sibling;
  if (siblingCandidate && existsSync(siblingCandidate)) return siblingCandidate;

  throw new Error(
    `Unable to resolve the Stratum ${kind} binary for ${cwd}. `
      + 'Install @smartmemory/stratum or place a stratum checkout as a sibling of compose.',
  );
}

/** Resolve the selected engine to StratumMcpClient.connect() options. */
export function resolveStratumMcpConnection(cwd, deps = {}) {
  resolveStratumEngine(cwd);
  return {
    command: (deps.env ?? process.env).COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [resolveStratumBin('mcp', cwd, deps)],
    ...(cwd ? { cwd } : {}),
  };
}

function readStratumMcpEntry(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))?.mcpServers?.stratum;
  } catch {
    return undefined;
  }
}

function failureReason(error) {
  const stderr = error?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  if (stderr && typeof stderr.toString === 'function' && stderr.length) {
    return stderr.toString('utf8').trim();
  }
  return error?.message ?? String(error);
}

/**
 * The `.mcp.json` `stratum` entry Compose OWNS for a workspace: whatever the
 * runtime resolver spawns (installed dependency -> sibling checkout). This is
 * exactly what `compose init` writes, so heal/check stay consistent with it.
 *
 * NB: deliberately NOT the npx-pinned form that `stratum mcp install`/`doctor`
 * write for external consumers — that form 404s until @smartmemory/stratum is
 * published, so delegating Compose's heal to `stratum doctor --fix` would
 * rewrite a working direct-bin entry into a broken one. Compose resolves the
 * engine itself and heals to the path it can prove exists.
 */
function desiredStratumEntry(cwd, deps = {}) {
  const conn = resolveStratumMcpConnection(cwd, deps);
  return { command: conn.command, args: conn.args };
}

function sameMcpEntry(a, b) {
  if (!a || !b || a.command !== b.command) return false;
  const aArgs = Array.isArray(a.args) ? a.args : [];
  const bArgs = Array.isArray(b.args) ? b.args : [];
  return aArgs.length === bArgs.length && aArgs.every((value, index) => value === bArgs[index]);
}

/**
 * Read-only wiring check for `compose doctor`. Reports stale when Compose's
 * resolved entry differs from what is on disk (i.e. `compose update` would
 * rewrite it). Never throws.
 */
export function checkStratumWiring(cwd, deps = {}) {
  let desired;
  try {
    desired = desiredStratumEntry(cwd, deps);
  } catch (error) {
    return { ok: false, skipped: failureReason(error) };
  }
  const current = readStratumMcpEntry(cwd);
  if (sameMcpEntry(current, desired)) return { ok: true, stale: false };
  return { ok: false, stale: true, current, desired };
}

/**
 * Best-effort repair of a project's Stratum MCP wiring to Compose's resolved
 * entry, preserving sibling MCP servers. Never throws.
 */
export function healStratumWiring(cwd, deps = {}) {
  const before = readStratumMcpEntry(cwd);
  let desired;
  try {
    desired = desiredStratumEntry(cwd, deps);
  } catch (error) {
    return { healed: false, before, after: before, skipped: failureReason(error) };
  }
  if (sameMcpEntry(before, desired)) return { healed: false, before, after: before };

  const path = join(cwd, '.mcp.json');
  let document = {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) document = parsed;
  } catch {
    document = {}; // missing or malformed → rebuild a minimal valid document
  }
  if (!document.mcpServers || typeof document.mcpServers !== 'object' || Array.isArray(document.mcpServers)) {
    document.mcpServers = {};
  }
  document.mcpServers.stratum = desired;
  try {
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } catch (error) {
    return { healed: false, before, after: before, skipped: failureReason(error) };
  }
  return { healed: true, before, after: desired };
}
