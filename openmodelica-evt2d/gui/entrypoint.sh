#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"
export VNC_PORT="${VNC_PORT:-5900}"
export VNC_GEOMETRY="${VNC_GEOMETRY:-1920x1080}"
export VNC_DEPTH="${VNC_DEPTH:-24}"

OMUSER_HOME="/home/omuser"
export HOME="$OMUSER_HOME"
export USER="omuser"

mkdir -p "$OMUSER_HOME/.openmodelica/libraries"
mkdir -p "$OMUSER_HOME/.vnc"
chown -R omuser:omuser "$OMUSER_HOME/.openmodelica" "$OMUSER_HOME/.vnc" /tmp || true

if [[ -n "${VNC_PASSWORD:-}" ]]; then
  x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null
fi

if ! ls -1 /home/omuser/.openmodelica/libraries 2>/dev/null | grep -qi '^Modelica' ; then
  echo "Bootstrapping Modelica Standard Library (MSL)..." >&2
  su - omuser -c 'omc /bootstrap.mos' || true
fi

exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/supervisord.conf
