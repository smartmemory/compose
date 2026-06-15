/**
 * COMP-RTK-INTEROP — optional RTK (Rust Token Killer) interop.
 *
 * RTK (https://github.com/rtk-ai/rtk) is a LOSSY command-output compressor invoked
 * as a command-PREFIX wrapper: `rtk git diff` runs git diff itself and rewrites
 * stdout, compressing it 60–90% for LLM consumption. There is no stdin-filter mode.
 *
 * INTEGRATION RULE — read before adding a call site:
 *   Wrap a command with rtkPrefix() ONLY when its stdout is fed into an LLM prompt
 *   (e.g. a diff shown to a Codex reviewer). NEVER wrap a command whose output is
 *   parsed by code (filename lists via split('\n'), SHAs/shortstat via regex/.trim())
 *   or re-applied mechanically (`git apply` patches) — RTK's lossy rewrite would
 *   silently corrupt the parse/patch.
 *
 * Also pass only operator-free bare commands (no `;`, `&&`, `||`, `2>`): RTK runs the
 * command, so shell operators would not be wrapped meaningfully.
 *
 * Detection is memoized once per process. Set COMPOSE_DISABLE_RTK=1 to force-disable
 * (e.g. CI, or if RTK ever misbehaves) — degrades to raw, byte-identical commands.
 */
import { spawnSync } from 'node:child_process'

let _cached = null // memoized availability; null = not yet probed

// Default probe: `rtk --version` exits 0 when installed. Swappable in tests.
let _prober = () => {
  try {
    const r = spawnSync('rtk', ['--version'], { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' })
    return r.status === 0
  } catch {
    return false
  }
}

/**
 * Whether `rtk` is usable in this process. Memoized after the first call.
 * COMPOSE_DISABLE_RTK=1 short-circuits to false (and is cached like any other result).
 */
export function isRtkAvailable() {
  if (_cached !== null) return _cached
  if (process.env.COMPOSE_DISABLE_RTK === '1') {
    _cached = false
    return _cached
  }
  _cached = _prober()
  return _cached
}

/**
 * Prefix an LLM-bound command with `rtk` when RTK is available; otherwise return it
 * unchanged (byte-identical degrade). Pass only operator-free bare commands.
 */
export function rtkPrefix(command) {
  return isRtkAvailable() ? `rtk ${command}` : command
}

// --- test seams ------------------------------------------------------------
/** Replace the availability prober and clear the memoized result. Tests only. */
export function _setRtkProber(fn) {
  _prober = fn
  _cached = null
}
/** Clear the memoized availability result so the next call re-probes. Tests only. */
export function _resetRtkCache() {
  _cached = null
}
