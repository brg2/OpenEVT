import type { SimConfig, SimInputs } from "./types";

export const defaultConfig: SimConfig = {
  mode: "basic",
  vehicle: {
    massKg: 2400,
    cdA: 0.9,
    cr: 0.012,
    drivetrainEff: 0.92,
    tireDiameterIn: 31,
    tractionReduction: 9.2,
    diffRatio: 3.73,
    motorPeakPowerKw: 240,
    motorMaxRpm: 11000,
    regenMaxKw: 80,
    regenForceGain: 1.0,
    regenMaxSoc: 0.9,
  },
  battery: {
    capacityKwh: 14,
    initialSoc: 0.2,
    vNom: 360,
    rInt: 0.06,
    maxDischargeKw: 180,
    maxChargeKw: 120,
    socMin: 0.08,
    socMax: 0.94,
    socTarget: 0.6,
    socTargetBand: 0.08,
  },
  engine: {
    idleRpm: 900,
    redlineRpm: 5200,
    maxPowerKw: 190,
    rpmTimeConst: 0.6,
    engineEff: 0.32,
    fuelKwhPerGallon: 33.7,
  },
  generator: {
    maxElecKw: 165,
    eff: 0.92,
    proRampKwPerS: 45,
    responseTimeSec: 2.5,
    stepUpRatio: 2.2,
  },
  bus: {
    vMin: 300,
    vMax: 430,
  },
};

export const defaultInputs: SimInputs = {
  aps: 0.35,
  tps: 0.35,
  gradePct: 0,
};
