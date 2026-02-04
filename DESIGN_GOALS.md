# OpenEVT Simulator — Design Goals

## Thesis (Product Vision)
Build a rugged, one‑piece, drop‑in EMP‑hardened “black box” power unit that integrates cleanly with standard cooling, optical APS/TPS inputs, engine inlet, and common driveline interfaces (couplings/flanges/joints). Use high power‑to‑weight axial‑flux motors to reduce size, supported by inline step‑up gearing and reducers. Provide an optional PHEV expansion plug for added battery capacity, while preserving true series‑hybrid operation even without the plug.

## Objective (Primary Goal)
Answer this question: Do the audible, visual, and efficiency characteristics of an EVT‑paired ICE outweigh the classic retro sound and power capabilities of a traditional automatic‑transmission‑paired ICE?

## Simulator Goal
Build an EVT simulator **overlayed on top of the 3D SUV driving simulator**, using a second Three.js canvas. Provide a mode selector:
- 700R4 cross‑section with moving gears matching a standard 700R4 behavior.
- OpenEVT cross‑section with moving parts and powerflow visualization.

## Hardened Software Goals (Implementation Plan)
### 1) Deterministic, Inspectable Simulation Core
- Single authoritative powertrain model used by **physics, overlay animation, and audio**.
- Fixed‑timestep update and explicit input/output structs.
- No hidden “magic” state; all derived values exposed for logging.

### 2) Separation of Concerns
- **SUV world** (render/physics) stays intact.
- **EVT overlay** is a separate renderer/layer.
- **Simulation core** is UI‑agnostic and testable in isolation.

### 3) Safe Iteration & Observability
- Per‑step telemetry: RPM, kW flows, SOC, fuel rate, gear state, and efficiency (g/kWh, kWh/gal, realtime MPG).
- Presets + scenario playback (repeatable profiles).
- CSV export for offline analysis.

### 4) Audio Driven by Sim (Primary Experiment)
- Engine/drone audio keyed to simulated RPM/load (not heuristics).
- Two audio profiles:
  - “Automatic 700R4‑style” (shift events, converter slip character).
  - “EVT BSFC‑setpoint” (engine holds islands, generator‑load transients).

### 5) Modular Parameterization
- Vehicle, engine, and EVT parameters as typed structs.
- MGU parameters live inside `EVTParams`.
- Optional PHEV expansion pack modeled as additive capacity/limits.

### 6) Progressive Integration
- Start with overlay + audio tied to sim.
- Then map sim wheel torque to SUV propulsion (blended, then full).

## Core Features
### Modes
- 700R4 mode (animated gearset + conventional shift behavior).
- OpenEVT mode (animated EVT assembly + generator/motor powerflow).
- Modes/profiles are **not** split across audio and visual settings; each mode has a single spec sheet that defines both audio and visual properties.

### Configuration Parameters
#### Vehicle
- Vehicle mass
- Rolling resistance coefficients
- Axle differential ratio

#### Engine
- Displacement
- BSFC island map variables
- Throttle/load mapping inputs (APS/TPS)
- Current g/kWh and kWh/gal measurements
- Realtime MPG display output

#### EVT (includes MGU)
- MGU peak/nominal power (kW)
- Reducer ratio
- Battery SOC
- Optional battery pack expansion (PHEV plug)

#### Fuel
- Fuel tank capacity (gallons)

#### Transmission
- 700R4 gear ratios (in 700R4 mode)

### Load/Control Profiles
- Auto‑transmission emulator
- Direct 0–100% throttle mapped to BSFC load/torque map
- Engine RPM calculated from generator load + traction torque demand

## Visual & UX Goals
- Clean mode selector for 700R4 vs OpenEVT
- Animated cross‑sections showing moving parts and powerflow
- Parameter panel with presets and live updates
- Clear SOC and energy flow indicators (OpenEVT mode)
- Visualize RPM drop events due to load changes (EVT generator torque demand) and 700R4 gear changes.
- Audible confirmation of RPM drop behavior, with distinct “automatic lurch” vs “EVT smooth mapping” profiles.
- SUV body motion should visibly reflect shift events; soften suspension tuning to make lurch/weight transfer noticeable.
- Be explicit that the sound and feel of shifting differ between automatic (700R4) and EVT, and that the simulator demonstrates this contrast.

## Non‑Goals (for initial phase)
- Full 3D driving game integration
- High‑fidelity thermal/EMI/EMP simulation
- Full drivetrain NVH modeling

## Milestones
1. **Overlay scaffold** inside the SUV demo (2nd Three.js canvas + EVT GUI folder)
2. **Deterministic sim core** with telemetry and presets
3. **Audio driven by sim** with profile selector (700R4 vs EVT BSFC)
4. **700R4 cross‑section** animation synced to sim gear state
5. **OpenEVT cross‑section** with powerflow + SOC visualization
6. **Torque handoff to SUV** (blended → full)
