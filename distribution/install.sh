#!/bin/sh
# Modified for AI Hub: independent app release feed, install identity and paths.
# Installs AI Hub, and herdr-core if there's none yet:
#
#   curl -fsSL https://github.com/q1926313-art/AI-HUB/releases/latest/download/install.sh | sh
#
# Linux: the app into ~/.local/share/ai-hub, `herdr-app` in ~/.local/bin,
# a launcher entry and icon. macOS: AI Hub.app into ~/Applications, keeping
# its release signature intact (ad hoc for unsigned/dev builds). The core, with its
# own installer, into ~/.local/bin/herdr-core (and `hc`) only if none is
# there yet; the app
# keeps it current after that. Running it again updates the app.
set -eu

releases=${AI_HUB_RELEASES_URL:-https://github.com/q1926313-art/AI-HUB/releases/latest/download}
core_releases=${HERDR_RELEASES_URL:-https://releases.herdr.dev}
bin="$HOME/.local/bin"

say() { printf '%s\n' "$*"; }
fail() { say "AI Hub: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs $1"; }
need curl
need tar

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  MINGW* | MSYS* | CYGWIN*) fail "this installer is for Linux and macOS; on Windows, run this in PowerShell: irm $releases/install.ps1 | iex" ;;
  *) fail "no build for $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) fail "no build for $(uname -m)" ;;
esac
if [ "$os" = macos ] && [ "$arch" = x86_64 ]; then
  # Rosetta reports x86_64 even on Apple Silicon.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] ||
     [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=aarch64
  else
    fail "Intel Macs aren't supported; build from source: https://github.com/q1926313-art/AI-HUB#build-from-source"
  fi
fi
target="$os-$arch"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$releases/latest.json" -o "$tmp/latest.json" || fail "cannot reach $releases"
# Read without jq: the manifest is flat enough for sed once spaces are gone.
entry=$(tr -d '\n ' < "$tmp/latest.json" | sed -n "s/.*\"$target\":{\([^}]*\)}.*/\1/p")
url=$(printf '%s' "$entry" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
want=$(printf '%s' "$entry" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')
version=$(tr -d '\n ' < "$tmp/latest.json" | sed -n 's/^{"version":"\([^"]*\)".*/\1/p')
[ -n "$url" ] && [ -n "$want" ] || fail "no build for $target yet"

# Release assets are immutable URLs; do not add upstream download tracking.
say "Installing AI Hub ${version:-} for $target..."
curl -fsSL "$url" -o "$tmp/app.tar.gz" || fail "download failed"
[ "$(sha256 "$tmp/app.tar.gz")" = "$want" ] || fail "download is damaged (checksum mismatch); try again"
tar -xzf "$tmp/app.tar.gz" -C "$tmp"
mkdir -p "$bin"

if [ "$os" = linux ]; then
  data=${XDG_DATA_HOME:-$HOME/.local/share}
  app_home="$data/ai-hub"
  mkdir -p "$data"
  rm -rf "$app_home.new"
  mv "$tmp/herdr-app" "$app_home.new"
  rm -rf "$app_home"
  mv "$app_home.new" "$app_home"
  ln -sfn "$app_home/herdr-app" "$bin/herdr-app"
  mkdir -p "$data/applications" "$data/icons/hicolor/scalable/apps"
  cp "$app_home/herdr-app.svg" "$data/icons/hicolor/scalable/apps/ai-hub.svg"
  cat > "$data/applications/ai-hub.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=AI Hub
Comment=Terminals and coding agents that keep running
Exec=$bin/herdr-app
Icon=ai-hub
Terminal=false
Categories=Development;
StartupWMClass=ai-hub
EOF
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$data/applications" 2>/dev/null || true
  [ -f "$data/icons/hicolor/icon-theme.cache" ] && gtk-update-icon-cache -f -t "$data/icons/hicolor" >/dev/null 2>&1 || true
  # Plasma remembers a missing icon until it is told the theme changed,
  # so a fresh install shows an empty page in the taskbar.
  command -v dbus-send >/dev/null 2>&1 &&
    dbus-send --session --type=signal /KIconLoader org.kde.KIconLoader.iconChanged int32:0 2>/dev/null || true
else
  apps="$HOME/Applications"
  app="$apps/AI Hub.app"
  mkdir -p "$apps"
  # Prepared in the temp folder, so Spotlight never indexes a half-made
  # bundle under a temporary name in Applications.
  # Never change a certificate-signed bundle: macOS permissions follow its
  # signing identity. Only unsigned/ad-hoc development builds need this PATH.
  signed=false
  if signature=$(/usr/bin/codesign -dvv "$tmp/Herdr.app" 2>&1); then
    if printf '%s\n' "$signature" | grep -q '^Authority=Developer ID Application:'; then
      signed=true
    elif ! printf '%s\n' "$signature" | grep -qx 'Signature=adhoc'; then
      fail "cannot determine app signature: $signature"
    fi
  elif ! printf '%s\n' "$signature" | grep -q ': code object is not signed at all$'; then
    fail "cannot determine app signature: $signature"
  fi
  if [ "$signed" = true ]; then
    /usr/bin/codesign --verify --deep --strict "$tmp/Herdr.app" || fail "invalid app signature"
  else
    /usr/libexec/PlistBuddy -c "Add :LSEnvironment:PATH string $bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" "$tmp/Herdr.app/Contents/Info.plist"
    /usr/bin/codesign --force --sign - "$tmp/Herdr.app" >/dev/null 2>&1
  fi
  rm -rf "$app"
  mv "$tmp/Herdr.app" "$app"
  ln -sfn "$app/Contents/MacOS/Herdr" "$bin/herdr-app"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" 2>/dev/null || true
fi

# The core: installed only if there's none yet. One that's already there
# (yours, or from a package manager) is left alone; the app updates it.
if [ ! -e "$bin/herdr-core" ] && ! command -v herdr-core >/dev/null 2>&1; then
  curl -fsSL "$core_releases/core/install.sh" | HC_INSTALL_DIR="$bin" HERDR_RELEASES_URL="$core_releases" sh || say "herdr-core didn't install; AI Hub will offer it when it opens."
fi

say "AI Hub is installed. Open it from your apps, or run: herdr-app"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) say "Add $bin to your PATH to use herdr-app and hc from a terminal." ;;
esac
