#!/usr/bin/env bash
# Renders the PNGs of the app and tray icons from their SVG sources in resources/ (commit the results).
# Needs inkscape or rsvg-convert; works offline.
set -euo pipefail
cd "$(dirname "$0")/../resources"

render() { # svg, size, png
  if command -v rsvg-convert >/dev/null; then
    rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
  else
    inkscape "$1" --export-type=png --export-width="$2" --export-height="$2" --export-filename="$3" >/dev/null 2>&1
  fi
}

mkdir -p icons tray
for size in 16 22 24 32 48 64 128 256 512; do
  render icon.svg "$size" "icons/icon-$size.png"
done
for name in tray tray-busy tray-attention; do
  for size in 16 22 24 32 48 64; do
    render "$name.svg" "$size" "tray/$name-$size.png"
  done
done
