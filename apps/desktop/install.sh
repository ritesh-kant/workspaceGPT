#!/bin/sh
# WorkspaceGPT Desktop installer (macOS).
#
#   curl -fsSL https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.sh | sh
#
# Reads the same latest.json the in-app updater reads, downloads this Mac's
# build with curl, checks its SHA-256 against the release's SHA256SUMS.txt,
# and installs WorkspaceGPT.app into /Applications (or ~/Applications when
# /Applications isn't writable). The app is ad-hoc signed, not notarized:
# curl sets no quarantine flag, so Gatekeeper doesn't block it, and the
# updater downloads the same way afterwards.
#
# Environment: WGPT_INSTALL_DIR overrides the install folder,
# WGPT_MANIFEST_URL the latest.json location (release testing).
set -eu

MANIFEST_URL="${WGPT_MANIFEST_URL:-https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/latest.json}"
APP_NAME="WorkspaceGPT.app"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS; see the release page for other platforms"
case "$(uname -m)" in
  arm64) PLATFORM="darwin-aarch64" ;;
  x86_64)
    # An Intel shell under Rosetta on Apple Silicon still wants the arm64 build.
    if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then PLATFORM="darwin-aarch64"; else PLATFORM="darwin-x86_64"; fi ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$MAJOR" -ge 12 ] || die "macOS 12 or later is required (this Mac has $(sw_vers -productVersion))"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

curl -fsSL "$MANIFEST_URL" -o "$TMP/latest.json" || die "could not download $MANIFEST_URL"
# plutil reads JSON on every supported macOS: no jq or python needed.
VERSION="$(plutil -extract version raw -o - "$TMP/latest.json")" || die "latest.json has no version"
URL="$(plutil -extract "platforms.$PLATFORM.url" raw -o - "$TMP/latest.json" 2>/dev/null)" || die "no $PLATFORM build in release $VERSION"
FILE="${URL##*/}"
BASE="${URL%/*}"

# Keep this file ASCII and brace variables before text: macOS /bin/sh (bash 3.2)
# in a UTF-8 locale reads a following multibyte character as part of the name.
say "Downloading WorkspaceGPT ${VERSION} for ${PLATFORM}..."
curl -fL --progress-bar "$URL" -o "$TMP/$FILE" || die "download failed: $URL"
curl -fsSL "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt" || die "could not download $BASE/SHA256SUMS.txt"
EXPECTED="$(awk -v f="$FILE" '$2 == f || $2 == "*"f { print $1 }' "$TMP/SHA256SUMS.txt")"
[ -n "$EXPECTED" ] || die "$FILE is not listed in SHA256SUMS.txt"
ACTUAL="$(shasum -a 256 "$TMP/$FILE" | awk '{ print $1 }')"
[ "$ACTUAL" = "$EXPECTED" ] || die "checksum mismatch for $FILE (got $ACTUAL, expected $EXPECTED)"

mkdir -p "$TMP/app"
tar -xzf "$TMP/$FILE" -C "$TMP/app"
[ -d "$TMP/app/$APP_NAME" ] || die "$FILE does not contain $APP_NAME"
# Verified before the installed copy is touched, so a bad bundle leaves it as it was.
codesign --verify --deep --strict "$TMP/app/$APP_NAME" 2>/dev/null || die "$FILE failed signature verification; nothing was installed"

if [ -n "${WGPT_INSTALL_DIR:-}" ]; then
  DEST="$WGPT_INSTALL_DIR"
elif [ -w /Applications ]; then
  DEST="/Applications"
else
  DEST="$HOME/Applications"
fi
mkdir -p "$DEST"

if pgrep -f "$DEST/$APP_NAME/Contents/MacOS/" >/dev/null 2>&1; then
  die "WorkspaceGPT is running from $DEST; quit it and run the installer again"
fi
if [ -e "$DEST/$APP_NAME" ]; then
  rm -rf "$DEST/$APP_NAME.previous"
  mv "$DEST/$APP_NAME" "$DEST/$APP_NAME.previous"
fi
# Put the previous app back if the copy fails (disk full) or doesn't verify.
restore_previous() {
  rm -rf "$DEST/$APP_NAME"
  [ -e "$DEST/$APP_NAME.previous" ] && mv "$DEST/$APP_NAME.previous" "$DEST/$APP_NAME"
  die "$1"
}
ditto "$TMP/app/$APP_NAME" "$DEST/$APP_NAME" || restore_previous "could not copy $APP_NAME to $DEST; the previous version was kept"
# Belt and braces: a copy that arrived some other way may carry the flag.
xattr -dr com.apple.quarantine "$DEST/$APP_NAME" 2>/dev/null || true
codesign --verify --deep --strict "$DEST/$APP_NAME" 2>/dev/null || restore_previous "$DEST/$APP_NAME failed signature verification; the previous version was kept"
rm -rf "$DEST/$APP_NAME.previous"

say "Installed WorkspaceGPT $VERSION to $DEST/$APP_NAME"
say "Open it from Launchpad or: open \"$DEST/$APP_NAME\""
