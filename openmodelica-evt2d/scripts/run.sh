#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH."
  echo "Install Docker Desktop (Apple Silicon) or run: brew install docker colima && colima start"
  exit 1
fi

# If the user's Docker config is wired to Docker Desktop's credential helper
# (common on macOS), pulls can fail under Colima where that helper isn't present.
# Use a minimal local DOCKER_CONFIG for public pulls in that case.
DOCKER_CONFIG_ARGS=()
if ! command -v docker-credential-desktop >/dev/null 2>&1; then
  if [[ -f "$HOME/.docker/config.json" ]] && grep -Eq '"credsStore"[[:space:]]*:[[:space:]]*"desktop"' "$HOME/.docker/config.json"; then
    DOCKER_CONFIG_ARGS=(env DOCKER_CONFIG="$ROOT/.docker-config")
    # Preserve Colima connectivity even with a separate DOCKER_CONFIG (which would otherwise
    # drop the configured Docker context).
    if [[ -S "$HOME/.colima/default/docker.sock" ]]; then
      DOCKER_CONFIG_ARGS+=(DOCKER_HOST="unix://$HOME/.colima/default/docker.sock")
    elif [[ -S "$HOME/.colima/docker.sock" ]]; then
      DOCKER_CONFIG_ARGS+=(DOCKER_HOST="unix://$HOME/.colima/docker.sock")
    fi
  fi
fi

# You can override this if you want a different tag.
OM_IMAGE="${OM_IMAGE:-openmodelica/openmodelica:v1.26.1-minimal}"

PLATFORM_ARGS=()
if [[ -n "${OM_PLATFORM:-}" ]]; then
  PLATFORM_ARGS+=(--platform "$OM_PLATFORM")
fi

if [[ ${#PLATFORM_ARGS[@]} -gt 0 ]]; then
  "${DOCKER_CONFIG_ARGS[@]}" docker run --rm \
    "${PLATFORM_ARGS[@]}" \
    -v "$ROOT:/work" \
    -w /work \
    "$OM_IMAGE" \
    omc scripts/run.mos
else
  "${DOCKER_CONFIG_ARGS[@]}" docker run --rm \
    -v "$ROOT:/work" \
    -w /work \
    "$OM_IMAGE" \
    omc scripts/run.mos
fi
