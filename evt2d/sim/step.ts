import type { SimConfig, SimInputs, SimState } from "./types";
import { clamp, rpmShape, toMps } from "./utils";

export interface DerivedInputs {
  demandMode: "manual" | "power" | "speed";
  powerDemandKw: number;
  speedTargetMps: number;
}

const V_EPS = 1.0;
const RHO = 1.225;

export const createInitialState = (config: SimConfig): SimState => {
  const rpm = config.engine.idleRpm;
  return {
    timeSec: 0,
    vMps: 0,
    aMps2: 0,
    distanceM: 0,
    rpm,
    soc: config.battery.initialSoc,
    vBus: config.battery.vNom,
    pWheelsReqKw: 0,
    pWheelsKw: 0,
    pTracElecKw: 0,
    pGenElecKw: 0,
    pBattKw: 0,
    pEngMechKw: 0,
    pGenCmdKw: 0,
    piIntegral: 0,
    limiter: {
      tracPower: false,
      battDischarge: false,
      battCharge: false,
      busUv: false,
      busOv: false,
    },
    limiterTime: {
      tracPower: 0,
      battDischarge: 0,
      battCharge: 0,
      busUv: 0,
      busOv: 0,
    },
    energy: {
      eTracOutKwh: 0,
      eGenKwh: 0,
      eBattOutKwh: 0,
      eBattInKwh: 0,
      fuelGallons: 0,
    },
  };
};

