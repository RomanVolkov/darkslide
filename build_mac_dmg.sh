#!/bin/bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="Darkslide"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="${PROJECT_DIR}/target/release/bundle/macos/${APP_NAME}.app"
OUTPUT_DIR="${PROJECT_DIR}/dist-dmg"

# Required environment variables — set these before running, or export them in
# your shell profile / CI secrets:
#   DEVELOPER_ID   — 10-char Apple Team ID (e.g. "ABCD123456")
#   APPLE_ID       — your Apple ID email used for notarization
#   APP_PASSWORD   — app-specific password from appleid.apple.com
# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="Darkslide"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="${PROJECT_DIR}/target/release/bundle/macos/${APP_NAME}.app"
OUTPUT_DIR="${PROJECT_DIR}/dist-dmg"

# Required environment variables — set these before running, or export them in
# your shell profile / CI secrets:
# DEVELOPER_ID   ## 10-char Apple Team ID (e.g. "ABCD123456")
# APPLE_ID      ## your Apple ID email used for notarization
# APP_PASSWORD   ## app-specific password from appleid.apple.com
# SKIP_NOTARIZATION    = 'false' # Set to 'true' to skip notarization

DEVELOPER_ID="${DEVELOPER_ID:?'DEVELOPER_ID env var required (your 10-char Apple Team ID)'}"
APPLE_ID="${APPLE_ID:?'APPLE_ID env var required (your Apple ID email)'}"
APP_PASSWORD="${APP_PASSWORD:?'APP_PASSWORD env var required (app-specific password from appleid.apple.com)'}"

SKIP_NOTARIZATION="${SKIP_NOTARIZATION:-false}"

mkdir -p "${OUTPUT_DIR}"

# ── 0. Bump patch version ─────────────────────────────────────────────────────
echo "▶ Bumping patch version..."
CURRENT=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": *"\(.*\)",*/\1/')
MAJOR=$(echo "$CURRENT" | cut -d. -f1)
MINOR=$(echo "$CURRENT" | cut -d. -f2)
PATCH=$(echo "$CURRENT" | cut -d. -f3)
NEW="$MAJOR.$MINOR.$((PATCH + 1))"
ORIGINAL="$CURRENT"
CURRENT_ESC=$(echo "$CURRENT" | sed 's/\./\\./g')
NEW_ESC=$(echo "$NEW" | sed 's/\./\\./g')
sed -i '' "s/\"version\": \"$CURRENT_ESC\"/\"version\": \"$NEW\"/" "${PROJECT_DIR}/src-tauri/tauri.conf.json"
sed -i '' "s/\"version\": \"$CURRENT_ESC\"/\"version\": \"$NEW\"/" "${PROJECT_DIR}/package.json"
sed -i '' "s/^version = \"$CURRENT_ESC\"/version = \"$NEW\"/" "${PROJECT_DIR}/src-tauri/Cargo.toml"
echo "  Version bumped: ${CURRENT} → ${NEW}"

# Rollback version if anything fails after this point
trap 'if [ $? -ne 0 ]; then
  sed -i "" "s/\"version\": \"$NEW_ESC\"/\"version\": \"$ORIGINAL\"/" "${PROJECT_DIR}/src-tauri/tauri.conf.json"
  sed -i "" "s/\"version\": \"$NEW_ESC\"/\"version\": \"$ORIGINAL\"/" "${PROJECT_DIR}/package.json"
  sed -i "" "s/^version = \"$NEW_ESC\"/version = \"$ORIGINAL\"/" "${PROJECT_DIR}/src-tauri/Cargo.toml"
  echo "  Version restored to ${ORIGINAL} (build failed)"
fi' EXIT

# ── 1. Build ──────────────────────────────────────────────────────────────────
echo "▶ Building ${APP_NAME} (release + native SIMD)..."
# --bundles app — only produce the .app, skip Tauri's own DMG/pkg (we make ours below)
RUSTFLAGS="-C target-cpu=native" bunx tauri build --bundles app

# ── 2. Read version from the built Info.plist ─────────────────────────────────
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
	"${APP_BUNDLE}/Contents/Info.plist")
BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" \
	"${APP_BUNDLE}/Contents/Info.plist")
echo "▶ Version ${VERSION} (build ${BUILD})"

# ── 3. Sign the .app ─────────────────────────────────────────────────────────
echo "▶ Signing ${APP_NAME}.app..."
codesign \
	--sign "Developer ID Application: Roman Volkov (${DEVELOPER_ID})" \
	--force --options runtime --timestamp --deep \
	"${APP_BUNDLE}"

