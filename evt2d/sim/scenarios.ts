import type { ScenarioType, SimConfig } from "./types";
import { clamp, toMps } from "./utils";

export interface ScenarioResult {
  mode: "manual" | "power" | "speed";
  powerKw: number;
  speedTargetMps: number;
}

export const scenarioAt = (
  scenario: ScenarioType,
  timeSec: number,
  config: SimConfig,
): ScenarioResult => {
  const { vehicle, scenario: s } = config;
  const speedTargetMps = toMps(vehicle.speedTargetMph);

  if (scenario === "constant-speed") {
    return { mode: "speed", powerKw: 0, speedTargetMps };
  }

  if (scenario === "step-power") {
    const power = timeSec < 4 ? 20 : s.stepPowerKw;
    return {
      mode: "power",
      powerKw: clamp(power, 0, vehicle.wheelPowerMaxKw),
      speedTargetMps,
    };
  }

  if (scenario === "sine-power") {
    const phase = (timeSec / Math.max(1, s.sinePeriodSec)) * Math.PI * 2;
    const power = 0.5 * s.sinePowerKw * (1 + Math.sin(phase));
    return {
      mode: "power",
      powerKw: clamp(power, 0, vehicle.wheelPowerMaxKw),
      speedTargetMps,
    };
  }

  if (scenario === "i70-climb") {
    const profile = s.i70ProfileKw;
    const segment = Math.floor(timeSec / 8) % profile.length;
    const power = profile[segment] ?? profile[0] ?? 60;
    return {
      mode: "power",
      powerKw: clamp(power, 0, vehicle.wheelPowerMaxKw),
      speedTargetMps,
    };
  }

  return { mode: "manual", powerKw: 0, speedTargetMps };
};
