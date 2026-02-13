import type { SimConfig, SimInputs } from "./types";

export const defaultConfig: SimConfig = {
  mode: "basic",
  vehicle: {
    massKg: 2400,
    cdA: 0.9,
    cr: 0.012,
    drivetrainEff: 0.92,
    tireDiameterIn: 31,
    tractionReduction: 2.9,
    diffRatio: 3.73,
    motorPeakPowerKw: 240,
    motorMaxRpm: 11000,
    // Limits how quickly traction power can change (protects driveline from step torque).
    // Full-scale ramp time ~= motorPeakPowerKw / tracRampKwPerS.
    tracRampKwPerS: 300,
    // Default centered: moderate SOC-above-target assist.
    evAssistStrength: 0.5,
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
    controlMode: "bsfc_island",
    bsfcProfileId: "custom",
    cylinders: 8,
    idleRpm: 900,
    redlineRpm: 5200,
    effRpm: 2400,
    apsOn: 0.05,
    apsOff: 0.03,
    islandRpmMin: 1800,
    islandRpmMax: 3200,
    islandTqMinNm: 200,
    islandTqMaxNm: 600,
    pEpsilonKw: 2,
    minOnTimeSec: 1.0,
    minOffTimeSec: 1.0,
    maxPowerKw: 190,
    rpmTimeConst: 0.6,
    engineEff: 0.32,
    fuelKwhPerGallon: 33.7,
  },
  generator: {
    controlMode: "bsfc_island",
    maxElecKw: 165,
    eff: 0.92,
    // Controller demand ramp (separate from generator plant response/ramp).
    demandRampKwPerS: 120,
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
