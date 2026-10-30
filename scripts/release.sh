#!/usr/bin/env bash
# Cuts a release: sets package.json's version, commits it and tags vX.Y.Z. Pushing the tag (printed at the end, not
# done here) makes .github/workflows/release.yml build the AppImage and publish the GitHub release.
# Usage: scripts/release.sh X.Y.Z   (from a clean master)
set -euo pipefail

die() {
  echo "$*" >&2
  exit 1
}

version="${1:-}"
version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "Usage: scripts/release.sh X.Y.Z (got '${1:-}')"
tag="v$version"

cd "$(dirname "$0")/.."
[[ "$(git branch --show-current)" == master ]] || die "Release from master (this is '$(git branch --show-current)')."
# Untracked files (local notes, specs and plans that are never committed) do not count.
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "The working tree has changes: commit or stash them first."
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "Tag $tag already exists."

current="$(node -p "require('./package.json').version")"
[[ "$current" != "$version" ]] || die "package.json is already at $version."
# Only a newer version: sort -V puts the higher one last.
[[ "$(printf '%s\n%s\n' "$current" "$version" | sort -V | tail -n 1)" == "$version" ]] || die "$version is not newer than $current."

# Only the "version" line changes, the rest of package.json keeps its formatting.
# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const fs = require("fs")
  const text = fs.readFileSync("package.json", "utf8")
  const next = text.replace(/^(  "version": )"[^"]*"/m, `$1"${process.argv[1]}"`)
  if (next === text) throw new Error("No version line in package.json")
  fs.writeFileSync("package.json", next)
' "$version"

git add package.json
git commit -q -m "Release $tag"
git tag -a "$tag" -m "research $tag"

cat <<MSG
Committed «Release $tag» and tagged $tag (nothing pushed yet).
Publish it with:
  git push origin master
  git push origin $tag
The Release workflow then checks, builds the AppImage and publishes the GitHub release for $tag.
To undo before pushing: git tag -d $tag && git reset --hard HEAD~1
MSG
