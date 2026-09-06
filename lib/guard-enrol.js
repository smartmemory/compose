import { execFile as defaultExecFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, lstat as defaultLstat, mkdtemp as defaultMkdtemp, readFile as defaultReadFile, rm as defaultRm, stat as defaultStat, writeFile as defaultWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CUSTODY_TIMEOUT_MS, custodyBackend as defaultCustodyBackend, custodySign as defaultCustodySign,
  GUARD_DIR, HINT_ENROL, PRIVATE_DIR, PUBKEY_PATH, SIGNER_PATH, SUDO_ENV,
  SUDOERS_PATH, SUDO_LOCAL_PATH,
} from './guard-custody.js';
import { guardDescriptors as defaultGuardDescriptors } from '../server/stratum-client.js';

const require = createRequire(import.meta.url);
const sshsig = await import(require.resolve('@smartmemory/stratum/dist/guard/sshsig.js'));
const { parseAllowedSigners, sshFingerprint, verifySshsig } = sshsig;
const DESCRIPTOR_NAMESPACE = 'stratum-guard-descriptors';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGED_SIGNER = path.resolve(MODULE_DIR, '..', 'scripts', 'guard-sign', 'compose-guard-sign.sh');

export const PRINCIPAL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SUDOERS_TEXT = (principal) =>
  `Defaults!${SIGNER_PATH} timestamp_timeout=0\n${principal} ALL=(root) ${SIGNER_PATH}\n`;

function spawnWithInput(execFile, file, args, options, bytes) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (error, stdout = '', stderr = '') => {
      if (settled) return;
      settled = true;
      resolve({ error, stdout, stderr });
    };
    try {
      const child = execFile(file, args, options, done);
      child?.stdin?.end(bytes);
      child?.on?.('error', (error) => done(error));
    } catch (error) {
      done(error);
    }
  });
}

function firstLine(value, fallback = 'command failed') {
  return String(value || '').split(/\r?\n/, 1)[0] || fallback;
}

/** Check every existing ancestor without following a symlink at any level. */
export async function validateAncestry(target, deps = {}) {
  const lstat = deps.lstat ?? defaultLstat;
  const stat = deps.stat ?? defaultStat;
  let current = path.resolve(target);
  for (;;) {
    let lst;
    try {
      lst = await lstat(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const parent = path.dirname(current);
        if (parent === current) return { ok: false, offending: { path: current, reason: 'missing' } };
        current = parent;
        continue;
      }
      return { ok: false, offending: { path: current, reason: firstLine(error?.message) } };
    }
    if (lst.isSymbolicLink()) return { ok: false, offending: { path: current, reason: 'symlink' } };
    let info;
    try { info = await stat(current); } catch (error) {
      return { ok: false, offending: { path: current, reason: firstLine(error?.message) } };
    }
    if (info.uid !== 0) return { ok: false, offending: { path: current, reason: 'not root-owned' } };
    if ((info.mode & 0o022) !== 0) return { ok: false, offending: { path: current, reason: 'group or world writable' } };
    const parent = path.dirname(current);
    if (parent === current) return { ok: true, offending: null };
    current = parent;
  }
}

/** Resolve the package's reviewable source trust root, never an environment path. */
export async function locateTrustRoot(deps = {}) {
  const packageJson = deps.packageJsonPath ?? require.resolve('@smartmemory/stratum/package.json');
  const packageRoot = deps.packageRoot ?? path.dirname(packageJson);
  const exists = deps.exists ?? (async (file) => access(file).then(() => true, () => false));
  const source = path.join(packageRoot, 'contracts', 'guard-signers.allowed');
  if (await exists(source)) return { kind: 'source', path: source, checkoutRoot: packageRoot };
  const dist = path.join(packageRoot, 'dist', 'contracts', 'guard-signers.allowed');
  if (await exists(dist)) return { kind: 'dist', path: dist, checkoutRoot: null };
  throw new Error(`could not locate Stratum guard trust root under ${packageRoot}`);
}

