#!/usr/bin/env bash
# Print the CHANGELOG.md section of one version. Exit 1 when the section is missing or empty.
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:?Usage: scripts/release-notes.sh <version>}"
notes="$(awk -v v="$version" '$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ {f=0} f' CHANGELOG.md)"
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md has no notes for ${version}." >&2
  exit 1
fi
printf '%s\n' "$notes"
