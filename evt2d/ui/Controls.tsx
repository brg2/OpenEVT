import React, { useEffect, useMemo, useState } from "react";
import type { SimConfig, SimInputs } from "../sim/types";
import { clamp, rpmShape } from "../sim/utils";

const COLLAPSE_KEY = "openevt-2d-collapse";
const PROFILE_KEY = "openevt-2d-profiles";

interface ControlsProps {
  inputs: SimInputs;
  config: SimConfig;
  running: boolean;
  speed: number;
  recording: boolean;
  replaying: boolean;
  onInputs: (patch: Partial<SimInputs>) => void;
  onConfig: (patch: Partial<SimConfig>) => void;
  onToggleRun: () => void;
  onReset: () => void;
  onSpeed: (speed: number) => void;
  onRecord: () => void;
  onStopRecord: () => void;
  onReplay: () => void;
  onStopReplay: () => void;
  onExport: () => void;
}

type VehicleProfileId =
  | "custom"
  | "small-car"
  | "small-suv"
  | "medium-suv"
  | "large-suv"
  | "bus";

type EngineProfileId =
  | "custom"
  | "7.4l-carb"
  | "7.4l-efi"
  | "lq4-6.0l"
  | "6bt-400kw"
  | "cummins-l9-bus"
  | "5l"
  | "3l"
  | "2.5l"
  | "2l"
  | "1.5l";

type EvtProfileId =
  | "custom"
  | "small"
  | "medium"
  | "large"
  | "heavy-duty"
  | "500kw"
  | "600kw";
type BatteryProfileId = "custom" | "lto" | "lfp" | "nmc" | "nca" | "lmo" | "lco";

