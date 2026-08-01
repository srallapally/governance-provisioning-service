#!/usr/bin/env bash
#
# Rebuild the vendored @governance-connector-framework/core tarball from a
# pinned framework commit.
#
#   bash scripts/vendor-core.sh <commit-ish> [framework-repo-url]
#
# Why a tarball and not a git dependency: npm resolves a git dependency to the
# repository root, and core lives at packages/core of a workspace. npm has no
# subdirectory syntax for git deps, so the root -- private, wrong name, no
# dist -- is all a git dep can install.
#
# The commit goes in the filename. That keeps the pin visible in package.json
# and stops npm from serving a cached tarball when the contents change but the
# name does not, which it will happily do.

set -euo pipefail

COMMIT="${1:?usage: vendor-core.sh <commit-ish> [repo-url]}"
REPO="${2:-https://github.com/srallapally/governance-connector-framework.git}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[vendor-core] cloning $REPO at $COMMIT" >&2
git clone -q "$REPO" "$WORK/fw"
git -C "$WORK/fw" checkout -q --detach "$COMMIT"
SHA="$(git -C "$WORK/fw" rev-parse --short "$COMMIT")"

echo "[vendor-core] building core" >&2
(cd "$WORK/fw" && npm ci --silent && npm run build -w @governance-connector-framework/core >/dev/null)

VERSION="$(node -p "require('$WORK/fw/packages/core/package.json').version")"
TARBALL="governance-connector-framework-core-${VERSION}-${SHA}.tgz"

(cd "$WORK/fw/packages/core" && npm pack --pack-destination "$WORK" >/dev/null)
mkdir -p "$ROOT/vendor"
rm -f "$ROOT"/vendor/governance-connector-framework-core-*.tgz
mv "$WORK/governance-connector-framework-core-${VERSION}.tgz" "$ROOT/vendor/$TARBALL"

echo "[vendor-core] wrote vendor/$TARBALL" >&2
echo "[vendor-core] now set the dependency to file:vendor/$TARBALL and reinstall" >&2
