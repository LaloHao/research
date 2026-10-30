#!/usr/bin/env bash
# Installs research's AppImage for the current user:
#   ~/Applications/research.AppImage                       (a stable path: the launcher and autostart keep working after updates)
#   ~/.local/share/applications/research.desktop           (the launcher entry)
#   ~/.local/share/icons/hicolor/<size>/apps/research.png  (the icon, also used by the autostart entry)
#
# Usage:
#   scripts/install-appimage.sh [path/to/research-*.AppImage]   the one built by `pnpm dist` (default: the newest in dist/)
#   scripts/install-appimage.sh --release [vX.Y.Z]              downloads it from the GitHub releases (default: the latest),
#                                                               checks its SHA-256, then installs it the same way
#
# Release mode needs curl and sha256sum. It also works without a checkout:
#   curl -fsSL https://raw.githubusercontent.com/LaloHao/research/master/scripts/install-appimage.sh | bash -s -- --release
# RESEARCH_RELEASE_BASE (the download base, <base>/<tag>/<file>) and RESEARCH_RELEASE_API (the repository's API URL,
# <api>/releases/latest) point it elsewhere, e.g. at file:// URLs for the tests.
set -euo pipefail

REPO_SLUG="LaloHao/research"
release_base="${RESEARCH_RELEASE_BASE:-https://github.com/$REPO_SLUG/releases/download}"
release_api="${RESEARCH_RELEASE_API:-https://api.github.com/repos/$REPO_SLUG}"

die() {
  echo "$*" >&2
  exit 1
}

usage() {
  if [[ -f "${BASH_SOURCE[0]:-}" ]]; then
    sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  else
    echo "Usage: install-appimage.sh [path/to/research-*.AppImage] | --release [vX.Y.Z]"
  fi
}

# The checkout this script lives in, if any (piped through `bash -s` there is none).
repo=""
if [[ -f "${BASH_SOURCE[0]:-}" ]]; then
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

mode=local
src=""
tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      mode=release
      if [[ $# -gt 1 && "$2" != -* ]]; then
        tag="$2"
        shift
      fi
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "Unknown option: $1 (see --help)" ;;
    *)
      [[ -z "$src" ]] || die "Only one AppImage can be installed at a time."
      src="$1"
      ;;
  esac
  shift
done
[[ "$mode" == local || -z "$src" ]] || die "--release downloads the AppImage: don't pass a path too."

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  if [[ -n "${tmp:-}" ]]; then rm -f "$tmp"; fi
  if [[ -n "${launcher_tmp:-}" ]]; then rm -f "$launcher_tmp"; fi
}
trap cleanup EXIT

# Only https (and file://, for the tests) — never a plain-http redirect.
fetch() {
  curl -fsSL --proto '=https,file' --proto-redir '=https' --retry 3 -o "$2" "$1"
}

if [[ "$mode" == release ]]; then
  command -v curl >/dev/null || die "--release needs curl."
  command -v sha256sum >/dev/null || die "--release needs sha256sum (coreutils)."
  [[ "$(uname -m)" == x86_64 ]] || die "The releases only have an x86_64 AppImage; this machine is $(uname -m)."

  if [[ -z "$tag" ]]; then
    fetch "$release_api/releases/latest" "$work/latest.json" || die "Could not ask GitHub for the latest release ($release_api/releases/latest)."
    tag="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$work/latest.json" | head -n 1)"
    [[ -n "$tag" ]] || die "The latest release has no tag (is there a published release yet?)."
  fi
  [[ "$tag" == v* ]] || tag="v$tag"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || die "Not a release tag: $tag (expected vX.Y.Z)."
  version="${tag#v}"
  name="research-$version-x86_64.AppImage"

  echo "Downloading $name ($tag)…"
  fetch "$release_base/$tag/$name.sha256" "$work/$name.sha256" || die "Could not download $release_base/$tag/$name.sha256 (does release $tag exist?)."
  fetch "$release_base/$tag/$name" "$work/$name" || die "Could not download $release_base/$tag/$name."

  expected="$(awk 'NR == 1 { print tolower($1) }' "$work/$name.sha256")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "$name.sha256 does not hold a SHA-256 checksum."
  actual="$(sha256sum "$work/$name" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] || die "Checksum mismatch for $name: expected $expected, got $actual. Nothing was installed."
  echo "Checksum OK ($actual)."
  src="$work/$name"
