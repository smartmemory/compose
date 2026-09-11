#!/usr/bin/env bash
#
# negative-control.sh — prove a test can actually FAIL.
#
# A passing test is not evidence. It is evidence only once you have seen it go
# red without the production change it claims to cover. This script reverts one
# production file at a time to a git ref and reports, per test file, whether the
# tests notice.
#
# Usage:
#   scripts/negative-control.sh [--ref HEAD] [--timeout 300000] \
#       --prod lib/a.js lib/b.js -- --test test/x.test.js test/y.test.js
#
# Verdicts (four, deliberately — collapsing them is how this tool lies):
#   RED          `# fail > 0`. A real assertion caught the revert. THE ONLY PROOF.
#   GREEN        Passed with the code reverted -> that test does not cover it.
#   CANCELLED    Timed out. Inconclusive; raise --timeout and rerun.
#   DID-NOT-RUN  No tests executed. Not a result at all.
#
# Classification parses node's own TAP tally, never the exit code: a missing
# file, a timeout and a genuine assertion failure all exit non-zero and mean
# completely different things.
#
# NOTE: only works for files tracked at <ref>. A NEW file cannot be revert-tested
# (removing it breaks imports, which proves nothing); check those by hand.
set -uo pipefail

REF=HEAD; TIMEOUT=300000; PROD=(); TESTS=(); mode=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --prod) mode=prod; shift;;
    --test) mode=test; shift;;
    --) shift;;
    *) case "$mode" in prod) PROD+=("$1");; test) TESTS+=("$1");; *) echo "unexpected: $1" >&2; exit 2;; esac; shift;;
  esac
done
[ ${#PROD[@]} -gt 0 ] && [ ${#TESTS[@]} -gt 0 ] || { echo "usage: $0 --prod <files> --test <files>" >&2; exit 2; }

echo "self-check: ${#PROD[@]} production file(s), ${#TESTS[@]} test file(s)"
for f in "${PROD[@]}" "${TESTS[@]}"; do [ -f "$f" ] || { echo "ABORT: missing $f" >&2; exit 2; }; done

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

classify () {
  local l="$1" p f c
  grep -q '^# pass' "$l" || { echo DID-NOT-RUN; return; }
  p=$(grep -m1 '^# pass' "$l"|tr -dc 0-9); f=$(grep -m1 '^# fail' "$l"|tr -dc 0-9); c=$(grep -m1 '^# cancelled' "$l"|tr -dc 0-9)
  p=${p:-0}; f=${f:-0}; c=${c:-0}
  [ "$f" -gt 0 ] && { echo RED; return; }
  [ "$c" -gt 0 ] && { echo CANCELLED; return; }
  [ "$p" -eq 0 ] && { echo DID-NOT-RUN; return; }
  echo GREEN
}
run () { RESEND_API_KEY= STRIPE_API_KEY= node --test --test-timeout="$TIMEOUT" "$1" > "$2" 2>&1; }

echo "=== baseline (a test that is not green proves nothing by turning red) ==="
for t in "${TESTS[@]}"; do
  run "$t" "$WORK/base.log"; v=$(classify "$WORK/base.log")
  printf '  %-50s %s\n' "$t" "$v"
  [ "$v" = GREEN ] || { echo "ABORT: baseline not green for $t" >&2; exit 1; }
done

echo "=== revert matrix (ref: $REF) ==="
rc=0
for p in "${PROD[@]}"; do
  git diff --quiet "$REF" -- "$p" && { printf '%-34s %s\n' "$p" "SKIP (unchanged vs $REF)"; continue; }
  cp "$p" "$WORK/keep"
  git checkout "$REF" -- "$p" || { echo "revert failed: $p" >&2; continue; }
  covered=no
  for t in "${TESTS[@]}"; do
    run "$t" "$WORK/m.log"; v=$(classify "$WORK/m.log")
    [ "$v" = RED ] && covered=yes
    printf '%-34s %-44s %s\n' "$p" "$t" "$v"
  done
  cp "$WORK/keep" "$p"
  [ "$covered" = no ] && { echo "  ^^ NOT COVERED by any listed test"; rc=1; }
done
echo "=== restored; drift vs working tree: $(git diff --name-only | wc -l | tr -d ' ') file(s) modified ==="
exit $rc
