import { execFile as defaultExecFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';

export const GUARD_DIR = '/Library/Compose/guard';
export const SIGNER_PATH = '/Library/Compose/guard/sign';
export const PUBKEY_PATH = '/Library/Compose/guard/signing-key.pub';
export const PRIVATE_DIR = '/Library/Compose/guard/private';
export const SUDOERS_PATH = '/private/etc/sudoers.d/compose-guard';
export const SUDO_LOCAL_PATH = '/private/etc/pam.d/sudo_local';
export const CUSTODY_TIMEOUT_MS = 120_000;
export const DESCRIPTOR_LOCK_TIMEOUT_MS = 150_000;
export const HINT_ENROL = 'compose guard enrol';
export const HINT_APPROVE = 'approve the Touch ID prompt; if none appeared, run compose guard sign from a terminal on this Mac';

/** The only environment the root-owned signer may inherit. */
export const SUDO_ENV = () => ({
  PATH: '/usr/bin:/bin',
  HOME: os.homedir(),
  USER: os.userInfo().username,
  LANG: 'C',
});

let testBackend = null;

/** The selected custody backend. Test injection wins over the host platform. */
export function custodyBackend() {
  if (testBackend !== null) return typeof testBackend === 'string' ? testBackend : (testBackend.backend ?? 'test');
  return process.platform === 'darwin' ? 'sudo' : 'none';
}

/** Test-only backend injection. Kept unavailable to shipped callers. */
export function _testOnly_setCustodyBackend(backend) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_testOnly_setCustodyBackend is only available when NODE_ENV=test');
  }
  testBackend = backend ?? null;
}

function firstLine(value, fallback) {
  return String(value || '').split(/\r?\n/, 1)[0] || fallback;
}

function refusal(code, message, hint) {
  return { ok: false, code, message, hint };
}

function isNotApproved(error, stderr) {
  return error?.killed || error?.code === 'ETIMEDOUT'
    || /terminal is required|Sorry, try again|authentication failed|timed out/i.test(String(stderr || error?.message || ''));
}

function spawnWithInput(execFile, file, args, options, bytes) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    };
    try {
      const child = execFile(file, args, options, done);
      if (child?.stdin) {
        try { child.stdin.end(bytes); } catch { /* callback maps the failure */ }
      }
      child?.on?.('error', (error) => done(error, '', ''));
    } catch (error) {
      done(error, '', '');
    }
  });
}

/** Ask the selected custody backend to sign exact in-memory bytes. */
export async function custodySign({ bytes, namespace }, deps = {}) {
  if (testBackend && typeof testBackend === 'object' && typeof testBackend.sign === 'function') {
    return testBackend.sign({ bytes, namespace });
  }
  if (custodyBackend() !== 'sudo') {
    return refusal('upgrade_descriptor_unavailable', 'no signing custody on this platform', HINT_ENROL);
  }

  const { error, stdout, stderr } = await spawnWithInput(
    deps.execFile ?? defaultExecFile,
    '/usr/bin/sudo',
    ['-k', SIGNER_PATH, namespace],
    { env: SUDO_ENV(), timeout: CUSTODY_TIMEOUT_MS, maxBuffer: 1 << 20 },
    bytes,
  );
  if (!error) return { ok: true, armored: stdout };
  if (isNotApproved(error, stderr)) {
    return refusal('signature_not_approved', firstLine(stderr || error.message, 'signature approval was not completed'), HINT_APPROVE);
  }
  return refusal('upgrade_descriptor_unavailable', firstLine(stderr || error.message, 'signer failed'), HINT_ENROL);
}

async function commandStatus(args, deps = {}) {
  const { error, stdout, stderr } = await spawnWithInput(
    deps.execFile ?? defaultExecFile, '/usr/bin/sudo', args, { env: SUDO_ENV(), timeout: 5_000 }, Buffer.alloc(0),
  );
  return { code: error?.code ?? 0, stdout, stderr, error };
}

async function expectedFile(file, mode) {
  try {
    const info = await stat(file);
    return info.uid === 0 && (info.mode & 0o777) === mode;
  } catch { return false; }
}

/** Report separately what can be observed about the sudo installation. */
export async function custodyStatus(deps = {}) {
  if (testBackend && typeof testBackend === 'object' && typeof testBackend.status === 'function') {
    return testBackend.status();
  }
  const backend = custodyBackend();
  if (backend !== 'sudo') {
    return { backend, installed: false, rule: 'absent', presence: 'unknown', cachedCredential: 'unknown', publicKeyLine: null, detail: ['no signing custody on this platform'] };
  }

  const [guard, privateDir, signer, pubkey, sudoers, sudoLocal] = await Promise.all([
    expectedFile(GUARD_DIR, 0o755), expectedFile(PRIVATE_DIR, 0o700), expectedFile(SIGNER_PATH, 0o755),
    expectedFile(PUBKEY_PATH, 0o644), expectedFile(SUDOERS_PATH, 0o440), readFile(SUDO_LOCAL_PATH, 'utf8').catch(() => ''),
  ]);
  const detail = [];
  const listed = await commandStatus(['-n', '-l', SIGNER_PATH], deps);
  const rule = listed.code === 0 ? 'present'
    : /password is required/i.test(listed.stderr) ? 'unknown' : 'absent';
  if (rule === 'unknown') detail.push('sudo requires authentication to list');
  const cached = await commandStatus(['-n', '-v'], deps);
  const cachedCredential = cached.code === 0 ? 'live' : cached.code === 1 ? 'none' : 'unknown';
  const touchId = /^\s*auth\s+sufficient\s+pam_tid\.so/m.test(sudoLocal);
  const remote = Boolean(process.env.SSH_CONNECTION || process.env.TMUX);
  const presence = remote ? 'unlikely' : touchId ? 'likely' : 'unknown';
  if (remote) detail.push('SSH_CONNECTION or TMUX prevents a reliable Touch ID prompt');
  if (!touchId) detail.push('sudo_local has no active pam_tid line');
  let publicKeyLine = null;
  try { publicKeyLine = (await readFile(PUBKEY_PATH, 'utf8')).trim() || null; } catch { /* reported by installed */ }
  return {
    backend, installed: guard && privateDir && signer && pubkey && sudoers, rule, presence, cachedCredential, publicKeyLine, detail,
  };
}
