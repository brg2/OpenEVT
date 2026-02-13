import type { SimConfig, SimInputs, SimState } from "./types";
import { CONTROL_PROFILES, resolveControlMode } from "./controlProfiles";
import { clamp, rpmShape } from "./utils";

const V_EPS = 1.0;
const RHO = 1.225;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

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
    engineMode: "idle",
    rpmTarget: rpm,
    tqTargetNm: 0,
    tpsCmd: 0,
    modeTimerSec: 0,
    regenActive: false,
    soc: config.battery.initialSoc,
    vBus: config.battery.vNom,
    pWheelsReqKw: 0,
    pWheelsCmdKw: 0,
    pWheelsKw: 0,
    pTracElecKw: 0,
    pTracCapKw: 0,
    pGenElecCmdKw: 0,
    pGenElecKw: 0,
    pBattKw: 0,
    pEngAvailKw: 0,
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

  // Pedal intent.
  const aps = clamp(inputs.aps, 0, 1);
  next.prevTps = aps;

  let pTracElecReqKw = 0;
  let pWheelsReqKw = 0;
  next.regenActive = false;

  const controlMode = resolveControlMode(config);

  // Traction request from the driver (positive accel). This gets capped later by available power.
  // In BSFC Island - Direct TPS, add SOC-above-target "EV assist" so the driver can get useful
  // acceleration without needing a large pedal (and thus a large TPS command).
  //
  // Also in this mode, apply a speed-aware "coast shaping" at very low pedal so feathering does
  // not cause large torque changes while the vehicle is moving (smooth gradient, no binary gap).
  const socTarget = clamp(battery.socTarget, battery.socMin, battery.socMax);
  const socBand = Math.max(0.01, battery.socTargetBand);
  const socAboveFrac = clamp((state.soc - socTarget) / socBand, 0, 1);
  const evAssistStrength = clamp(
    Number.isFinite(vehicle.evAssistStrength) ? vehicle.evAssistStrength : 0.5,
    0,
    1,
  );
  // 0..1 slider maps to 0..1000% additional traction-per-pedal (when SOC is above target).
  const evAssistMaxBoost = 10.0;
  const evAssistMul =
    controlMode === "bsfc_island_direct"
      ? 1 + evAssistStrength * evAssistMaxBoost * socAboveFrac
      : 1;
  const apsForTrac = (() => {
    if (controlMode !== "bsfc_island_direct") return aps;
    const coastAps = 0.08;
    const apsShaped = aps * smoothstep(0, coastAps, aps);
    // Blend shaping in only when moving (keep standstill launch linear).
    const speedBlend = smoothstep(0.5, 5.0, v); // ~1 mph -> ~11 mph
    return aps + (apsShaped - aps) * speedBlend;
  })();
  const pTracUserReqKw = apsForTrac * vehicle.motorPeakPowerKw * evAssistMul;

  // Motor RPM based on current speed (used for sink gating and overspeed taper).
  const wheelRpmNow = (v / wheelCirc) * 60;
  const motorRpmNow = wheelRpmNow * vehicle.tractionReduction * vehicle.diffRatio;

  // SOC band for engine mode hysteresis around the target.
  const socHyst = Math.max(0.01, battery.socTargetBand) * 0.5;
  const socHigh = clamp(socTarget + socHyst, battery.socMin, battery.socMax);

  // Apply overspeed taper to the *requested* positive traction; if we're oversped and can't
  // accept power, we should not keep the engine on the island (no sink).
  const rpmLimit = Math.max(1, vehicle.motorMaxRpm);
  const rpmSoftStart = rpmLimit * 0.95;
  let pTracUserReqTaperedKw = pTracUserReqKw;
  if (motorRpmNow > rpmSoftStart && pTracUserReqTaperedKw > 0) {
    const scale = clamp(
      (rpmLimit - motorRpmNow) / Math.max(1, rpmLimit - rpmSoftStart),
      0,
      1,
    );
    pTracUserReqTaperedKw *= scale;
  }

  // In Basic/rectifier mode, the engine+generator are only used when the battery SOC is
  // at/below the target band (charging need). Using the upper hysteresis bound avoids
  // float-equality edge cases at exactly the target.
  const sink = state.soc <= socHigh;

  // In direct mode, allow the engine/generator to follow the pedal only when there is a
  // meaningful electrical sink (traction demand) or we still need to charge up to target.
  // Otherwise, we "coast" the engine at idle (TPS=0, gen=0) even if the pedal is barely open.
  const genAllowedDirect =
    sink || pTracUserReqTaperedKw > Math.max(0, engine.pEpsilonKw);

  // Resolve control behavior via swappable profiles (instead of interwoven conditionals).
  const profile = CONTROL_PROFILES[controlMode] ?? CONTROL_PROFILES.bsfc_island;
  const ctx = {
    state,
    inputs,
    config,
    dt,
    aps,
    pTracUserReqTaperedKw,
    sink,
    socTarget,
    socHigh,
    genAllowedDirect,
  };
  const modeUpdate = profile.updateMode(ctx, {
    engineMode: state.engineMode,
    modeTimerSec: state.modeTimerSec,
  });
  const engineMode = modeUpdate.engineMode;
  next.engineMode = engineMode;
  next.modeTimerSec = modeUpdate.modeTimerSec;

  const cmd = profile.command(ctx, modeUpdate);
  next.rpmTarget = cmd.rpmTarget;
  next.tqTargetNm = cmd.tqTargetNm;
  next.tpsCmd = cmd.tpsCmd;

  // RPM follows target (no free-rev outside island).
  const rpmNow = clamp(
    state.rpm +
      ((cmd.rpmTarget - state.rpm) * dt) / Math.max(0.05, engine.rpmTimeConst),
    engine.idleRpm,
    engine.redlineRpm,
  );
  next.rpm = rpmNow;

  // Available mechanical power at current RPM given throttle command.
  const gNow = clamp(
    rpmShape(rpmNow, engine.idleRpm, engine.redlineRpm, engine.effRpm),
    0,
    1.1,
  );
  const pEngAvailKw = cmd.tpsCmd * engine.maxPowerKw * gNow;
  next.pEngAvailKw = pEngAvailKw;

  const rpmNorm = clamp(rpmNow / Math.max(1, engine.redlineRpm), 0, 1.2);
  const parasiticKw = engine.maxPowerKw * (0.01 + 0.08 * rpmNorm * rpmNorm);
  const pEngNetAvailKw = Math.max(0, pEngAvailKw - parasiticKw);

  const pGenMaxKw = Math.min(generator.maxElecKw, pEngNetAvailKw * generator.eff);
  let pGenElecKw = 0;
  let pGenElecTargetKw = 0;
  let pGenElecCmdKw = Math.max(0, state.pGenElecCmdKw || 0);

  const socSpan = Math.max(0.02, battery.socMax - battery.socMin);
  const socDischargeFrac = clamp((state.soc - battery.socMin) / socSpan, 0, 1);
  const socChargeFrac = clamp((battery.socMax - state.soc) / socSpan, 0, 1);
  const maxDischargeKw = battery.maxDischargeKw * socDischargeFrac;
  const maxChargeKw = battery.maxChargeKw * socChargeFrac;

  // Generator command (electrical): bounded by what the engine can supply at the commanded
  // island point (or zero when idling).
  const pGenCmdRawKw = pGenMaxKw;

  // SOC Target Band controls how strongly we bias generator-vs-traction so SOC moves toward target.
  const targetSoc = clamp(battery.socTarget, battery.socMin, battery.socMax);
  const band = Math.max(0.01, battery.socTargetBand);
  const socErr = state.soc - targetSoc; // + => above target, - => below
  const socFrac = clamp(socErr / band, -1, 1);

  // Available traction shaping (symmetric and enforceable):
  // - SOC above target => discharge bias => traction > gen (battery discharges)
  // - SOC below target => charge bias => traction < gen (battery charges)
  // Reserve is bounded so low pedal never fully zeros traction.
  const reserveFracMax = 0.8;
  const desiredDischargeKw = socFrac > 0 ? socFrac * maxDischargeKw : 0;
  const desiredChargeKw =
    socFrac < 0 ? (-socFrac) * reserveFracMax * Math.min(maxChargeKw, pGenCmdRawKw) : 0;
  // Traction power limits:
  // - Hard cap: what we can supply electrically right now (engine + allowable battery discharge).
  // - SOC cap (BSFC Island - Direct TPS only): when SOC is below target, cap traction so the
  //   generator can exceed traction (net charging) without violating TPS=APS.
  const pTracCapHardKw = clamp(pGenCmdRawKw + maxDischargeKw, 0, vehicle.motorPeakPowerKw);
  let pTracCapSocKw = pTracCapHardKw;
  if (controlMode === "bsfc_island_direct" && socFrac < 0) {
    // Ensure: pGenElecTarget = pTrac + desiredCharge <= pGenCmdRaw.
    // ReserveFracMax prevents this from collapsing traction to zero at low power.
    pTracCapSocKw = clamp(pGenCmdRawKw - desiredChargeKw, 0, pTracCapHardKw);
  }
  next.pTracCapKw = pTracCapSocKw;

  pTracElecReqKw = clamp(pTracUserReqTaperedKw, 0, pTracCapSocKw);
  if (pTracElecReqKw < pTracUserReqTaperedKw - 1e-6) next.limiter.tracPower = true;

  // One-pedal regen: as TPS lifts, regen increases proportional to (1 - TPS) and speed,
  // and is disabled above regenMaxSoc to avoid overcharge.
  {
    const regenSocMax = Math.min(
      battery.socMax,
      Number.isFinite(vehicle.regenMaxSoc) ? vehicle.regenMaxSoc : battery.socMax,
    );
    const socHeadroom = clamp(
      (regenSocMax - state.soc) / Math.max(0.01, regenSocMax - battery.socMin),
      0,
      1,
    );
    // No hard threshold: regen scales smoothly with speed (0 at standstill).
    const speedFactor = clamp(v / 15, 0, 1);
    // One-pedal regen shouldn't fight commanded forward torque at partial pedal.
    // Treat very small pedal as the "coast" region where regen ramps in.
    const regenNeutralAps = 0.05;
    const apsFactor = aps < regenNeutralAps ? (regenNeutralAps - aps) / regenNeutralAps : 0;
    const regenElecKw = vehicle.regenMaxKw * apsFactor * speedFactor * socHeadroom;
    if (regenElecKw > 0) {
      pTracElecReqKw = clamp(
        pTracElecReqKw - regenElecKw,
        -vehicle.regenMaxKw,
        vehicle.motorPeakPowerKw,
      );
      next.regenActive = true;
    }
  }

  if (motorRpmNow > rpmSoftStart) {
    // Positive traction must taper to protect overspeed.
    // For regen, allow braking torque even slightly above the limit so we can pull the motor
    // back under the safe RPM band (one-pedal downhill control).
    if (pTracElecReqKw >= 0) {
      const scale = clamp(
        (rpmLimit - motorRpmNow) / Math.max(1, rpmLimit - rpmSoftStart),
        0,
        1,
      );
      if (scale < 1) {
        pTracElecReqKw *= scale;
        next.limiter.tracPower = true;
      }
    } else {
      const regenHardCut = rpmLimit * 1.1;
      const scale = motorRpmNow >= regenHardCut ? 0 : 1;
      if (scale < 1) {
        pTracElecReqKw *= scale;
        next.limiter.tracPower = true;
      }
    }
  }

  // Traction ramp limiter: bound how quickly commanded traction power can change.
  // This protects mechanical components from step torque and sudden reversals.
  {
    const rampKwPerS = Math.max(0, Number.isFinite(vehicle.tracRampKwPerS) ? vehicle.tracRampKwPerS : 0);
    if (rampKwPerS > 0) {
      const prev = Number.isFinite(state.pTracElecKw) ? state.pTracElecKw : 0;
      const maxDelta = rampKwPerS * dt;
      const lo = -Math.max(0, vehicle.regenMaxKw);
      const hi = Math.max(0, pTracCapHardKw);
      pTracElecReqKw = clamp(
        clamp(pTracElecReqKw, prev - maxDelta, prev + maxDelta),
        lo,
        hi,
      );
    }
  }

  pWheelsReqKw = pTracElecReqKw * vehicle.drivetrainEff;
  next.pWheelsReqKw = pWheelsReqKw;
  next.pWheelsCmdKw = pWheelsReqKw;

  // In Basic/rectifier mode, generator kW is biased relative to the (SOC-shaped) traction
  // request so SOC moves toward target:
  // - SOC above target => gen < traction (discharge battery)
  // - SOC below target => gen > traction (charge battery)
  // If traction is capped to 0 by the SOC reserve while charging is needed, allow the
  // generator to still produce charge power (no need for positive traction as a prerequisite).
  if (pTracElecReqKw < 0) {
    // When regenning, generator should not produce power.
    pGenElecTargetKw = 0;
  } else {
    // Target generator power based on traction + SOC bias (controller target, not engine-limited).
    pGenElecTargetKw = clamp(
      pTracElecReqKw + desiredChargeKw - desiredDischargeKw,
      0,
      generator.maxElecKw,
    );
  }

  // Controller-side demand ramp: limit how quickly the generator request changes.
  // This prevents abrupt engine/generator load steps (RPM spikes) even if the plant is fast.
  {
    const demandRampKwPerS = Math.max(
      0,
      Number.isFinite(generator.demandRampKwPerS) ? generator.demandRampKwPerS : 0,
    );
    if (demandRampKwPerS > 0) {
      const maxDelta = demandRampKwPerS * dt;
      pGenElecCmdKw = clamp(
        pGenElecTargetKw,
        pGenElecCmdKw - maxDelta,
        pGenElecCmdKw + maxDelta,
      );
    } else {
      pGenElecCmdKw = pGenElecTargetKw;
    }
    pGenElecCmdKw = clamp(pGenElecCmdKw, 0, generator.maxElecKw);
  }

  // Generator response: first-order lag + ramp rate (traction is instant; battery buffers).
  const genTau = clamp(
    Number.isFinite(generator.responseTimeSec) ? generator.responseTimeSec : 2.5,
    0,
    10,
  );
  if (genTau > 1e-3) {
    const alpha = clamp(dt / genTau, 0, 1);
    pGenElecKw = state.pGenElecKw + (pGenElecCmdKw - state.pGenElecKw) * alpha;
  } else {
    pGenElecKw = pGenElecCmdKw;
  }
  const rampKwPerS = Math.max(0, generator.proRampKwPerS);
  if (rampKwPerS > 0) {
    const maxDelta = rampKwPerS * dt;
    pGenElecKw = clamp(
      pGenElecKw,
      state.pGenElecKw - maxDelta,
      state.pGenElecKw + maxDelta,
    );
  }
  pGenElecKw = clamp(pGenElecKw, 0, pGenMaxKw);
  // Rectifier reality: above SOC target we must not keep pushing extra generator power into
  // the battery (charging). If SOC is above target, generator output cannot exceed traction
  // demand; otherwise SOC will creep upward.
  if (socFrac > 0 && pTracElecReqKw > 0) {
    pGenElecKw = Math.min(pGenElecKw, pTracElecReqKw);
  }

  // Keep legacy delay buffer fields for export/compat (no longer used for dynamics).
  next.genDelayBuffer = state.genDelayBuffer;
  next.genDelaySteps = state.genDelaySteps;

  let pBattKw = pTracElecReqKw - pGenElecKw;

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
  // Rectifier behavior: if the bus/battery can't accept generator output, it must taper.
  // Never "dump" excess into traction beyond the requested electrical power.
  if (pTracElecKw > pTracElecReqKw + 1e-6) {
    pGenElecKw = Math.max(0, pTracElecReqKw - pBattKw);
    pTracElecKw = pGenElecKw + pBattKw;
  }
  if (pTracElecKw > pTracElecReqKw + 0.01 && vBus > bus.vMax + 2) {
    pGenElecKw = Math.max(0, pTracElecReqKw - pBattKw);
    pTracElecKw = pGenElecKw + pBattKw;
    next.limiter.busOv = true;
  }

  const pWheelsKw = pTracElecKw * vehicle.drivetrainEff;
  next.pWheelsKw = pWheelsKw;
  next.pTracElecKw = pTracElecKw;
  next.pGenElecCmdKw = Math.max(0, pGenElecCmdKw);
  next.pGenElecKw = Math.max(0, pGenElecKw);
  next.pBattKw = pBattKw;
  next.pEngMechKw = pGenElecKw / Math.max(0.01, generator.eff);
  // Fuel burn includes generator shaft power plus parasitic pumping/friction to hold RPM.
  const pFuelMechKw = Math.max(0, parasiticKw + next.pEngMechKw);
  next.fuelRateGph =
    (pFuelMechKw / Math.max(0.05, engine.engineEff)) /
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
  next.genRpm = next.rpm * generator.stepUpRatio;
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