echo "▶ Verifying signature..."
codesign --verify --verbose "${APP_BUNDLE}"

# ── 4. Create DMG ─────────────────────────────────────────────────────────────
echo "▶ Creating DMG..."

DMG_TMP="${OUTPUT_DIR}/${APP_NAME}_tmp.dmg"
DMG_PATH="${OUTPUT_DIR}/${APP_NAME}.dmg"

# Size: actual .app size + 30 MB headroom for the Applications symlink / layout
APP_SIZE_MB=$(du -sm "${APP_BUNDLE}" | cut -f1)
DMG_SIZE_MB=$((APP_SIZE_MB + 30))

MOUNT_POINT=$(mktemp -d)
trap 'hdiutil detach "${MOUNT_POINT}" 2>/dev/null || true; rm -rf "${MOUNT_POINT}" "${DMG_TMP}"' EXIT

hdiutil create -fs HFS+ -size "${DMG_SIZE_MB}m" -volname "${APP_NAME}" "${DMG_TMP}"
hdiutil attach "${DMG_TMP}" -mountpoint "${MOUNT_POINT}"
cp -R "${APP_BUNDLE}" "${MOUNT_POINT}/"
ln -s /Applications "${MOUNT_POINT}/Applications"
hdiutil detach "${MOUNT_POINT}"

rm -f "${DMG_PATH}"
hdiutil convert "${DMG_TMP}" -format UDZO -o "${DMG_PATH}"
rm -f "${DMG_TMP}"

trap - EXIT
rm -rf "${MOUNT_POINT}"

# ── 5. Sign the DMG ───────────────────────────────────────────────────────────
if [ "${SKIP_NOTARIZATION}" != "true" ]; then
  echo "▶ Signing DMG..."
  codesign \
    --sign "Developer ID Application: Roman Volkov (${DEVELOPER_ID})" \
    --timestamp --options runtime \
    "${DMG_PATH}"
fi

# ── 6. Notarize ───────────────────────────────────────────────────────────────
if [ "${SKIP_NOTARIZATION}" = "true" ]; then
    echo "▶ Skipping notarization as requested."
else
    echo "▶ Submitting ${APP_NAME}.dmg for notarization..."
    xcrun notarytool submit "${DMG_PATH}" \
        --apple-id "${APPLE_ID}" \
        --password "${APP_PASSWORD}" \
        --team-id "${DEVELOPER_ID}" \
        --output-format json > /tmp/darkslide_submission.json

    SUBMISSION_ID=$(grep -o '"id" *: *"[^"]*"' /tmp/darkslide_submission.json | head -1 | cut -d'"' -f4)
    echo "▶ Submission ID: ${SUBMISSION_ID}"

    while true; do
        xcrun notarytool info "${SUBMISSION_ID}" \
            --apple-id "${APPLE_ID}" \
            --password "${APP_PASSWORD}" \
            --team-id "${DEVELOPER_ID}" \
            --output-format json > /tmp/darkslide_status.json

        STATUS=$(grep -o '"status" *: *"[^"]*"' /tmp/darkslide_status.json | head -1 | cut -d'"' -f4)

        if [ "${STATUS}" = "Accepted" ]; then
            echo "▶ Notarization accepted. Stapling ticket..."
            xcrun stapler staple "${DMG_PATH}"
            break
        elif [ "${STATUS}" = "Invalid" ] || [ "${STATUS}" = "Rejected" ]; then
            echo "✗ Notarization failed (${STATUS}):"
            cat /tmp/darkslide_status.json
            xcrun notarytool log "${SUBMISSION_ID}" \
                --apple-id "${APPLE_ID}" \
                --password "${APP_PASSWORD}" \
                --team-id "${DEVELOPER_ID}" || true
            exit 1
        else
            echo "  Status: ${STATUS} — checking again in 30s..."
            sleep 30
        fi
    done

    rm -f /tmp/darkslide_submission.json /tmp/darkslide_status.json
fi

# Verify Gatekeeper accepts the notarized DMG.
if [ "${SKIP_NOTARIZATION}" != "true" ]; then
  spctl --assess --type open --context context:primary-signature --verbose "${DMG_PATH}"
  echo "  Version ${VERSION} (build ${BUILD}) — signed and notarized."
else
  echo "  Version ${VERSION} (build ${BUILD}) — signed (notarization skipped)."
fi

echo "✓ Done: ${DMG_PATH}"
