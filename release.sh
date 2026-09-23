#!/bin/bash
#
# Release Darkslide: bump version, build the signed DMG, tag, create a GitHub
# Release with the DMG attached, and (by default) publish it to the landing site.
#
# Usage:
#   ./release.sh                 # build + release + publish landing
#   ./release.sh --no-landing    # build + release only
#   ./release.sh --reuse-dmg     # reuse an existing dist-dmg/Darkslide.dmg (no rebuild/bump)
#   ./release.sh --no-push       # do everything locally except push/tag/release
#
# Requires: DEVELOPER_ID / APPLE_ID / APP_PASSWORD (read from ./.env), the `gh`
# CLI (authenticated), and a clean working tree.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${PROJECT_DIR}"

LANDING_DIR="${PROJECT_DIR}/../darkslide_landing"
DMG_PATH="${PROJECT_DIR}/dist-dmg/Darkslide.dmg"
TAURI_CONF="${PROJECT_DIR}/src-tauri/tauri.conf.json"

PUBLISH_LANDING=true
REUSE_DMG=false
PUSH=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-landing) PUBLISH_LANDING=false; shift ;;
    --reuse-dmg)  REUSE_DMG=true; shift ;;
    --no-push)    PUSH=false; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

read_version() {
  grep '"version"' "${TAURI_CONF}" | head -1 | sed 's/.*"version": *"\(.*\)",*/\1/'
}

# ── 0. Sanity checks ─────────────────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ Working tree is not clean. Commit or stash first:" >&2
  git status --short >&2
  exit 1
fi

if [ "${PUSH}" = true ] && ! command -v gh >/dev/null 2>&1; then
  echo "✗ gh CLI not found (needed for the GitHub release)." >&2
  exit 1
fi

if [ "${PUSH}" = true ]; then
  BRANCH="$(git branch --show-current)"
  if [ "${BRANCH}" != "main" ]; then
    echo "✗ Releases must be cut from main (currently on '${BRANCH}')." >&2
    exit 1
  fi
fi

# ── 1. Build (or reuse) the DMG ──────────────────────────────────────────────
if [ "${REUSE_DMG}" = true ]; then
  if [ ! -f "${DMG_PATH}" ]; then
    echo "✗ --reuse-dmg given but ${DMG_PATH} does not exist." >&2
    exit 1
  fi
  VERSION="$(read_version)"
  echo "▶ Reusing existing DMG for v${VERSION}"
else
  # shellcheck disable=SC1091
  source "${PROJECT_DIR}/.env"
  export SKIP_NOTARIZATION=true   # notarization intentionally skipped for now
  echo "▶ Building DMG (this bumps the patch version)…"
  bash "${PROJECT_DIR}/build_mac_dmg.sh"
  VERSION="$(read_version)"
fi

TAG="v${VERSION}"
echo "▶ Version: ${VERSION}  (tag ${TAG})"

if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "✗ Tag ${TAG} already exists." >&2
  exit 1
fi

# ── 2. Commit the version bump (if the build changed it) ─────────────────────
if [ -n "$(git status --porcelain)" ]; then
  git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json Cargo.lock
  git commit -m "chore: bump version to ${VERSION}"
  echo "▶ Committed version bump."
fi

# ── 3. Tag, push, and create the GitHub Release ──────────────────────────────
if [ "${PUSH}" = true ]; then
  git tag -a "${TAG}" -m "Darkslide ${TAG}"
  git push origin main
  git push origin "${TAG}"
  echo "▶ Pushed main and ${TAG}."

  # --generate-notes summarizes merged PRs/commits since the previous release.
  gh release create "${TAG}" "${DMG_PATH}" \
    --title "Darkslide ${TAG}" \
    --generate-notes
  echo "▶ GitHub Release ${TAG} created with ${DMG_PATH##*/}."
else
  echo "▶ --no-push: skipped tag/push/release."
fi

# ── 4. Publish the DMG to the landing site ───────────────────────────────────
if [ "${PUBLISH_LANDING}" = true ]; then
  if [ ! -d "${LANDING_DIR}" ]; then
    echo "✗ Landing dir not found at ${LANDING_DIR}; skipping publish." >&2
  else
    mkdir -p "${LANDING_DIR}/public/download"
    cp "${DMG_PATH}" "${LANDING_DIR}/public/download/Darkslide.dmg"
    echo "▶ Copied DMG to landing public/download."
    ( cd "${LANDING_DIR}" && npm run publish )
    echo "▶ Landing published."
  fi
fi

echo "✓ Release ${TAG} complete."
