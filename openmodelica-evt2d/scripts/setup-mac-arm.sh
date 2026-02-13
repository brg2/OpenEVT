#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install Homebrew first, then re-run."
  exit 1
fi

brew install docker colima

if ! command -v colima >/dev/null 2>&1; then
  echo "colima not found after install."
  exit 1
fi

colima start

docker version

