#!/usr/bin/env bash
#
# Manual release for @smartmemory/compose — a stand-in for
# .github/workflows/{beta,publish}.yml while GitHub Actions is dormant.
#
# WHY: the smartmemory org's sole owner account (smartmem-dev) is suspended, so
# pushes by it don't trigger Actions. This reproduces the CI publish locally.
# DELETE this script once CI is restored (a non-frozen owner pushing, or an
# org-owned GitHub App). The CI workflows remain the source of truth.
#
# Usage:
#   scripts/release-manual.sh beta                  # publish next X.Y.(Z+1)-beta to the `beta` tag
#   scripts/release-manual.sh stable [X.Y.Z]        # publish stable to `latest` + git tag + GH release
#   scripts/release-manual.sh beta   --dry-run      # build + dry-run publish, no upload
#   scripts/release-manual.sh stable --dry-run
#
# Requires: NPM_SM_TOKEN = npm granular token with "bypass 2FA" (the same token
#           CI uses as the NPM_TOKEN secret). The token is written only to a
#           temp npmrc (removed on exit) — never to ~/.npmrc, argv, or logs.
#
# Mirrors CI exactly except: no --provenance (needs CI OIDC) and tests are not
# re-run (run `npm test` yourself first if the tree changed since the last green).
set -euo pipefail

MODE="${1:-beta}"
ARG2="${2:-}"
DRY=""
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY="--dry-run"; done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
PKG="@smartmemory/compose"

if [ -z "${NPM_SM_TOKEN:-}" ]; then
  echo "ERROR: NPM_SM_TOKEN is not set (need an npm granular token with 'bypass 2FA')." >&2
  exit 1
fi

TMPRC="$(mktemp)"
printf '//registry.npmjs.org/:_authToken=%s\nregistry=https://registry.npmjs.org/\n' "$NPM_SM_TOKEN" > "$TMPRC"
cleanup() { rm -f "$TMPRC"; git checkout -- package.json 2>/dev/null || true; }
trap cleanup EXIT

set_version() {
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='$1';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');"
}

ORIG_VERSION="$(node -p "require('./package.json').version")"
NPM_BETA="$(npm view "$PKG@beta" version 2>/dev/null || echo '')"

case "$MODE" in
  beta)
    NPM_BASE="${NPM_BETA%-beta}"; PKG_BASE="${ORIG_VERSION%-beta}"
    if [ -n "$NPM_BETA" ] && [ "$(printf '%s\n' "$NPM_BASE" "$PKG_BASE" | sort -V | tail -n1)" = "$NPM_BASE" ]; then
      BASE="$NPM_BASE"
    else
      BASE="$PKG_BASE"
    fi
    IFS=. read -r MA MI PA <<< "$BASE"
    VERSION="${MA}.${MI}.$((PA+1))-beta"
    TAG="beta"
    ;;
  stable)
    if [ -n "$ARG2" ] && [ "$ARG2" != "--dry-run" ]; then
      VERSION="$ARG2"
    else
      VERSION="${NPM_BETA%-beta}"; [ -z "$VERSION" ] && VERSION="${ORIG_VERSION%-beta}"
    fi
    if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "ERROR: stable version must be X.Y.Z (got '$VERSION'). Pass it explicitly: stable 0.2.52" >&2
      exit 1
    fi
    TAG="latest"
    ;;
  *)
    echo "Usage: $0 {beta | stable [X.Y.Z]} [--dry-run]" >&2
    exit 1
    ;;
esac

echo ">> $MODE: $PKG@$VERSION  ->  dist-tag '$TAG'  ${DRY:+[DRY-RUN]}"
set_version "$VERSION"
echo ">> build (vite)"; npm run build >/dev/null
echo ">> publish"
npm publish --access public --tag "$TAG" --ignore-scripts $DRY --userconfig "$TMPRC"

if [ "$MODE" = "stable" ] && [ -z "$DRY" ]; then
  echo ">> git tag v$VERSION (+ push via origin SSH)"
  git rev-parse "v$VERSION" >/dev/null 2>&1 || git tag "v$VERSION"
  git push origin "v$VERSION" 2>&1 || echo "   (tag push skipped — may already exist on origin)"
  echo ">> GitHub release (best-effort; needs gh authed to an account that can write to the repo)"
  gh release create "v$VERSION" --repo smartmemory/compose --title "v$VERSION" \
    --notes "Stable release v$VERSION" --latest 2>&1 \
    || echo "   (release create failed — e.g. gh active account lacks repo access; create it manually if wanted)"
fi

echo ">> done. live dist-tags:"
npm view "$PKG" dist-tags --prefer-online 2>/dev/null || true
