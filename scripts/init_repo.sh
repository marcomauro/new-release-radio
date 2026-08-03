#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# One-time bootstrap: turn this folder into the standalone `new-release-radio`
# repository.
#
# The project was written inside the New Release Atlas checkout (as `radio/`)
# because that is where the archive and the data pipeline live, but it is a
# self-contained app: its own package.json, vite config, CI workflow and docs.
# This script copies it out and pushes it as its own repo.
#
#   bash scripts/init_repo.sh                                  # dry run: show what it would do
#   bash scripts/init_repo.sh https://github.com/<you>/new-release-radio.git
#
# Create the empty repository on GitHub first (no README, no .gitignore), then
# enable Settings → Pages → Source: GitHub Actions.
# ----------------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${1:-}"
TARGET="${2:-$(cd "$HERE/../.." && pwd)/new-release-radio}"

echo "source : $HERE"
echo "target : $TARGET"
echo "remote : ${REMOTE:-(none — dry run)}"
echo

if [ -e "$TARGET" ]; then
  echo "! $TARGET already exists — remove it or pass another target path." >&2
  exit 1
fi

if [ -z "$REMOTE" ]; then
  echo "Dry run. Re-run with the repository URL to actually create and push:"
  echo "  bash scripts/init_repo.sh https://github.com/<you>/new-release-radio.git"
  exit 0
fi

mkdir -p "$TARGET"
# Everything except build output and dependencies; .github must come along.
tar -C "$HERE" \
  --exclude=node_modules --exclude=dist --exclude=dev-dist \
  --exclude='public/graph.json.bak' --exclude=.git \
  -cf - . | tar -C "$TARGET" -xf -

cd "$TARGET"
git init -b main
git add -A
git commit -m "New Release Radio: endless walk over the New Release Atlas archive

An endless radio over the Atlas archive: the walk starts from one track and
follows the graph (shared artist, shared genre, same playlist) one step at a
time. Rules live in src/core/rules.js; playback is behind a provider contract
so Spotify can be replaced. Minimalist, cover-first interface."
git remote add origin "$REMOTE"
git push -u origin main

echo
echo "Pushed. Now: Settings → Pages → Source: GitHub Actions."
echo "For Spotify Connect, register the Pages URL as a redirect URI (see README)."