/** Produce a whole-file parsed trust-root candidate, never a partial append. */
export function candidateTrustRoot(current, principal, publicKeyLine) {
  if (!PRINCIPAL_RE.test(principal)) throw new Error(`invalid principal ${JSON.stringify(principal)}; expected ${PRINCIPAL_RE}`);
  if (typeof publicKeyLine !== 'string' || /[^\x20-\x7e]/.test(publicKeyLine.trim())) {
    throw new Error('public key line must be printable ASCII');
  }
  const key = parseAllowedSigners(`candidate ${publicKeyLine.trim()}\n`)[0];
  if (!key) throw new Error('public key line did not contain a signer');
  const signers = parseAllowedSigners(current);
  const present = signers.some((entry) => entry.fingerprint === key.fingerprint);
  const line = `${principal} ${publicKeyLine.trim()}`;
  const text = present ? current : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
  const parsed = parseAllowedSigners(text);
  return { present, text, candidate: text, line, fingerprint: key.fingerprint, signers: parsed };
}

export function installPlan(principal) {
  if (!PRINCIPAL_RE.test(principal)) throw new Error(`invalid principal ${JSON.stringify(principal)}; expected ${PRINCIPAL_RE}`);
  return [
    `install root-owned signer: ${SIGNER_PATH}`,
    `create root-owned signing key: ${PRIVATE_DIR}/signing-key`,
    `publish public key: ${PUBKEY_PATH}`,
    `install sudoers rule: ${SUDOERS_PATH}`,
    `enable Touch ID for sudo: ${SUDO_LOCAL_PATH}`,
    `add signer principal to Stratum trust root: ${principal}`,
    `root installation script:\n${installScript(principal)}`,
  ];
}

const SIGNER_HEREDOC_DELIMITER = 'COMPOSE_GUARD_SIGNER_SCRIPT';

/**
 * Exact root-side installation payload. It is intentionally shell-only and
 * idempotent.
 *
 * Every `${…}` interpolated into this template is either a constant path
 * exported by guard-custody.js (GUARD_DIR, PRIVATE_DIR, SIGNER_PATH,
 * PUBKEY_PATH, SUDOERS_PATH, SUDO_LOCAL_PATH — never a runtime/user-supplied
 * string) or shell text already embedded via a quoted heredoc (`sudoers`,
 * `signerScript`) rather than interpolated inline. The packaged signer's
 * module-directory path is never interpolated into the script at all: its
 * bytes are read here and written to SIGNER_PATH via a quoted heredoc, so a
 * compose install path containing a space or shell metacharacter cannot break
 * or inject into the root shell.
 */
export function installScript(principal, deps = {}) {
  if (!PRINCIPAL_RE.test(principal)) throw new Error(`invalid principal ${JSON.stringify(principal)}; expected ${PRINCIPAL_RE}`);
  const sudoers = SUDOERS_TEXT(principal).trimEnd();
  const readSigner = deps.readSigner ?? (() => readFileSync(PACKAGED_SIGNER, 'utf8'));
  const signerScript = readSigner();
  if (signerScript.includes(SIGNER_HEREDOC_DELIMITER)) {
    throw new Error(`packaged signer script contains the heredoc delimiter ${SIGNER_HEREDOC_DELIMITER}; choose a different delimiter`);
  }
  return `set -eu\numask 022\nPATH=/usr/bin:/bin:/usr/sbin\nexport PATH\n/bin/mkdir -p /Library/Compose/guard/private/tmp\n/bin/chmod 0755 /Library/Compose ${GUARD_DIR}\n/bin/chmod 0700 ${PRIVATE_DIR} ${PRIVATE_DIR}/tmp\n/bin/cat > ${SIGNER_PATH} <<'${SIGNER_HEREDOC_DELIMITER}'\n${signerScript.trimEnd()}\n${SIGNER_HEREDOC_DELIMITER}\n/usr/sbin/chown root:wheel ${SIGNER_PATH}\n/bin/chmod 0755 ${SIGNER_PATH}\nif [ ! -f ${PRIVATE_DIR}/signing-key ]; then\n  /usr/bin/ssh-keygen -t ed25519 -N '' -q -f ${PRIVATE_DIR}/signing-key -C compose-guard\nfi\n/usr/sbin/chown root:wheel ${PRIVATE_DIR}/signing-key ${PRIVATE_DIR}/signing-key.pub\n/bin/chmod 0600 ${PRIVATE_DIR}/signing-key\n/bin/cp ${PRIVATE_DIR}/signing-key.pub ${PUBKEY_PATH}\n/usr/sbin/chown root:wheel ${PUBKEY_PATH}\n/bin/chmod 0644 ${PUBKEY_PATH}\n_sudoers_tmp=${SUDOERS_PATH}.tmp.$$\n/bin/cat > "$_sudoers_tmp" <<'COMPOSE_GUARD_SUDOERS'\n${sudoers}\nCOMPOSE_GUARD_SUDOERS\n/usr/sbin/visudo -cf "$_sudoers_tmp"\n/usr/bin/install -o root -g wheel -m 0440 "$_sudoers_tmp" ${SUDOERS_PATH}\n/bin/rm -f "$_sudoers_tmp"\nif [ ! -f ${SUDO_LOCAL_PATH} ]; then\n  /bin/cat > ${SUDO_LOCAL_PATH} <<'COMPOSE_GUARD_PAM'\nauth sufficient pam_tid.so\nCOMPOSE_GUARD_PAM\nelif ! /usr/bin/grep -Eq '^[[:space:]]*auth[[:space:]]+sufficient[[:space:]]+pam_tid\\.so' ${SUDO_LOCAL_PATH}; then\n  /bin/cat >> ${SUDO_LOCAL_PATH} <<'COMPOSE_GUARD_PAM'\nauth sufficient pam_tid.so\nCOMPOSE_GUARD_PAM\nfi\n/usr/sbin/chown root:wheel ${SUDO_LOCAL_PATH}\n/bin/chmod 0644 ${SUDO_LOCAL_PATH}\necho 'ok directories'\necho 'ok signer'\necho 'ok key'\necho 'ok sudoers'\necho 'ok pam_tid'\n`;
}

