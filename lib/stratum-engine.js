import { existsSync, readFileSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { execFileSync as _execFileSyncDefault } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Flag-day live dependency: Compose develop consumes the adjacent Stratum
// checkout directly until the package publication/endgame replaces this seam.
export const LIVE_STRATUM_TS_MCP_BIN = resolve(
  __dirname, '..', '..', 'stratum', 'ts', 'src', 'mcp', 'bin.mjs',
);

// The flow/gate SEAM uses the TS `query`/`gate` CLI (not the MCP bin). C1: the
// former bare-`stratum` default resolved to whatever `stratum` was on $PATH
// (e.g. miniconda's incompatible python CLI, whose `query flows` answers
// "Unknown command"), so the live checkout's CLI is the honest default.
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

/** Resolve the selected engine to StratumMcpClient.connect() options. */
export function resolveStratumMcpConnection(cwd) {
  resolveStratumEngine(cwd);
  return {
    command: process.env.COMPOSE_STRATUM_TS_NODE || process.execPath,
    args: [process.env.COMPOSE_STRATUM_TS_MCP_BIN || LIVE_STRATUM_TS_MCP_BIN],
    ...(cwd ? { cwd } : {}),
  };
}
