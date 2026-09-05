#!/bin/sh
# compose-guard-sign — COMP-GUARD-ONE-TAP root-owned signer.
#
# Installed by `compose guard enrol` to /Library/Compose/guard/sign, owner
# root:wheel, mode 0755, and named by absolute path in
# /etc/sudoers.d/compose-guard with `timestamp_timeout=0`. Compose invokes it as
# `sudo -k /Library/Compose/guard/sign <namespace>` so every invocation
# re-authenticates (Touch ID via pam_tid, or the account password) and leaves
# no cached credential behind: one approval, exactly one signature.
#
# Usage:  sign <namespace>  < message  > armored-signature
#
# The private key lives at /Library/Compose/guard/private/signing-key (root,
# 0600, in a root 0700 directory; the public half sits readable one level up at
# /Library/Compose/guard/signing-key.pub) and is never readable by the
# operator's user. This
# script pins PATH, calls every binary by absolute path, stages stdin under a
# root-private directory (never the caller's TMPDIR), signs with
# `ssh-keygen -Y sign`, prints the armored signature, and removes the staging
# directory on every exit path. The namespace is the only argument and is
# validated so it cannot smuggle options into ssh-keygen.
#
# Test seam: when NOT running as root, COMPOSE_GUARD_SIGN_KEY may point at an
# alternative key so the sshsig output can be verified in-suite without sudo,
# and staging falls back to TMPDIR. As root both are ignored — root's
# environment is not a caller input (and sudo's env_reset strips them anyway).

set -eu
umask 077
PATH=/usr/bin:/bin
export PATH

GUARD_DIR=/Library/Compose/guard
KEY="$GUARD_DIR/private/signing-key"
STAGE_ROOT="$GUARD_DIR/private/tmp"

NAMESPACE="${1:-}"
case "$NAMESPACE" in
  '' ) echo "compose-guard-sign: usage: sign <namespace>" >&2; exit 64 ;;
  *[!a-z0-9-]* ) echo "compose-guard-sign: invalid namespace" >&2; exit 64 ;;
esac
case "$NAMESPACE" in
  [a-z]* ) ;;
  * ) echo "compose-guard-sign: invalid namespace" >&2; exit 64 ;;
esac
if [ "${#NAMESPACE}" -gt 64 ]; then echo "compose-guard-sign: invalid namespace" >&2; exit 64; fi

if [ "$(/usr/bin/id -u)" -ne 0 ]; then
  # Test seam only. Root ignores both.
  if [ -n "${COMPOSE_GUARD_SIGN_KEY:-}" ]; then KEY="$COMPOSE_GUARD_SIGN_KEY"; fi
  STAGE_ROOT="${TMPDIR:-/tmp}"
fi
[ -r "$KEY" ] || { echo "compose-guard-sign: signing key not readable: $KEY" >&2; exit 66; }
[ -d "$STAGE_ROOT" ] || { echo "compose-guard-sign: staging directory missing: $STAGE_ROOT" >&2; exit 66; }

WORK="$(/usr/bin/mktemp -d "$STAGE_ROOT/sign.XXXXXX")"
trap '/bin/rm -rf "$WORK"' EXIT INT TERM HUP

/bin/cat > "$WORK/message"
# -q: no chatter on stderr; the signature is written next to the message.
/usr/bin/ssh-keygen -Y sign -q -f "$KEY" -n "$NAMESPACE" "$WORK/message"
/bin/cat "$WORK/message.sig"