/** Sign and cryptographically verify a durable fixture against exactly one public key. */
export async function roundTrip({ custodySign, publicKeyLine, deps = {} }) {
  const mkdtemp = deps.mkdtemp ?? defaultMkdtemp;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const readFile = deps.readFile ?? defaultReadFile;
  const rm = deps.rm ?? defaultRm;
  const dir = await mkdtemp(path.join(tmpdir(), 'compose-guard-enrol-'));
  const file = path.join(dir, 'descriptors.json');
  const bytes = Buffer.from('{"version":1,"descriptors":[]}\n');
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    const signed = await custodySign({ bytes, namespace: DESCRIPTOR_NAMESPACE });
    if (!signed?.ok) throw new Error(signed?.message || 'fixture signature was not approved');
    await writeFile(`${file}.sig`, signed.armored, { mode: 0o600 });
    const signer = parseAllowedSigners(`fixture ${publicKeyLine.trim()}\n`)[0];
    if (!signer) throw new Error('public key line did not contain a signer');
    verifySshsig(await readFile(file), await readFile(`${file}.sig`, 'utf8'), DESCRIPTOR_NAMESPACE, [signer.publicKey]);
    return { dir, file, sig: `${file}.sig`, namespace: DESCRIPTOR_NAMESPACE, fingerprint: signer.fingerprint, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function rebuildStratumDist(checkoutRoot, deps = {}) {
  const { error, stderr } = await spawnWithInput(deps.execFile ?? defaultExecFile, 'npm', ['run', 'build'], { cwd: checkoutRoot, timeout: CUSTODY_TIMEOUT_MS }, Buffer.alloc(0));
  if (error) throw new Error(`Stratum build failed: ${firstLine(stderr || error.message)}`);
}

function result(status, lines, extra = {}) { return { status, lines, ...extra }; }

/** Complete, deliberately ordered enrolment ceremony. Every side effect is injectable. */
export async function runEnrol({ principal = process.env.USER || process.env.USERNAME || '' } = {}, deps = {}) {
  // The plan must always reach a human before the root step runs — a silent
  // no-op emitter would let any in-process caller (including a bare
  // `runGuardEnrol()`) reach `sudo -k /bin/sh -s` with the plan never shown.
  // So the emitter is mandatory, checked before the backend check, before any
  // spawn or filesystem access.
  if (typeof deps.emit !== 'function') {
    return result('refused', ['enrol requires a line emitter so the plan is shown before the root step'], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  }
  const backend = (deps.custodyBackend ?? defaultCustodyBackend)();
  if (backend !== 'sudo') return result('refused', ['enrol requires the sudo custody backend on macOS'], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  if (!PRINCIPAL_RE.test(principal)) return result('refused', [`invalid principal ${JSON.stringify(principal)}; expected ${PRINCIPAL_RE}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });

  const ancestry = deps.validateAncestry ?? validateAncestry;
  const installTargets = [GUARD_DIR, SIGNER_PATH, PUBKEY_PATH, PRIVATE_DIR, SUDOERS_PATH, SUDO_LOCAL_PATH];
  for (const target of installTargets) {
    const checked = await ancestry(target, deps);
    if (!checked.ok) return result('refused', [`unsafe install ancestry at ${checked.offending.path}: ${checked.offending.reason}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  }
  // `installScript` now reads the packaged signer from disk and can throw (a
  // missing/unreadable signer, or a heredoc-delimiter collision); `emit` is
  // caller-supplied and can throw too. Neither has spawned or written
  // anything yet, so a failure here must still return the refused envelope,
  // not reject the promise.
  let script;
  try {
    script = installScript(principal, deps);
    const emit = deps.emit;
    for (const line of installPlan(principal)) emit(line);
    emit('root installation follows:');
  } catch (error) {
    return result('refused', [`enrol preparation failed: ${firstLine(error.message)}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  }
  const lines = [];
  const rootStep = await spawnWithInput(deps.execFile ?? defaultExecFile, '/usr/bin/sudo', ['-k', '/bin/sh', '-s'], { env: SUDO_ENV(), timeout: CUSTODY_TIMEOUT_MS, maxBuffer: 1 << 20 }, script);
  if (rootStep.error) return result('refused', [...lines, `root installation failed: ${firstLine(rootStep.stderr || rootStep.error.message)}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  lines.push(...String(rootStep.stdout || '').split(/\r?\n/).filter((line) => line.startsWith('ok ')));

  for (const target of installTargets) {
    const checked = await ancestry(target, deps);
    if (!checked.ok) return result('refused', [...lines, `unsafe installed ancestry at ${checked.offending.path}: ${checked.offending.reason}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  }
  const readFile = deps.readFile ?? defaultReadFile;
  let publicKeyLine;
  try { publicKeyLine = (await readFile(PUBKEY_PATH, 'utf8')).trim(); } catch (error) {
    return result('refused', [...lines, `could not read enrolled public key: ${firstLine(error.message)}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  }

  let fixture;
  try {
    fixture = await roundTrip({ custodySign: deps.custodySign ?? defaultCustodySign, publicKeyLine, deps });
  } catch (error) {
    return result('refused', [...lines, `round-trip signature failed: ${firstLine(error.message)}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  }
  try {
    const trust = await (deps.locateTrustRoot ?? locateTrustRoot)(deps);
    const current = await readFile(trust.path, 'utf8');
    const candidate = candidateTrustRoot(current, principal, publicKeyLine);
    if (trust.kind !== 'source') {
      return result('refused', [...lines, `add this line to ${trust.path} in a Stratum source release:`, candidate.line], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
    }
    if (!candidate.present) await (deps.writeFile ?? defaultWriteFile)(trust.path, candidate.text, 'utf8');
    await (deps.rebuildStratumDist ?? rebuildStratumDist)(trust.checkoutRoot, deps);
    const inspected = await (deps.guardDescriptors ?? defaultGuardDescriptors)(fixture.file);
    const expected = `verified: signed by ${principal} (${fixture.fingerprint})`;
    if (inspected?.status !== 'ok' || !String(inspected?.signature || '').startsWith(expected) || inspected?.group_or_world_writable !== false) {
      return result('refused', [...lines, `final Stratum verification failed: ${inspected?.signature || 'no verifier verdict'}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
    }
    return result('done', [...lines, `enrolled ${principal} (${fixture.fingerprint})`, 'done'], { fingerprint: fixture.fingerprint });
  } catch (error) {
    return result('refused', [...lines, `enrolment failed: ${firstLine(error?.message)}`], { code: 'upgrade_descriptor_unavailable', hint: HINT_ENROL });
  } finally {
    await fixture.cleanup();
  }
}
