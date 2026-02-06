import type { SimConfig, SimInputs, SimState } from "./types";
import { clamp, rpmShape } from "./utils";

const V_EPS = 1.0;
const RHO = 1.225;

export const createInitialState = (config: SimConfig): SimState => {
  const rpm = config.engine.idleRpm;
  const delaySteps = Math.max(1, Math.round(config.generator.responseTimeSec / 0.05));
  return {
    timeSec: 0,
    vMps: 0,
    wheelRpm: 0,
    motorRpm: 0,
    genRpm: 0,
    aMps2: 0,
    distanceM: 0,
    rpm,
    regenActive: false,
    soc: config.battery.initialSoc,
    vBus: config.battery.vNom,
    pWheelsReqKw: 0,
    pWheelsCmdKw: 0,
    pWheelsKw: 0,
    pTracElecKw: 0,
    pGenElecKw: 0,
    pBattKw: 0,
    pEngMechKw: 0,
    fuelRateGph: 0,
    genDelayBuffer: new Array(delaySteps).fill(0),
    genDelaySteps: delaySteps,
    prevTps: 0,
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

  const { vehicle, battery, engine, generator, bus } = config;

  const gradeRad = Math.atan(inputs.gradePct / 100);
  const v = state.vMps;
  const vEff = Math.max(v, V_EPS);
  const tireDiameterM = (vehicle.tireDiameterIn * 0.0254) || 0.7;
  const wheelCirc = Math.max(0.01, Math.PI * tireDiameterM);
  const fDrag = 0.5 * RHO * vehicle.cdA * v * v;
  const fRoll = vehicle.cr * vehicle.massKg * 9.81;
  const fGrade = vehicle.massKg * 9.81 * Math.sin(gradeRad);

  const pWheelsMaxKw = vehicle.motorPeakPowerKw * vehicle.drivetrainEff;
  let pWheelsReqKw = clamp(inputs.aps, 0, 1) * pWheelsMaxKw;

  // One-pedal regen: as TPS lifts, regen increases proportional to (1 - TPS) and speed,
  // and is disabled above regenMaxSoc to avoid overcharge.
  next.regenActive = false;
  const tpsEff0 = clamp(inputs.tps, 0, 1);
  if (v > 0.5) {
    const regenSocMax = Math.min(
      battery.socMax,
      Number.isFinite(vehicle.regenMaxSoc) ? vehicle.regenMaxSoc : battery.socMax,
    );
    const socHeadroom = clamp(
      (regenSocMax - state.soc) / Math.max(0.01, regenSocMax - battery.socMin),
      0,
      1,
    );
    const speedFactor = clamp(v / 15, 0, 1);
    const tpsFactor = clamp(1 - tpsEff0, 0, 1);
    const regenKw = vehicle.regenMaxKw * tpsFactor * speedFactor * socHeadroom;
    if (regenKw > 0) {
      pWheelsReqKw = clamp(pWheelsReqKw - regenKw, -vehicle.regenMaxKw, pWheelsMaxKw);
      next.regenActive = true;
    }
  }

  next.pWheelsReqKw = pWheelsReqKw;
  next.prevTps = tpsEff0;

  const pWheelsCmdKw = pWheelsReqKw;
  next.pWheelsCmdKw = pWheelsCmdKw;

  const tpsEff = tpsEff0;
  let rpmTarget = engine.idleRpm + tpsEff * (engine.redlineRpm - engine.idleRpm);

  const rpm = state.rpm + ((rpmTarget - state.rpm) * dt) / Math.max(0.1, engine.rpmTimeConst);
  next.rpm = rpm;

  const g = clamp(rpmShape(rpm, engine.idleRpm, engine.redlineRpm), 0, 1.1);
  const pEngAvailKw = tpsEff * engine.maxPowerKw * g;

  let pTracElecReqKw = pWheelsCmdKw / Math.max(0.01, vehicle.drivetrainEff);

  // Soft taper near motor max RPM (ratios + tire determine max wheel speed).
  const wheelRpmNow = (v / wheelCirc) * 60;
  const motorRpmNow = wheelRpmNow * vehicle.tractionReduction * vehicle.diffRatio;
  const rpmLimit = Math.max(1, vehicle.motorMaxRpm);
  const rpmSoftStart = rpmLimit * 0.95;
  if (motorRpmNow > rpmSoftStart) {
    const scale = clamp((rpmLimit - motorRpmNow) / Math.max(1, rpmLimit - rpmSoftStart), 0, 1);
    if (scale < 1) {
      pTracElecReqKw *= scale;
      pWheelsReqKw = pTracElecReqKw * vehicle.drivetrainEff;
      next.pWheelsReqKw = pWheelsReqKw;
      next.limiter.tracPower = true;
    }
  }

  const pGenMaxKw = Math.min(generator.maxElecKw, pEngAvailKw * generator.eff);
  let pGenElecKw = 0;
  let pGenElecRawKw = 0;

  // In Basic mode, traction is capped so generator retains a proportional SOC reserve.
  // Example: SOC 0.2, target 0.5 => scale 0.4 => traction <= 40% of gen potential.
  let socErrorFrac = 0;
  if (config.mode === "basic") {
    const target = Math.max(0.01, battery.socTarget);
    const scale = clamp(state.soc / target, 0, 1.5);
    socErrorFrac = 1 - scale;
    if (Math.abs(scale - 1) > 0.01) next.limiter.tracPower = true;
    // Cap traction against generator capability so SOC can charge or discharge toward target.
    const maxTracBySoc = pGenMaxKw * scale;
    if (pTracElecReqKw > maxTracBySoc) {
      pTracElecReqKw = maxTracBySoc;
      pWheelsReqKw = pTracElecReqKw * vehicle.drivetrainEff;
      next.pWheelsReqKw = pWheelsReqKw;
    }
  }

  const chargeHeadroom = clamp(pGenMaxKw * socErrorFrac, -pGenMaxKw, pGenMaxKw);
  const demand = pTracElecReqKw + chargeHeadroom;
  pGenElecRawKw = clamp(Math.min(pGenMaxKw, demand), 0, pGenMaxKw);

  const delaySteps = Math.max(
    1,
    Math.round(
      clamp(
        Number.isFinite(generator.responseTimeSec) ? generator.responseTimeSec : 2.5,
        0,
        10,
      ) / dt,
    ),
  );
  let delayBuffer = state.genDelayBuffer.slice();
  if (state.genDelaySteps !== delaySteps || delayBuffer.length !== delaySteps) {
    delayBuffer = new Array(delaySteps).fill(state.pGenElecKw);
  }
  delayBuffer.push(pGenElecRawKw);
  pGenElecKw = delayBuffer.shift() ?? pGenElecRawKw;
  next.genDelayBuffer = delayBuffer;
  next.genDelaySteps = delaySteps;

  let pBattKw = pTracElecReqKw - pGenElecKw;

  const socSpan = Math.max(0.02, battery.socMax - battery.socMin);
  const socDischargeFrac = clamp(
    (state.soc - battery.socMin) / socSpan,
    0,
    1,
  );
  const socChargeFrac = clamp(
    (battery.socMax - state.soc) / socSpan,
    0,
    1,
  );
  const maxDischargeKw = battery.maxDischargeKw * socDischargeFrac;
  const maxChargeKw = battery.maxChargeKw * socChargeFrac;

  if (pBattKw > maxDischargeKw) {
    pBattKw = maxDischargeKw;
    next.limiter.battDischarge = true;
  }
  if (pBattKw < -maxChargeKw) {
    pBattKw = -maxChargeKw;
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
  if (pBattKw < pBattMinOv && vBus > bus.vMax + 2) {
    pBattKw = pBattMinOv;
    next.limiter.busOv = true;
  }

  vBus = battery.vNom - ((pBattKw * 1000) / Math.max(1, battery.vNom)) * battery.rInt;
  next.vBus = clamp(vBus, bus.vMin, bus.vMax);

  let pTracElecKw = pGenElecKw + pBattKw;
  if (pTracElecKw > pTracElecReqKw + 0.01 && vBus > bus.vMax + 2) {
    pGenElecKw = Math.max(0, pTracElecReqKw - pBattKw);
    pTracElecKw = pGenElecKw + pBattKw;
    next.limiter.busOv = true;
  }

  const pWheelsKw = pTracElecKw * vehicle.drivetrainEff;
  next.pWheelsKw = pWheelsKw;
  next.pTracElecKw = pTracElecKw;
  next.pGenElecKw = Math.max(0, pGenElecKw);
  next.pBattKw = pBattKw;
  next.pEngMechKw = pGenElecKw / Math.max(0.01, generator.eff);
  next.fuelRateGph =
    (next.pEngMechKw / Math.max(0.05, engine.engineEff)) /
    Math.max(1e-6, engine.fuelKwhPerGallon);

  if (next.pWheelsKw < pWheelsReqKw - 0.5) next.limiter.tracPower = true;

  const isRegen = next.pWheelsKw < 0;
  const fTrac = (next.pWheelsKw * 1000) / vEff;
  const regenForceGain = Number.isFinite(vehicle.regenForceGain)
    ? vehicle.regenForceGain
    : 1;
  const regenForce = isRegen ? Math.abs(fTrac) * regenForceGain : 0;
  const netForce = fTrac - (fDrag + fRoll + fGrade) - regenForce;
  const a = netForce / vehicle.massKg;
  const vNext = Math.max(0, v + a * dt);
  next.vMps = vNext;
  const wheelRpm = (vNext / wheelCirc) * 60;
  next.wheelRpm = wheelRpm;
  next.motorRpm = wheelRpm * vehicle.tractionReduction * vehicle.diffRatio;
  next.genRpm = rpm * generator.stepUpRatio;
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
