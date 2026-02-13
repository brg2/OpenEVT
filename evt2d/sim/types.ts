export type Mode = "basic";
export type EngineControlMode =
  | "bsfc_island"
  | "bsfc_island_direct"
  | "direct";

export interface SimInputs {
  aps: number;
  tps: number;
  gradePct: number;
}

export interface SimConfig {
  mode: Mode;
  vehicle: {
    massKg: number;
    cdA: number;
    cr: number;
    drivetrainEff: number;
    tireDiameterIn: number;
    tractionReduction: number;
    diffRatio: number;
    motorPeakPowerKw: number;
    motorMaxRpm: number;
    tracRampKwPerS: number;
    // BSFC Island - Direct TPS only: how strongly SOC-above-target boosts traction-per-pedal
    // (to reduce the need to open TPS while "EV-mode" is desired).
    evAssistStrength: number;
    regenMaxKw: number;
    regenForceGain: number;
    regenMaxSoc: number;
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
    // Deprecated: control mode is now under generator/EVT. Kept for backwards compat.
    controlMode: EngineControlMode;
    // UI only: used to select a BSFC map profile.
    bsfcProfileId?: string;
    cylinders: number;
    idleRpm: number;
    redlineRpm: number;
    effRpm: number;
    apsOn: number;
    apsOff: number;
    islandRpmMin: number;
    islandRpmMax: number;
    islandTqMinNm: number;
    islandTqMaxNm: number;
    pEpsilonKw: number;
    minOnTimeSec: number;
    minOffTimeSec: number;
    maxPowerKw: number;
    rpmTimeConst: number;
    engineEff: number;
    fuelKwhPerGallon: number;
  };
  generator: {
    controlMode: EngineControlMode;
    maxElecKw: number;
    eff: number;
    // Controller-side shaping: limits how quickly the requested generator power can change.
    demandRampKwPerS: number;
    proRampKwPerS: number;
    responseTimeSec: number;
    stepUpRatio: number;
  };
  bus: {
    vMin: number;
    vMax: number;
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
  wheelRpm: number;
  motorRpm: number;
  genRpm: number;
  aMps2: number;
  distanceM: number;
  rpm: number;
  engineMode: "idle" | "island";
  rpmTarget: number;
  tqTargetNm: number;
  tpsCmd: number;
  modeTimerSec: number;
  regenActive: boolean;
  soc: number;
  vBus: number;
  pWheelsReqKw: number;
  pWheelsCmdKw: number;
  pWheelsKw: number;
  pTracElecKw: number;
  // Instantaneous traction electrical cap (before ramp limiting), used for UI/diagnostics.
  pTracCapKw: number;
  // Controller request for generator electrical power (after demand ramp, before plant lag).
  pGenElecCmdKw: number;
  pGenElecKw: number;
  pBattKw: number;
  pEngAvailKw: number;
  pEngMechKw: number;
  fuelRateGph: number;
  genDelayBuffer: number[];
  genDelaySteps: number;
  prevTps: number;
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
