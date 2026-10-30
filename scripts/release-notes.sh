#!/usr/bin/env bash
# Prints the notes of a GitHub release (Markdown): the commits since the previous v* tag, then how to install it.
# Used by .github/workflows/release.yml. Usage: scripts/release-notes.sh vX.Y.Z   (the tag must exist)
set -euo pipefail

tag="${1:?usage: release-notes.sh vX.Y.Z}"
version="${tag#v}"
git rev-parse -q --verify "refs/tags/$tag" >/dev/null || {
  echo "No tag $tag." >&2
  exit 1
}

previous="$(git describe --tags --abbrev=0 --match 'v*' "$tag^" 2>/dev/null || true)"
if [[ -n "$previous" ]]; then
  echo "## Changes since $previous"
  echo
  git log --no-merges --reverse --pretty='format:- %s (%h)' "$previous..$tag"
  echo
else
  echo "## First release"
  echo
  echo "The first packaged release of research ($(git rev-list --no-merges --count "$tag") commits)."
fi

cat <<NOTES

## Install or update

Linux x86_64. Downloads the AppImage, checks its SHA-256 and installs it to \`~/Applications/research.AppImage\` with a launcher and the icon:

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/LaloHao/research/$tag/scripts/install-appimage.sh | bash -s -- --release $tag
\`\`\`

Or by hand: download \`research-$version-x86_64.AppImage\` and its \`.sha256\` below, check it with \`sha256sum -c research-$version-x86_64.AppImage.sha256\`, make it executable and run it. Quit a running copy first (tray → «Salir», or Ctrl+Q).
NOTES
