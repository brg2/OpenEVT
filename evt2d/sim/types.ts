export type Mode = "base" | "pro";

export type ScenarioType =
  | "manual"
  | "constant-speed"
  | "step-power"
  | "sine-power"
  | "i70-climb"
  | "scripted";

export interface SimInputs {
  aps: number;
  tps: number;
  gradePct: number;
  scenario: ScenarioType;
}

export interface ScenarioConfig {
  type: ScenarioType;
  stepPowerKw: number;
  sinePowerKw: number;
  sinePeriodSec: number;
  i70ProfileKw: number[];
}

export interface SimConfig {
  mode: Mode;
  vehicle: {
    massKg: number;
    cdA: number;
    cr: number;
    drivetrainEff: number;
    wheelRadiusM: number;
    wheelPowerMaxKw: number;
    speedTargetMph: number;
    gradePct: number;
  };
  battery: {
    capacityKwh: number;
    initialSoc: number;
    vNom: number;
    rInt: number;
    maxDischargeKw: number;
    maxChargeKw: number;
    socMin: number;
    socMax: number;
    socTarget: number;
    socTargetBand: number;
  };
  engine: {
    idleRpm: number;
    redlineRpm: number;
    maxPowerKw: number;
    rpmTimeConst: number;
    engineEff: number;
    fuelKwhPerGallon: number;
  };
  generator: {
    maxElecKw: number;
    eff: number;
    proRampKwPerS: number;
  };
  bus: {
    vMin: number;
    vMax: number;
  };
  driver: {
    kp: number;
    ki: number;
  };
  scenario: ScenarioConfig;
  theater: {
    enabled: boolean;
    shiftPeriodSec: number;
    shiftMagnitudeRpm: number;
  };
}

export interface LimiterFlags {
  tracPower: boolean;
  battDischarge: boolean;
  battCharge: boolean;
  busUv: boolean;
  busOv: boolean;
}

export interface EnergyStats {
  eTracOutKwh: number;
  eGenKwh: number;
  eBattOutKwh: number;
  eBattInKwh: number;
  fuelGallons: number;
}

export interface LimiterTime {
  tracPower: number;
  battDischarge: number;
  battCharge: number;
  busUv: number;
  busOv: number;
}

export interface SimState {
  timeSec: number;
  vMps: number;
  aMps2: number;
  distanceM: number;
  rpm: number;
  soc: number;
  vBus: number;
  pWheelsReqKw: number;
  pWheelsKw: number;
  pTracElecKw: number;
  pGenElecKw: number;
  pBattKw: number;
  pEngMechKw: number;
  pGenCmdKw: number;
  piIntegral: number;
  limiter: LimiterFlags;
  limiterTime: LimiterTime;
  energy: EnergyStats;
}

export interface ScriptedPoint {
  t: number;
  aps: number;
  tps: number;
  gradePct?: number;
}

export interface ExportPayload {
  config: SimConfig;
  inputs: SimInputs;
  recordedInputs: ScriptedPoint[];
  finalState: SimState;
}
