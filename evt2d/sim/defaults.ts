import type { SimConfig, SimInputs } from "./types";

export const defaultConfig: SimConfig = {
  mode: "base",
  vehicle: {
    massKg: 2400,
    cdA: 0.9,
    cr: 0.012,
    drivetrainEff: 0.92,
    wheelRadiusM: 0.38,
    wheelPowerMaxKw: 220,
    speedTargetMph: 55,
    gradePct: 0,
  },
  battery: {
    capacityKwh: 18,
    initialSoc: 0.65,
    vNom: 650,
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
  },
  bus: {
    vMin: 520,
    vMax: 760,
  },
  driver: {
    kp: 450,
    ki: 35,
  },
  scenario: {
    type: "manual",
    stepPowerKw: 120,
    sinePowerKw: 140,
    sinePeriodSec: 18,
    i70ProfileKw: [
      40, 60, 90, 120, 150, 170, 180, 170, 150, 120, 90, 60,
    ],
  },
  theater: {
    enabled: false,
    shiftPeriodSec: 14,
    shiftMagnitudeRpm: 420,
  },
};

export const defaultInputs: SimInputs = {
  aps: 0.25,
  tps: 0.4,
  gradePct: 0,
  scenario: "manual",
};
