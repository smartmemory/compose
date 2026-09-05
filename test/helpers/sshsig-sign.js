/**
 * test/helpers/sshsig-sign.js — COMP-LIFECYCLE-BACKFILL blueprint §7.2.
 *
 * A test-only sshsig signer producing the same armored artifact
 * `ssh-keygen -Y sign` produces, so the golden flows can build a signed guard
 * upgrade descriptor without shelling out to OpenSSH or committing a key.
 *
 * A JavaScript port of `stratum/ts/tests/helpers/sshsig-sign.ts`. This is an
 * INDEPENDENT implementation of the signing side; the verifying side is
 * exercised against a real `ssh-keygen` golden artifact in
 * `stratum/ts/tests/guard/sshsig.test.ts`, so a shared misunderstanding between
 * the two cannot pass unnoticed.
 *
 * Eight things must be reproduced exactly or `verifySshsig` rejects the result:
 * the raw 32-byte key is the TAIL of the SPKI DER export; every field is length-
 * prefixed big-endian; the signed pre-image carries an EMPTY reserved field; the
 * hash algorithm is named in the blob and used for the digest and the two must
 * agree; Ed25519 signing takes a `null` algorithm; the armor wraps at 70 chars;
 * and the namespace is `stratum-guard-descriptors` — a different one verifies as
 * a rejection, which is what makes the negative fixtures meaningful.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

const MAGIC = Buffer.from('SSHSIG', 'utf8');
const ED25519 = 'ssh-ed25519';

/** The namespace stratum's descriptor verifier requires (descriptors.ts:35). */
export const DESCRIPTOR_NAMESPACE = 'stratum-guard-descriptors';

function sshString(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/**
 * @returns {{publicKeyLine: string, sign: (message: Buffer|string, namespace: string, hashAlgorithm?: string) => string}}
 */
export function createTestSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // The raw 32 bytes are the TAIL of the Ed25519 SPKI DER encoding.
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKeyBlob = Buffer.concat([sshString(ED25519), sshString(raw)]);

  return {
    /** `ssh-ed25519 AAAA...` — the form an allowed_signers line carries. */
    publicKeyLine: `${ED25519} ${publicKeyBlob.toString('base64')}`,

    sign(message, namespace, hashAlgorithm = 'sha512') {
      const body = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');
      const signedData = Buffer.concat([
        MAGIC,
        sshString(namespace),
        sshString(Buffer.alloc(0)),          // the reserved field must be present
        sshString(hashAlgorithm),
        sshString(createHash(hashAlgorithm).update(body).digest()),
      ]);
      // `null` algorithm is required for Ed25519.
      const signature = cryptoSign(null, signedData, privateKey);
      const blob = Buffer.concat([
        MAGIC,
        uint32(1),
        sshString(publicKeyBlob),
        sshString(namespace),
        sshString(Buffer.alloc(0)),
        sshString(hashAlgorithm),
        sshString(Buffer.concat([sshString(ED25519), sshString(signature)])),
      ]);
      const wrapped = blob.toString('base64').replace(/(.{70})/g, '$1\n');
      return `-----BEGIN SSH SIGNATURE-----\n${wrapped}\n-----END SSH SIGNATURE-----\n`;
    },
  };
}
