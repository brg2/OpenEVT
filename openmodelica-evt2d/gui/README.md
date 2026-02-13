# OMEdit in Docker (VNC / noVNC) — macOS Apple Silicon

This runs **OMEdit** (OpenModelica GUI) inside Linux and exposes the desktop via **VNC**.

## Start

From `/Users/brett/Projects/OpenEVT/openmodelica-evt2d/gui`:

```sh
./run.sh
```

If you run `docker-compose up --build` directly and see `docker-credential-desktop` errors under Colima, use `./run.sh` (it sets a minimal `DOCKER_CONFIG` automatically), or run:

```sh
DOCKER_CONFIG=/Users/brett/Projects/OpenEVT/openmodelica-evt2d/.docker-config \
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock \
docker-compose up --build
```

Also ensure the Colima daemon is running:

```sh
colima start
```

## Connect (VNC)

- Host: `127.0.0.1`
- Port: `5901`

## Password (recommended)

Set `VNC_PASSWORD` before starting:

```sh
VNC_PASSWORD='change-me' docker-compose up --build
```

## Notes

- The project directory is mounted at `/work`, so you can open `OpenEVT.mo` directly in OMEdit.
- In OMEdit: `File → Open Model/Library File(s)…` and enter `/work/OpenEVT.mo` (it’s a local package file, not a pre-installed library).
- If you want browser-based access later, we can add a noVNC sidecar (or enable it in this container).
