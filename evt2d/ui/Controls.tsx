import React, { useRef } from "react";
import type { ScriptedPoint, SimConfig, SimInputs } from "../sim/types";

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
  onLoadScripted: (points: ScriptedPoint[]) => void;
}

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
  onLoadScripted,
}) => {
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleLoad = async (file: File) => {
    const text = await file.text();
    const data = JSON.parse(text) as ScriptedPoint[];
    if (Array.isArray(data)) onLoadScripted(data);
  };

  return (
    <div className="controls">
      <h2>Run Controls</h2>
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
            {[0.5, 1, 2, 5].map((value) => (
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

      <h2>Inputs</h2>
      <div className="control-group">
        <div className="control-row">
          <label>APS (Traction)</label>
          <span>{inputs.aps.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={inputs.aps}
          onChange={(e) => onInputs({ aps: Number(e.target.value) })}
        />
        <div className="control-row">
          <label>TPS (Engine)</label>
          <span>{inputs.tps.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={inputs.tps}
          onChange={(e) => onInputs({ tps: Number(e.target.value) })}
        />
        <div className="control-row">
          <label>Grade (%)</label>
          <input
            type="number"
            value={inputs.gradePct}
            step={0.1}
            onChange={(e) => onInputs({ gradePct: Number(e.target.value) })}
          />
        </div>
        <div className="control-row">
          <label>Scenario</label>
          <select
            value={inputs.scenario}
            onChange={(e) => onInputs({ scenario: e.target.value as SimInputs["scenario"] })}
          >
            <option value="manual">Manual</option>
            <option value="constant-speed">Constant Speed</option>
            <option value="step-power">Step Demand</option>
            <option value="sine-power">Sine Demand</option>
            <option value="i70-climb">I-70 Climb</option>
            <option value="scripted">Scripted JSON</option>
          </select>
        </div>
        <div className="control-row">
          <label>Load Scripted</label>
          <button
            onClick={() => fileRef.current?.click()}
            className="ghost"
          >
            Choose JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleLoad(file);
            }}
          />
        </div>
      </div>

      <h2>Scenario</h2>
      <div className="control-group">
        <div className="control-row">
          <label>Speed Target (mph)</label>
          <input
            type="number"
            value={config.vehicle.speedTargetMph}
            step={1}
            onChange={(e) =>
              onConfig({
                vehicle: { ...config.vehicle, speedTargetMph: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>Step Power (kW)</label>
          <input
            type="number"
            value={config.scenario.stepPowerKw}
            step={5}
            onChange={(e) =>
              onConfig({
                scenario: { ...config.scenario, stepPowerKw: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>Sine Power (kW)</label>
          <input
            type="number"
            value={config.scenario.sinePowerKw}
            step={5}
            onChange={(e) =>
              onConfig({
                scenario: { ...config.scenario, sinePowerKw: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>Sine Period (s)</label>
          <input
            type="number"
            value={config.scenario.sinePeriodSec}
            step={1}
            onChange={(e) =>
              onConfig({
                scenario: { ...config.scenario, sinePeriodSec: Number(e.target.value) },
              })
            }
          />
        </div>
      </div>

      <h2>Vehicle</h2>
      <div className="control-group">
        <div className="control-row">
          <label>Mass (kg)</label>
          <input
            type="number"
            value={config.vehicle.massKg}
            step={50}
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
            onChange={(e) =>
              onConfig({
                vehicle: { ...config.vehicle, drivetrainEff: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>Wheel Power Max (kW)</label>
          <input
            type="number"
            value={config.vehicle.wheelPowerMaxKw}
            step={10}
            onChange={(e) =>
              onConfig({
                vehicle: { ...config.vehicle, wheelPowerMaxKw: Number(e.target.value) },
              })
            }
          />
        </div>
      </div>

      <h2>Battery</h2>
      <div className="control-group">
        <div className="control-row">
          <label>Capacity (kWh)</label>
          <input
            type="number"
            value={config.battery.capacityKwh}
            step={1}
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
            onChange={(e) =>
              onConfig({
                battery: { ...config.battery, maxChargeKw: Number(e.target.value) },
              })
            }
          />
        </div>
      </div>

      <h2>Engine + Generator</h2>
      <div className="control-group">
        <div className="control-row">
          <label>Idle RPM</label>
          <input
            type="number"
            value={config.engine.idleRpm}
            step={50}
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
            onChange={(e) =>
              onConfig({
                engine: { ...config.engine, redlineRpm: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>Max Power (kW)</label>
          <input
            type="number"
            value={config.engine.maxPowerKw}
            step={5}
            onChange={(e) =>
              onConfig({
                engine: { ...config.engine, maxPowerKw: Number(e.target.value) },
              })
            }
          />
        </div>
        <div className="control-row">
          <label>Gen Max (kW)</label>
          <input
            type="number"
            value={config.generator.maxElecKw}
            step={5}
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
            onChange={(e) =>
              onConfig({
                generator: { ...config.generator, proRampKwPerS: Number(e.target.value) },
              })
            }
          />
        </div>
      </div>

      <h2>Bus + Protection</h2>
      <div className="control-group">
        <div className="control-row">
          <label>Bus Min (V)</label>
          <input
            type="number"
            value={config.bus.vMin}
            step={5}
            onChange={(e) => onConfig({ bus: { ...config.bus, vMin: Number(e.target.value) } })}
          />
        </div>
        <div className="control-row">
          <label>Bus Max (V)</label>
          <input
            type="number"
            value={config.bus.vMax}
            step={5}
            onChange={(e) => onConfig({ bus: { ...config.bus, vMax: Number(e.target.value) } })}
          />
        </div>
      </div>
    </div>
  );
};

export default Controls;
