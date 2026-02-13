# OpenEVT — OpenModelica EVT2D (Basic) port

This directory is a first port of the React `evt2d` “Basic” simulator (`/Users/brett/Projects/OpenEVT/evt2d/sim/step.ts`) into Modelica, targeting OpenModelica.

## Prereqs (Apple Silicon / arm64)

OpenModelica does **not** ship a supported native macOS arm64 build. The intended path here is Docker.

### Option A: Docker Desktop

1. Install Docker Desktop for Mac (Apple Silicon).
2. Start Docker Desktop and confirm it works:

```sh
docker version
```

### Option B: Colima (no Docker Desktop)

If you don’t want Docker Desktop, this works well on Apple Silicon:

```sh
brew install docker colima
colima start
docker version
```

## Run (Docker)

From this directory:

```sh
./scripts/run.sh
```

## OMEdit GUI (VNC/noVNC)

To run the OpenModelica GUI (OMEdit) on Apple Silicon, use the VNC-based container in:

- `/Users/brett/Projects/OpenEVT/openmodelica-evt2d/gui/README.md`

If you need to force the container architecture (should not be necessary on an M1/M2 when the image supports arm64):

```sh
OM_PLATFORM=linux/arm64 ./scripts/run.sh
```

Outputs:
- `out/evt2d.csv` (time series)
- `out/evt2d_final.txt` (final-state summary)

## What’s ported

- Vehicle longitudinal dynamics (drag/rolling/grade)
- One-pedal regen model
- Engine RPM governor + parasitic loss + RPM shaping
- Generator max power, SOC targeting behavior, lag + ramp limiting
- Battery power limits and simple bus voltage model
- Energy accounting (kWh) and limiter timers

## Notes / next steps

- The current test model uses constant `tps` and `gradePct` (parameters). We can add drive-cycle inputs (piecewise/time series) next.
- Once this stabilizes, we can split parameters into records and align config editing with the React UI.