const Controls: React.FC<ControlsProps> = ({
  inputs,
  config,
  running,
  speed,
  recording,
  replaying,
  onInputs,
  onConfig,
  onToggleRun,
  onReset,
  onSpeed,
  onRecord,
  onStopRecord,
  onReplay,
  onStopReplay,
  onExport,
}) => {
  const [collapse, setCollapse] = useState(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) return JSON.parse(raw) as Record<string, boolean>;
    } catch {
      // ignore
    }
    return {
      run: true,
      inputs: true,
      vehicle: true,
      engine: true,
      evt: true,
      battery: true,
    };
  });
  const [vehicleProfile, setVehicleProfile] = useState<VehicleProfileId>("custom");
  const [engineProfile, setEngineProfile] = useState<EngineProfileId>("custom");
  const [evtProfile, setEvtProfile] = useState<EvtProfileId>("custom");
  const [batteryProfile, setBatteryProfile] = useState<BatteryProfileId>("custom");

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapse));
    } catch {
      // ignore
    }
  }, [collapse]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        vehicle?: VehicleProfileId;
        engine?: EngineProfileId;
        evt?: EvtProfileId;
        battery?: BatteryProfileId;
      };
      if (parsed.vehicle) setVehicleProfile(parsed.vehicle);
      if (parsed.engine) setEngineProfile(parsed.engine);
      if (parsed.evt) setEvtProfile(parsed.evt);
      if (parsed.battery) setBatteryProfile(parsed.battery);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        PROFILE_KEY,
        JSON.stringify({
          vehicle: vehicleProfile,
          engine: engineProfile,
          evt: evtProfile,
          battery: batteryProfile,
        }),
      );
    } catch {
      // ignore
    }
  }, [vehicleProfile, engineProfile, evtProfile, batteryProfile]);

  const setOpen = (key: keyof typeof collapse, open: boolean) => {
    setCollapse((prev) => ({ ...prev, [key]: open }));
  };

  const applyVehicleProfile = (id: VehicleProfileId) => {
    if (id === "custom") return;
    const profiles: Record<Exclude<VehicleProfileId, "custom">, SimConfig["vehicle"]> = {
      "small-car": {
        ...config.vehicle,
        massKg: 1400,
        cdA: 0.58,
        cr: 0.010,
        tireDiameterIn: 25,
        diffRatio: 3.4,
      },
      "small-suv": {
        ...config.vehicle,
        massKg: 1900,
        cdA: 0.75,
        cr: 0.011,
        tireDiameterIn: 28,
        diffRatio: 3.55,
      },
      "medium-suv": {
        ...config.vehicle,
        massKg: 2300,
        cdA: 0.88,
        cr: 0.012,
        tireDiameterIn: 30,
        diffRatio: 3.73,
      },
      "large-suv": {
        ...config.vehicle,
        massKg: 2800,
        cdA: 1.02,
        cr: 0.013,
        tireDiameterIn: 32,
        diffRatio: 3.9,
      },
      bus: {
        ...config.vehicle,
        massKg: 11000,
        cdA: 2.2,
        cr: 0.014,
        tireDiameterIn: 40,
        diffRatio: 4.2,
      },
    };
    onConfig({ vehicle: profiles[id] });
  };

  const applyEngineProfile = (id: EngineProfileId) => {
    if (id === "custom") return;
    const profiles: Record<Exclude<EngineProfileId, "custom">, SimConfig["engine"]> = {
      "7.4l-carb": {
        ...config.engine,
        idleRpm: 900,
        redlineRpm: 5200,
        effRpm: 2200,
        maxPowerKw: 220,
        rpmTimeConst: 0.8,
        engineEff: 0.26,
      },
      "7.4l-efi": {
        ...config.engine,
        idleRpm: 900,
        redlineRpm: 5200,
        effRpm: 2400,
        maxPowerKw: 230,
        rpmTimeConst: 0.6,
        engineEff: 0.30,
      },
      "lq4-6.0l": {
        ...config.engine,
        idleRpm: 650,
        redlineRpm: 6000,
        effRpm: 4000,
        maxPowerKw: 240,
        rpmTimeConst: 0.55,
        engineEff: 0.30,
      },
      "6bt-400kw": {
        ...config.engine,
        idleRpm: 750,
        redlineRpm: 3200,
        effRpm: 1600,
        maxPowerKw: 400,
        rpmTimeConst: 0.9,
        engineEff: 0.38,
      },
      "cummins-l9-bus": {
        ...config.engine,
        idleRpm: 650,
        redlineRpm: 2300,
        effRpm: 1400,
        maxPowerKw: 283,
        rpmTimeConst: 0.8,
        engineEff: 0.36,
      },
      "5l": {
        ...config.engine,
        idleRpm: 850,
        redlineRpm: 5600,
        effRpm: 3500,
        maxPowerKw: 180,
        rpmTimeConst: 0.6,
        engineEff: 0.30,
      },
      "3l": {
        ...config.engine,
        idleRpm: 800,
        redlineRpm: 6000,
        effRpm: 3000,
        maxPowerKw: 140,
        rpmTimeConst: 0.55,
        engineEff: 0.32,
      },
      "2.5l": {
        ...config.engine,
        idleRpm: 800,
        redlineRpm: 6200,
        effRpm: 3200,
        maxPowerKw: 120,
        rpmTimeConst: 0.5,
        engineEff: 0.33,
      },
      "2l": {
        ...config.engine,
        idleRpm: 800,
        redlineRpm: 6500,
        effRpm: 3500,
        maxPowerKw: 105,
        rpmTimeConst: 0.45,
        engineEff: 0.34,
      },
      "1.5l": {
        ...config.engine,
        idleRpm: 800,
        redlineRpm: 6800,
        effRpm: 3800,
        maxPowerKw: 85,
        rpmTimeConst: 0.4,
        engineEff: 0.35,
      },
    };
    onConfig({ engine: profiles[id] });
  };

  const evtSweetSpotKw = useMemo(() => {
    // Static sizing guidance: electrical kW the engine can sustain at its "Eff RPM".
    const effRpmRaw = Number.isFinite(config.engine.effRpm)
      ? config.engine.effRpm
      : (config.engine.idleRpm + config.engine.redlineRpm) * 0.5;
    const effRpm = clamp(effRpmRaw, config.engine.idleRpm, config.engine.redlineRpm);
    const g = clamp(
      rpmShape(effRpm, config.engine.idleRpm, config.engine.redlineRpm, config.engine.effRpm),
      0,
      1.1,
    );
    const mechKw = config.engine.maxPowerKw * g;
    const rpmNorm = clamp(effRpm / Math.max(1, config.engine.redlineRpm), 0, 1.2);
    const parasiticKw = config.engine.maxPowerKw * (0.03 + 0.12 * rpmNorm * rpmNorm);
    const elecKw = Math.max(0, mechKw - parasiticKw) * config.generator.eff;
    return Math.max(0, elecKw);
  }, [
    config.engine.effRpm,
    config.engine.idleRpm,
    config.engine.redlineRpm,
    config.engine.maxPowerKw,
    config.generator.eff,
  ]);

  const applyEvtProfile = (id: EvtProfileId) => {
    if (id === "custom") return;
    const profiles: Record<Exclude<EvtProfileId, "custom">, Partial<SimConfig>> = {
      small: {
        vehicle: {
          ...config.vehicle,
          motorPeakPowerKw: 130,
          motorMaxRpm: 12000,
          tractionReduction: 3.2,
          regenMaxKw: 130,
        },
        generator: {
          ...config.generator,
          maxElecKw: 130,
          stepUpRatio: 2.0,
        },
      },
      medium: {
        vehicle: {
          ...config.vehicle,
          motorPeakPowerKw: 220,
          motorMaxRpm: 11000,
          tractionReduction: 2.9,
          regenMaxKw: 220,
        },
        generator: {
          ...config.generator,
          maxElecKw: 220,
          stepUpRatio: 2.2,
        },
      },
      large: {
        vehicle: {
          ...config.vehicle,
          motorPeakPowerKw: 300,
          motorMaxRpm: 10000,
          tractionReduction: 2.6,
          regenMaxKw: 300,
        },
        generator: {
          ...config.generator,
          maxElecKw: 300,
          stepUpRatio: 2.4,
        },
      },
      "heavy-duty": {
        vehicle: {
          ...config.vehicle,
          motorPeakPowerKw: 420,
          motorMaxRpm: 9000,
          tractionReduction: 2.3,
          regenMaxKw: 420,
        },
        generator: {
          ...config.generator,
          maxElecKw: 420,
          stepUpRatio: 2.6,
        },
      },
      "500kw": {
        vehicle: {
          ...config.vehicle,
          motorPeakPowerKw: 500,
          motorMaxRpm: 8500,
          tractionReduction: 2.1,
          regenMaxKw: 500,
        },
        generator: {
          ...config.generator,
          maxElecKw: 500,
          stepUpRatio: 2.8,
        },
      },
      "600kw": {
        vehicle: {
          ...config.vehicle,
          motorPeakPowerKw: 600,
          motorMaxRpm: 8000,
          tractionReduction: 2.0,
          regenMaxKw: 600,
        },
        generator: {
          ...config.generator,
          maxElecKw: 600,
          stepUpRatio: 3.0,
        },
      },
    };
    onConfig(profiles[id]);
  };

  const applyBatteryProfile = (id: BatteryProfileId) => {
    if (id === "custom") return;
    const profiles: Record<Exclude<BatteryProfileId, "custom">, SimConfig["battery"]> = {
      lto: {
        ...config.battery,
        maxDischargeKw: 300,
        maxChargeKw: 240,
        socMin: 0.1,
        socMax: 0.95,
      },
      lfp: {
        ...config.battery,
        maxDischargeKw: 200,
        maxChargeKw: 120,
        socMin: 0.08,
        socMax: 0.94,
      },
      nmc: {
        ...config.battery,
        maxDischargeKw: 240,
        maxChargeKw: 160,
        socMin: 0.06,
        socMax: 0.96,
      },
      nca: {
        ...config.battery,
        maxDischargeKw: 260,
        maxChargeKw: 170,
        socMin: 0.06,
        socMax: 0.96,
      },
      lmo: {
        ...config.battery,
        maxDischargeKw: 220,
        maxChargeKw: 130,
        socMin: 0.08,
        socMax: 0.95,
      },
      lco: {
        ...config.battery,
        maxDischargeKw: 180,
        maxChargeKw: 100,
        socMin: 0.1,
        socMax: 0.92,
      },
    };
    onConfig({ battery: profiles[id] });
  };

  return (
    <div className="controls">
      <details open={collapse.run} onToggle={(e) => setOpen("run", e.currentTarget.open)}>
        <summary>Run Controls</summary>
        <div className="control-group">
          <div className="footer-controls">
            <button className="primary" onClick={onToggleRun}>
              {running ? "Pause" : "Play"}
            </button>
            <button onClick={onReset}>Reset</button>
            <button onClick={onExport}>Export JSON</button>
          </div>
          <div className="control-row">
            <label>Speed</label>
            <div className="footer-controls">
              {[0.5, 1, 2, 5, 10, 50].map((value) => (
                <button
                  key={value}
                  className={speed === value ? "primary" : "ghost"}
                  onClick={() => onSpeed(value)}
                >
                  {value}x
                </button>
              ))}
            </div>
          </div>
          <div className="control-row">
            <label>Record</label>
            <div className="footer-controls">
              <button onClick={recording ? onStopRecord : onRecord}>
                {recording ? "Stop" : "Record"}
              </button>
              <button onClick={replaying ? onStopReplay : onReplay}>
                {replaying ? "Stop Replay" : "Replay"}
              </button>
            </div>
          </div>
        </div>
      </details>

      <details open={collapse.inputs} onToggle={(e) => setOpen("inputs", e.currentTarget.open)}>
        <summary>Inputs</summary>
        <div className="control-group">
          <div className="control-row">
            <label>Accelerator</label>
            <span>{inputs.tps.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={inputs.tps}
            onChange={(e) => onInputs({ tps: Number(e.target.value) })}
          />
        <div className="control-row">
          <label>Grade (%)</label>
          <span>{inputs.gradePct.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={-6}
          max={6}
          step={0.1}
          value={inputs.gradePct}
          onChange={(e) => onInputs({ gradePct: Number(e.target.value) })}
        />
        </div>
      </details>

      <details open={collapse.vehicle} onToggle={(e) => setOpen("vehicle", e.currentTarget.open)}>
        <summary>Vehicle</summary>
        <div className="control-group">
          <div className="control-row" style={{ justifyContent: "space-between" }}>
            <label>Vehicle Profile</label>
            <select
              value={vehicleProfile}
              onChange={(e) => {
                const id = e.target.value as VehicleProfileId;
              setVehicleProfile(id);
              applyVehicleProfile(id);
            }}
          >
              <option value="custom">Custom</option>
              <option value="small-car">Small car</option>
              <option value="small-suv">Small SUV</option>
              <option value="medium-suv">Medium SUV</option>
              <option value="large-suv">Large/Fullsize SUV</option>
              <option value="bus">Bus</option>
            </select>
          </div>
          <div className="control-row">
            <label>Mass (kg)</label>
            <input
              type="number"
              value={config.vehicle.massKg}
              step={50}
              disabled={vehicleProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, massKg: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>CdA (m^2)</label>
            <input
              type="number"
              value={config.vehicle.cdA}
              step={0.05}
              disabled={vehicleProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, cdA: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Rolling Cr</label>
            <input
              type="number"
              value={config.vehicle.cr}
              step={0.001}
              disabled={vehicleProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, cr: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Drivetrain Eff</label>
            <input
              type="number"
              value={config.vehicle.drivetrainEff}
              step={0.01}
              disabled={vehicleProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, drivetrainEff: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Tire Diameter (in)</label>
            <input
              type="number"
              value={config.vehicle.tireDiameterIn}
              step={1}
              disabled={vehicleProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, tireDiameterIn: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Diff Ratio</label>
            <input
              type="number"
              value={config.vehicle.diffRatio}
              step={0.1}
              disabled={vehicleProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, diffRatio: Number(e.target.value) },
                })
              }
            />
          </div>
        </div>
      </details>

      <details open={collapse.engine} onToggle={(e) => setOpen("engine", e.currentTarget.open)}>
        <summary>Engine</summary>
        <div className="control-group">
          <div className="control-row" style={{ justifyContent: "space-between" }}>
            <label>Engine Profile</label>
            <select
              value={engineProfile}
              onChange={(e) => {
                const id = e.target.value as EngineProfileId;
              setEngineProfile(id);
              applyEngineProfile(id);
            }}
          >
              <option value="custom">Custom</option>
              <option value="7.4l-carb">220 kW — 7.4L Carb</option>
              <option value="7.4l-efi">230 kW — 7.4L EFI</option>
              <option value="lq4-6.0l">240 kW — GM LQ4 6.0L Vortec</option>
              <option value="6bt-400kw">400 kW — Cummins 6BT Diesel</option>
              <option value="cummins-l9-bus">283 kW — Cummins L9 (Transit)</option>
              <option value="5l">180 kW — 5.0L</option>
              <option value="3l">140 kW — 3.0L</option>
              <option value="2.5l">120 kW — 2.5L</option>
              <option value="2l">105 kW — 2.0L</option>
              <option value="1.5l">85 kW — 1.5L</option>
            </select>
          </div>
          <div className="control-row">
            <label>Idle RPM</label>
            <input
              type="number"
              value={config.engine.idleRpm}
              step={50}
              disabled={engineProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  engine: { ...config.engine, idleRpm: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Redline RPM</label>
            <input
              type="number"
              value={config.engine.redlineRpm}
              step={100}
              disabled={engineProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  engine: { ...config.engine, redlineRpm: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Eff RPM</label>
            <input
              type="number"
              value={config.engine.effRpm}
              step={50}
              disabled={engineProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  engine: { ...config.engine, effRpm: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Peak Power (kW)</label>
            <input
              type="number"
            value={config.engine.maxPowerKw}
            step={5}
            disabled={engineProfile !== "custom"}
            onChange={(e) =>
              onConfig({
                engine: { ...config.engine, maxPowerKw: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>Engine Peak (kW)</label>
          <span>{config.engine.maxPowerKw.toFixed(0)}</span>
        </div>
        <input
          type="range"
          min={50}
          max={1000}
          step={5}
          value={config.engine.maxPowerKw}
          disabled={engineProfile !== "custom"}
          onChange={(e) =>
            onConfig({
              engine: { ...config.engine, maxPowerKw: Number(e.target.value) },
            })
          }
        />
          <div className="control-row">
            <label>Engine Eff</label>
            <input
              type="number"
              value={config.engine.engineEff}
              step={0.01}
              min={0.05}
              max={0.6}
              disabled={engineProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  engine: { ...config.engine, engineEff: Number(e.target.value) },
                })
              }
            />
          </div>
        </div>
      </details>

      <details open={collapse.evt} onToggle={(e) => setOpen("evt", e.currentTarget.open)}>
        <summary>
          EVT — Sweet Spot&nbsp;
          {Math.round(evtSweetSpotKw)} kW
        </summary>
        <div className="control-group">
          <div className="control-row" style={{ justifyContent: "space-between" }}>
            <label>EVT Profile</label>
            <select
              value={evtProfile}
              onChange={(e) => {
                const id = e.target.value as EvtProfileId;
              setEvtProfile(id);
              applyEvtProfile(id);
            }}
          >
              <option value="custom">Custom</option>
              <option value="small">130 kW — Small</option>
              <option value="medium">220 kW — Medium</option>
              <option value="large">300 kW — Large</option>
              <option value="heavy-duty">420 kW — Heavy Duty</option>
              <option value="500kw">500 kW — 500 kW</option>
              <option value="600kw">600 kW — 600 kW</option>
            </select>
          </div>
        <div className="control-row">
          <label>Traction Motor Peak (kW)</label>
          <input
            type="number"
            value={config.vehicle.motorPeakPowerKw}
            step={10}
            disabled={evtProfile !== "custom"}
            onChange={(e) =>
              onConfig({
                vehicle: { ...config.vehicle, motorPeakPowerKw: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>EVT Peak (kW)</label>
          <span>{config.vehicle.motorPeakPowerKw.toFixed(0)}</span>
        </div>
        <input
          type="range"
          min={100}
          max={1000}
          step={10}
          value={config.vehicle.motorPeakPowerKw}
          disabled={evtProfile !== "custom"}
          onChange={(e) => {
            const peak = Number(e.target.value);
            onConfig({
              vehicle: {
                ...config.vehicle,
                motorPeakPowerKw: peak,
                regenMaxKw: peak,
              },
              generator: {
                ...config.generator,
                maxElecKw: peak,
              },
            });
          }}
        />
          <div className="control-row">
            <label>Traction Motor RPM Limit</label>
            <input
              type="number"
              value={config.vehicle.motorMaxRpm}
              step={250}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, motorMaxRpm: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Traction Reducer</label>
            <input
              type="number"
              value={config.vehicle.tractionReduction}
              step={0.1}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, tractionReduction: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Gen Peak (kW)</label>
            <input
              type="number"
              value={config.generator.maxElecKw}
              step={5}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  generator: { ...config.generator, maxElecKw: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Gen Eff</label>
            <input
              type="number"
              value={config.generator.eff}
              step={0.01}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  generator: { ...config.generator, eff: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Gen Ramp (kW/s)</label>
            <input
              type="number"
              value={config.generator.proRampKwPerS}
              step={5}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  generator: { ...config.generator, proRampKwPerS: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Gen Response (s)</label>
            <input
              type="number"
              value={config.generator.responseTimeSec}
              step={0.1}
              min={0.2}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  generator: { ...config.generator, responseTimeSec: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Gen Step-Up</label>
            <input
              type="number"
              value={config.generator.stepUpRatio}
              step={0.1}
              min={0.1}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  generator: { ...config.generator, stepUpRatio: Number(e.target.value) },
                })
              }
            />
          </div>
        <div className="control-row">
          <label>Regen Peak (kW)</label>
          <input
            type="number"
            value={config.vehicle.regenMaxKw}
            step={5}
            disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, regenMaxKw: Number(e.target.value) },
                })
              }
            />
          </div>
        <div className="control-row">
          <label>Regen Peak SOC</label>
          <input
            type="number"
            value={config.vehicle.regenMaxSoc}
              step={0.01}
              min={0}
              max={1}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, regenMaxSoc: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Regen Force Gain</label>
            <input
              type="number"
              value={config.vehicle.regenForceGain}
              step={0.1}
              min={0}
              disabled={evtProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  vehicle: { ...config.vehicle, regenForceGain: Number(e.target.value) },
                })
              }
            />
          </div>
        </div>
      </details>

      <details
        open={collapse.battery}
        onToggle={(e) => setOpen("battery", e.currentTarget.open)}
      >
        <summary>Battery + Bus</summary>
        <div className="control-group">
          <div className="control-row" style={{ justifyContent: "space-between" }}>
            <label>Battery Profile</label>
            <select
              value={batteryProfile}
              onChange={(e) => {
                const id = e.target.value as BatteryProfileId;
              setBatteryProfile(id);
              applyBatteryProfile(id);
            }}
          >
              <option value="custom">Custom</option>
              <option value="lto">LTO</option>
              <option value="lfp">LFP</option>
              <option value="nmc">NMC</option>
              <option value="nca">NCA</option>
              <option value="lmo">LMO</option>
              <option value="lco">LCO</option>
            </select>
          </div>
          <div className="control-row">
            <label>Capacity (kWh)</label>
            <input
              type="number"
              value={config.battery.capacityKwh}
              step={1}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, capacityKwh: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Initial SOC</label>
            <input
              type="number"
              value={config.battery.initialSoc}
              step={0.01}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, initialSoc: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Nominal V</label>
            <input
              type="number"
              value={config.battery.vNom}
              step={10}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, vNom: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>R int (ohm)</label>
            <input
              type="number"
              value={config.battery.rInt}
              step={0.01}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, rInt: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Max Discharge (kW)</label>
            <input
              type="number"
              value={config.battery.maxDischargeKw}
              step={10}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, maxDischargeKw: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Max Charge (kW)</label>
            <input
              type="number"
              value={config.battery.maxChargeKw}
              step={10}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, maxChargeKw: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>SOC Target</label>
            <input
              type="number"
              value={config.battery.socTarget}
              step={0.01}
              min={0}
              max={1}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, socTarget: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>SOC Target Band</label>
            <input
              type="number"
              value={config.battery.socTargetBand}
              step={0.01}
              min={0}
              max={0.5}
              disabled={batteryProfile !== "custom"}
              onChange={(e) =>
                onConfig({
                  battery: { ...config.battery, socTargetBand: Number(e.target.value) },
                })
              }
            />
          </div>
          <div className="control-row">
            <label>Bus Min (V)</label>
            <input
              type="number"
              value={config.bus.vMin}
              step={5}
              onChange={(e) =>
                onConfig({ bus: { ...config.bus, vMin: Number(e.target.value) } })
              }
            />
          </div>
          <div className="control-row">
            <label>Bus Max (V)</label>
            <input
              type="number"
              value={config.bus.vMax}
              step={5}
              onChange={(e) =>
                onConfig({ bus: { ...config.bus, vMax: Number(e.target.value) } })
              }
            />
          </div>
        </div>
      </details>
    </div>
  );
};

export default Controls;
