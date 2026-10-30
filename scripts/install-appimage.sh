#!/usr/bin/env bash
# Installs the AppImage built by `pnpm dist` for the current user:
#   ~/Applications/research.AppImage                       (a stable path: the launcher and autostart keep working after updates)
#   ~/.local/share/applications/research.desktop           (the launcher entry)
#   ~/.local/share/icons/hicolor/<size>/apps/research.png  (the icon, also used by the autostart entry)
# Usage: scripts/install-appimage.sh [path/to/research-*.AppImage]   (default: the newest one in dist/)
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
src="${1:-}"
if [[ -z "$src" ]]; then
  src="$(ls -t "$repo"/dist/research-*.AppImage 2>/dev/null | head -n 1 || true)"
fi
if [[ -z "$src" || ! -f "$src" ]]; then
  echo "No AppImage found: run 'pnpm dist' first (or pass its path)." >&2
  exit 1
fi

apps_dir="$HOME/Applications"
target="$apps_dir/research.AppImage"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
launcher_dir="$data_home/applications"
icons_dir="$data_home/icons/hicolor"

mkdir -p "$apps_dir" "$launcher_dir"

# Atomic replace: copy next to the target, then rename over it. A running copy keeps its (now unlinked) file.
tmp="$(mktemp "$apps_dir/.research.AppImage.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cp "$src" "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$target"
trap - EXIT

for size in 16 22 24 32 48 64 128 256 512; do
  icon="$repo/resources/icons/icon-$size.png"
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
update-desktop-database -q "$launcher_dir" 2>/dev/null || true

cat <<EOF
Installed:
  $target
  $launcher
  $icons_dir/<size>/apps/research.png

Next steps:
  - Launch «research» from the application menu (or run $target).
  - To start it with the session: in the app, Ajustes → Aplicación → «Iniciar con la sesión».
    Turn it on from this installed copy: the entry points to $target, which updates keep in place.
  - To update: git pull, pnpm install, pnpm dist, then run this script again. Quit the app first
    (tray → Salir, or Ctrl+Q) so the next launch runs the new version.
EOF
