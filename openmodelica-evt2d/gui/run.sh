#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH."
  exit 1
fi

# If Docker is configured to use Docker Desktop's credential helper, pulls can fail
# under Colima where that helper isn't present. Use a minimal local DOCKER_CONFIG.
if ! command -v docker-credential-desktop >/dev/null 2>&1; then
  if [[ -f "$HOME/.docker/config.json" ]] && grep -Eq '"credsStore"[[:space:]]*:[[:space:]]*"desktop"' "$HOME/.docker/config.json"; then
    export DOCKER_CONFIG="$ROOT/../.docker-config"
    # Preserve Colima connectivity if the active context lived in ~/.docker/config.json.
    if [[ -S "$HOME/.colima/default/docker.sock" ]]; then
      export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
    elif [[ -S "$HOME/.colima/docker.sock" ]]; then
      export DOCKER_HOST="unix://$HOME/.colima/docker.sock"
    fi
  fi
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon not reachable."
  echo "If you're using Colima: run 'colima start' then re-run this script."
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  docker-compose up --build
else
  docker compose up --build
fi
