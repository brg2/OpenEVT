export type Mode = "basic";

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
  regenActive: boolean;
  soc: number;
  vBus: number;
  pWheelsReqKw: number;
  pWheelsCmdKw: number;
  pWheelsKw: number;
  pTracElecKw: number;
  pGenElecKw: number;
  pBattKw: number;
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