export const step = (
  state: SimState,
  inputs: SimInputs,
  config: SimConfig,
  derived: DerivedInputs,
  dt: number,
): SimState => {
  const next: SimState = {
    ...state,
    limiter: {
      tracPower: false,
      battDischarge: false,
      battCharge: false,
      busUv: false,
      busOv: false,
    },
  };

  next.timeSec = state.timeSec + dt;

  const { vehicle, battery, engine, generator, bus, driver } = config;

  const gradeRad = Math.atan(inputs.gradePct / 100);
  const v = state.vMps;
  const vEff = Math.max(v, V_EPS);
  const fDrag = 0.5 * RHO * vehicle.cdA * v * v;
  const fRoll = vehicle.cr * vehicle.massKg * 9.81;
  const fGrade = vehicle.massKg * 9.81 * Math.sin(gradeRad);

  let pWheelsReqKw = 0;
  let piIntegral = state.piIntegral;

  if (derived.demandMode === "speed") {
    const error = derived.speedTargetMps - v;
    piIntegral += error * dt;
    const fReq = driver.kp * error + driver.ki * piIntegral + fDrag + fRoll + fGrade;
    pWheelsReqKw = clamp((fReq * vEff) / 1000, 0, vehicle.wheelPowerMaxKw);
  } else if (derived.demandMode === "power") {
    pWheelsReqKw = clamp(derived.powerDemandKw, 0, vehicle.wheelPowerMaxKw);
  } else {
    pWheelsReqKw = clamp(inputs.aps, 0, 1) * vehicle.wheelPowerMaxKw;
  }

  next.pWheelsReqKw = pWheelsReqKw;
  next.piIntegral = piIntegral;

  let rpmTarget = engine.idleRpm + clamp(inputs.tps, 0, 1) * (engine.redlineRpm - engine.idleRpm);
  if (config.mode === "pro" && config.theater.enabled) {
    const t = next.timeSec % config.theater.shiftPeriodSec;
    if (t < 1.2) rpmTarget += config.theater.shiftMagnitudeRpm * (1 - t / 1.2);
  }

  const rpm = state.rpm + ((rpmTarget - state.rpm) * dt) / Math.max(0.1, engine.rpmTimeConst);
  next.rpm = rpm;

  const g = clamp(rpmShape(rpm, engine.idleRpm, engine.redlineRpm), 0, 1.1);
  const pEngAvailKw = clamp(inputs.tps, 0, 1) * engine.maxPowerKw * g;

  let pGenCmdKw = state.pGenCmdKw;
  const pTracElecReqKw = pWheelsReqKw / Math.max(0.01, vehicle.drivetrainEff);

  if (config.mode === "pro") {
    const band = battery.socTargetBand;
    const low = battery.socTarget - band;
    const high = battery.socTarget + band;
    let target = pTracElecReqKw;
    if (state.soc < low) target = generator.maxElecKw;
    if (state.soc > high) target = 0;
    const ramp = generator.proRampKwPerS * dt;
    if (target > pGenCmdKw) pGenCmdKw = Math.min(pGenCmdKw + ramp, target);
    else pGenCmdKw = Math.max(pGenCmdKw - ramp, target);
    pGenCmdKw = clamp(pGenCmdKw, 0, generator.maxElecKw);
  }

  const pGenMaxKw = Math.min(generator.maxElecKw, pEngAvailKw * generator.eff);
  let pGenElecKw = 0;

  if (config.mode === "base") {
    const chargeHeadroom = state.soc < battery.socMax ? battery.maxChargeKw : 0;
    const demand = pTracElecReqKw + chargeHeadroom;
    pGenElecKw = clamp(Math.min(pGenMaxKw, demand), 0, pGenMaxKw);
  } else {
    pGenElecKw = clamp(Math.min(pGenCmdKw, pGenMaxKw), 0, pGenMaxKw);
  }

  let pBattKw = pTracElecReqKw - pGenElecKw;

  if (pBattKw > battery.maxDischargeKw) {
    pBattKw = battery.maxDischargeKw;
    next.limiter.battDischarge = true;
  }
  if (pBattKw < -battery.maxChargeKw) {
    pBattKw = -battery.maxChargeKw;
    next.limiter.battCharge = true;
  }

  const iBatt = (pBattKw * 1000) / Math.max(1, battery.vNom);
  let vBus = battery.vNom - iBatt * battery.rInt;

  const iMaxDischarge = (battery.vNom - bus.vMin) / Math.max(0.001, battery.rInt);
  const pBattMaxUv = (iMaxDischarge * battery.vNom) / 1000;
  if (pBattKw > pBattMaxUv) {
    pBattKw = pBattMaxUv;
    next.limiter.busUv = true;
  }

  const iMaxCharge = (bus.vMax - battery.vNom) / Math.max(0.001, battery.rInt);
  const pBattMinOv = -(iMaxCharge * battery.vNom) / 1000;
  if (pBattKw < pBattMinOv) {
    pBattKw = pBattMinOv;
    next.limiter.busOv = true;
  }

  vBus = battery.vNom - ((pBattKw * 1000) / Math.max(1, battery.vNom)) * battery.rInt;
  next.vBus = clamp(vBus, bus.vMin, bus.vMax);

  let pTracElecKw = pGenElecKw + pBattKw;
  if (pTracElecKw > pTracElecReqKw + 0.01) {
    pGenElecKw = Math.max(0, pTracElecReqKw - pBattKw);
    pTracElecKw = pGenElecKw + pBattKw;
    next.limiter.busOv = true;
  }

  const pWheelsKw = pTracElecKw * vehicle.drivetrainEff;
  next.pWheelsKw = Math.max(0, pWheelsKw);
  next.pTracElecKw = Math.max(0, pTracElecKw);
  next.pGenElecKw = Math.max(0, pGenElecKw);
  next.pBattKw = pBattKw;
  next.pEngMechKw = pGenElecKw / Math.max(0.01, generator.eff);
  next.pGenCmdKw = pGenCmdKw;

  if (next.pWheelsKw < pWheelsReqKw - 0.5) next.limiter.tracPower = true;

  const fTrac = (next.pWheelsKw * 1000) / vEff;
  const netForce = fTrac - (fDrag + fRoll + fGrade);
  const a = netForce / vehicle.massKg;
  const vNext = Math.max(0, v + a * dt);
  next.vMps = vNext;
  next.aMps2 = a;
  next.distanceM = state.distanceM + vNext * dt;

  const dtHours = dt / 3600;
  const socNext = clamp(
    state.soc - (pBattKw * dtHours) / Math.max(0.1, battery.capacityKwh),
    battery.socMin,
    battery.socMax,
  );
  next.soc = socNext;

  next.energy = {
    eTracOutKwh: state.energy.eTracOutKwh + next.pTracElecKw * dtHours,
    eGenKwh: state.energy.eGenKwh + next.pGenElecKw * dtHours,
    eBattOutKwh: state.energy.eBattOutKwh + Math.max(0, pBattKw) * dtHours,
    eBattInKwh: state.energy.eBattInKwh + Math.max(0, -pBattKw) * dtHours,
    fuelGallons:
      state.energy.fuelGallons +
      (next.pEngMechKw / Math.max(0.05, engine.engineEff)) *
        (dtHours / engine.fuelKwhPerGallon),
  };

  next.limiterTime = {
    tracPower: state.limiterTime.tracPower + (next.limiter.tracPower ? dt : 0),
    battDischarge:
      state.limiterTime.battDischarge + (next.limiter.battDischarge ? dt : 0),
    battCharge:
      state.limiterTime.battCharge + (next.limiter.battCharge ? dt : 0),
    busUv: state.limiterTime.busUv + (next.limiter.busUv ? dt : 0),
    busOv: state.limiterTime.busOv + (next.limiter.busOv ? dt : 0),
  };

  return next;
};