else
  if [[ -z "$src" && -n "$repo" ]]; then
    src="$(ls -t "$repo"/dist/research-*.AppImage 2>/dev/null | head -n 1 || true)"
  fi
  if [[ -z "$src" || ! -f "$src" ]]; then
    die "No AppImage found: run 'pnpm dist' first (or pass its path), or install a release with --release."
  fi
fi

apps_dir="$HOME/Applications"
target="$apps_dir/research.AppImage"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
launcher_dir="$data_home/applications"
icons_dir="$data_home/icons/hicolor"

mkdir -p "$apps_dir" "$launcher_dir"

# Atomic replace: copy next to the target, then rename over it. A running copy keeps its (now unlinked) file.
tmp="$(mktemp "$apps_dir/.research.AppImage.XXXXXX")"
cp "$src" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$target"
tmp=""

# The icons come from the AppImage itself (so they match the version installed, with or without a checkout); the
# checkout's resources/icons are the fallback.
icons_src=""
if (cd "$work" && "$target" --appimage-extract 'resources/resources/icons/*' >/dev/null 2>&1) && [[ -d "$work/squashfs-root/resources/resources/icons" ]]; then
  icons_src="$work/squashfs-root/resources/resources/icons"
elif [[ -n "$repo" && -d "$repo/resources/icons" ]]; then
  icons_src="$repo/resources/icons"
fi
for size in 16 22 24 32 48 64 128 256 512; do
  [[ -n "$icons_src" ]] || break
  icon="$icons_src/icon-$size.png"
  [[ -f "$icon" ]] || continue
  mkdir -p "$icons_dir/${size}x${size}/apps"
  cp "$icon" "$icons_dir/${size}x${size}/apps/research.png"
done
# The icon cache only exists on some desktops; a missing tool is fine.
gtk-update-icon-cache -q -t "$icons_dir" 2>/dev/null || true

# Exec is quoted (the Desktop Entry way) in case $HOME has spaces: `\`, `"`, `` ` `` and `$` escaped inside the quotes,
# then every backslash doubled (the spec's string escape) and `%` doubled (it starts field codes).
exec_path="$(printf '%s' "$target" | sed -e 's/[\\"`$]/\\&/g' -e 's/\\/\\\\/g' -e 's/%/%%/g')"
launcher="$launcher_dir/research.desktop"
launcher_tmp="$(mktemp "$launcher_dir/.research.desktop.XXXXXX")"
cat > "$launcher_tmp" <<EOF
[Desktop Entry]
Type=Application
Name=research
Comment=Paper library and thesis research
Exec="$exec_path"
Icon=research
Terminal=false
Categories=Office;
StartupWMClass=research
EOF
chmod 644 "$launcher_tmp"
mv -f "$launcher_tmp" "$launcher"
launcher_tmp=""
update-desktop-database -q "$launcher_dir" 2>/dev/null || true

if [[ "$mode" == release ]]; then
  update_hint="run this script again with --release (or --release vX.Y.Z for a given version)."
else
  update_hint="git pull, pnpm install, pnpm dist, then run this script again (or install a release with --release)."
fi

cat <<EOF
Installed${tag:+ $tag}:
  $target
  $launcher
  $icons_dir/<size>/apps/research.png

Next steps:
  - Launch «research» from the application menu (or run $target).
  - To start it with the session: in the app, Ajustes → Aplicación → «Iniciar con la sesión».
    Turn it on from this installed copy: the entry points to $target, which updates keep in place.
  - To update: $update_hint
    Quit the app first (tray → Salir, or Ctrl+Q) so the next launch runs the new version.
EOF
