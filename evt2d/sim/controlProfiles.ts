import type { EngineControlMode, SimConfig, SimInputs, SimState } from "./types";
import { buildBsfcSpec, findBestPointForPower, findBestRpmForTorque } from "./bsfc";
import { clamp, rpmShape } from "./utils";

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export type ControlProfileContext = {
  state: SimState;
  inputs: SimInputs;
  config: SimConfig;
  dt: number;
  aps: number;
  pTracUserReqTaperedKw: number;
  sink: boolean;
  socTarget: number;
  socHigh: number;
  genAllowedDirect: boolean;
};

export type ControlModeUpdate = {
  engineMode: "idle" | "island";
  modeTimerSec: number;
};

export type ControlCommand = {
  rpmTarget: number;
  tqTargetNm: number;
  tpsCmd: number;
};

export type ControlProfile = {
  id: EngineControlMode;
  updateMode: (ctx: ControlProfileContext, prev: ControlModeUpdate) => ControlModeUpdate;
  command: (ctx: ControlProfileContext, mode: ControlModeUpdate) => ControlCommand;
};

export const resolveControlMode = (config: SimConfig): EngineControlMode =>
  (config.generator.controlMode ?? config.engine.controlMode ?? "bsfc_island") as EngineControlMode;

const computeElecNeedKw = (ctx: ControlProfileContext) => {
  const { battery, engine, generator } = ctx.config;

  const tracNeedKw = Math.max(0, ctx.pTracUserReqTaperedKw);

  // SOC bias: below target => charge (gen > traction), above target => discharge (gen < traction).
  // This is continuous (no bang-bang), which avoids oscillation around the target.
  const band = Math.max(0.01, battery.socTargetBand);
  const socErr = ctx.state.soc - ctx.socTarget; // + => above target, - => below
  const socFrac = clamp(socErr / band, -1, 1);

  const socSpan = Math.max(0.02, battery.socMax - battery.socMin);
  const socDischargeFrac = clamp((ctx.state.soc - battery.socMin) / socSpan, 0, 1);
  const socChargeFrac = clamp((battery.socMax - ctx.state.soc) / socSpan, 0, 1);
  const maxDischargeKw = battery.maxDischargeKw * socDischargeFrac;
  const maxChargeKw = battery.maxChargeKw * socChargeFrac;

  const reserveFracMax = 0.8;
  const desiredDischargeKw = socFrac > 0 ? socFrac * maxDischargeKw : 0;
  const desiredChargeKw =
    socFrac < 0 ? (-socFrac) * reserveFracMax * Math.min(maxChargeKw, generator.maxElecKw) : 0;

  let pNeedKw = clamp(
    tracNeedKw + desiredChargeKw - desiredDischargeKw,
    0,
    generator.maxElecKw,
  );

  // Coast-to-idle: when there's no meaningful electrical demand (including when SOC is above
  // target and traction is tiny), don't spin the engine.
  const pOnKw = Math.max(0, engine.pEpsilonKw);
  if (pNeedKw <= pOnKw) pNeedKw = 0;

  // Rate-limit the controller's requested generator demand to avoid accel/decel spikes.
  const rampKwPerS = Math.max(
    0,
    Number.isFinite(generator.demandRampKwPerS) ? generator.demandRampKwPerS : 0,
  );
  if (rampKwPerS > 0) {
    const maxDelta = rampKwPerS * ctx.dt;
    const prevCmd = Number.isFinite(ctx.state.pGenElecCmdKw) ? ctx.state.pGenElecCmdKw : 0;
    pNeedKw = clamp(pNeedKw, prevCmd - maxDelta, prevCmd + maxDelta);
  }

  return clamp(pNeedKw, 0, generator.maxElecKw);
};

const directLikeModeUpdate = (
  ctx: ControlProfileContext,
  prev: ControlModeUpdate,
): ControlModeUpdate => {
  const { engine } = ctx.config;
  let engineMode: "idle" | "island" = prev.engineMode;
  let modeTimerSec = prev.modeTimerSec + ctx.dt;
  if (engineMode === "idle") {
    if (
      ctx.aps > engine.apsOn &&
      ctx.genAllowedDirect &&
      modeTimerSec >= Math.max(0, engine.minOffTimeSec)
    ) {
      engineMode = "island";
      modeTimerSec = 0;
    }
  } else {
    if (
      // Pedal lift should coast immediately; buffer-based coast can still use min-on time.
      ctx.aps < engine.apsOff ||
      (!ctx.genAllowedDirect && modeTimerSec >= Math.max(0, engine.minOnTimeSec))
    ) {
      engineMode = "idle";
      modeTimerSec = 0;
    }
  }
  return { engineMode, modeTimerSec };
};

const bsfcIslandModeUpdate = (
  ctx: ControlProfileContext,
  prev: ControlModeUpdate,
): ControlModeUpdate => {
  const { engine, battery, generator } = ctx.config;
  let engineMode: "idle" | "island" = prev.engineMode;
  let modeTimerSec = prev.modeTimerSec + ctx.dt;
  const pNeedKw = computeElecNeedKw(ctx);
  const pOnKw = Math.max(0, engine.pEpsilonKw);
  const pOffKw = pOnKw * 0.6;
  if (engineMode === "idle") {
    if (
      pNeedKw > pOnKw &&
      modeTimerSec >= Math.max(0, engine.minOffTimeSec)
    ) {
      engineMode = "island";
      modeTimerSec = 0;
    }
  } else {
    if (
      pNeedKw <= pOffKw &&
      modeTimerSec >= Math.max(0, engine.minOnTimeSec)
    ) {
      engineMode = "idle";
      modeTimerSec = 0;
    }
  }
  // Keep battery referenced to avoid unused-import linting in some configs (future additions).
  void battery;
  void generator;
  return { engineMode, modeTimerSec };
};

const commandIdleDefaults = (ctx: ControlProfileContext): ControlCommand => {
  const { engine } = ctx.config;
  return {
    rpmTarget: engine.idleRpm,
    tqTargetNm: 0,
    tpsCmd: 0,
  };
};

const directCommand: ControlProfile["command"] = (ctx, mode) => {
  const { engine } = ctx.config;
  if (mode.engineMode !== "island") return commandIdleDefaults(ctx);
  return {
    rpmTarget: clamp(
      engine.idleRpm + (engine.redlineRpm - engine.idleRpm) * ctx.aps,
      engine.idleRpm,
      engine.redlineRpm,
    ),
    tqTargetNm: 0,
    tpsCmd: ctx.aps,
  };
};

const bsfcIslandCommand: ControlProfile["command"] = (ctx, mode) => {
  const { engine, generator } = ctx.config;
  if (mode.engineMode !== "island") return commandIdleDefaults(ctx);
  const spec = buildBsfcSpec(engine);
  const pElecNeedKw = computeElecNeedKw(ctx);
  // If there is no generator electrical demand, do not open the throttle.
  // (Even if the engine is still in "island" mode due to min-on timers.)
  if (pElecNeedKw <= 1e-3) return commandIdleDefaults(ctx);
  // Blend from idle→island smoothly as demand rises. Keep the "on" threshold very low so
  // demand-ramped startups don't deadlock at idle (no available gen power => no demand growth).
  const pBlendFullKw = Math.max(5, generator.maxElecKw * 0.12);
  const blend = smoothstep(0, pBlendFullKw, pElecNeedKw);

  const pMechNeedKw = pElecNeedKw / Math.max(0.05, generator.eff);
  const rpmSearchMin = Math.max(engine.idleRpm, Math.min(engine.islandRpmMin, engine.islandRpmMax));
  const rpmSearchMax = Math.max(rpmSearchMin + 200, Math.min(engine.redlineRpm, Math.max(engine.islandRpmMin, engine.islandRpmMax)));
  const tqMin = 0;
  const tqMax = Math.max(0, engine.islandTqMaxNm);

  const bestPt =
    pMechNeedKw > 1e-3
      ? findBestPointForPower(spec, pMechNeedKw, rpmSearchMin, rpmSearchMax, tqMin, tqMax, 70)
      : null;

  let rpmDesired = spec.islandRpm;
  let tqDesiredNm = 0;
  if (bestPt) {
    rpmDesired = bestPt.rpm;
    tqDesiredNm = bestPt.tq;
  } else if (pMechNeedKw > 1e-3) {
    rpmDesired = clamp(spec.islandRpm, rpmSearchMin, rpmSearchMax);
    tqDesiredNm = clamp((pMechNeedKw * 9549) / Math.max(1, rpmDesired), 0, tqMax);
    rpmDesired = findBestRpmForTorque(spec, tqDesiredNm, rpmSearchMin, rpmSearchMax, 55).rpm;
  }

  rpmDesired = clamp(rpmDesired, engine.idleRpm, engine.redlineRpm);
  tqDesiredNm = clamp(tqDesiredNm, 0, tqMax);

  const rpmCmd = clamp(
    engine.idleRpm + (rpmDesired - engine.idleRpm) * blend,
    engine.idleRpm,
    engine.redlineRpm,
  );
  const tqCmdNm = clamp(tqDesiredNm * blend, 0, tqMax);
  const pTargetMechKw = (tqCmdNm * rpmCmd) / 9549;

  const gAtTarget = clamp(
    rpmShape(rpmCmd, engine.idleRpm, engine.redlineRpm, engine.effRpm),
    0,
    1.1,
  );
  const pMaxAtTargetKw = engine.maxPowerKw * gAtTarget;
  const rpmNormTarget = clamp(rpmCmd / Math.max(1, engine.redlineRpm), 0, 1.2);
  const parasiticTargetKw = engine.maxPowerKw * (0.01 + 0.08 * rpmNormTarget * rpmNormTarget);
  const tpsCmd = clamp((pTargetMechKw + parasiticTargetKw) / Math.max(1, pMaxAtTargetKw), 0, 1);

  const tau = clamp(engine.rpmTimeConst * 0.8, 0.15, 1.4);
  const alpha = clamp(ctx.dt / Math.max(1e-3, tau), 0, 1);
  const rpmTarget = clamp(
    ctx.state.rpmTarget + (rpmCmd - ctx.state.rpmTarget) * alpha,
    engine.idleRpm,
    engine.redlineRpm,
  );
  const tqTargetNm = clamp(
    ctx.state.tqTargetNm + (tqCmdNm - ctx.state.tqTargetNm) * alpha,
    0,
    tqMax,
  );

  return {
    rpmTarget,
    tqTargetNm,
    tpsCmd,
  };
};

const bsfcIslandDirectCommand: ControlProfile["command"] = (ctx, mode) => {
  const { engine, battery, generator } = ctx.config;
  if (mode.engineMode !== "island") return commandIdleDefaults(ctx);

  const spec = buildBsfcSpec(engine);

  // Direct TPS (driver intent), but hold RPM near the BSFC island and optionally bias upward
  // at low RPM when SOC is below target (more available power at low speed).
  const tpsCmd = clamp(ctx.aps, 0, 1);

  const rpmIslandCenter = clamp(
    spec.islandRpm,
    Math.min(engine.islandRpmMin, engine.islandRpmMax),
    Math.max(engine.islandRpmMin, engine.islandRpmMax),
  );
  const rpmPedal = clamp(
    engine.idleRpm + (engine.redlineRpm - engine.idleRpm) * ctx.aps,
    engine.idleRpm,
    engine.redlineRpm,
  );
  // Under near-zero electrical load, behave like a "free rev" (no immediate jump to island RPM).
  // As generator demand ramps up, gently pull RPM toward the island center for efficiency.
  const prevGenCmdKw = clamp(
    Number.isFinite(ctx.state.pGenElecCmdKw) ? ctx.state.pGenElecCmdKw : 0,
    0,
    generator.maxElecKw,
  );
  const loadFrac = clamp(prevGenCmdKw / Math.max(1, generator.maxElecKw), 0, 1);
  const loadBlend = smoothstep(0.05, 0.35, loadFrac);
  const effPull = 1 - smoothstep(0.75, 0.95, ctx.aps);

  let rpmTarget = rpmPedal + (rpmIslandCenter - rpmPedal) * loadBlend * effPull;

  const band = Math.max(0.01, battery.socTargetBand);
  const socDef = clamp((ctx.socTarget - ctx.state.soc) / band, 0, 1);
  // When SOC is below target and generator demand is present, bias RPM upward (gently) toward
  // the island so the same TPS can produce more electrical power without a step change.
  const rpmBoost = socDef * loadBlend * Math.max(0, rpmIslandCenter - rpmTarget) * 0.8;
  rpmTarget = clamp(rpmTarget + rpmBoost, engine.idleRpm, engine.redlineRpm);

  return {
    rpmTarget,
    tqTargetNm: 0,
    tpsCmd,
  };
};

export const CONTROL_PROFILES: Record<EngineControlMode, ControlProfile> = {
  bsfc_island: {
    id: "bsfc_island",
    updateMode: (ctx, prev) => bsfcIslandModeUpdate(ctx, prev),
    command: (ctx, mode) => bsfcIslandCommand(ctx, mode),
  },
  bsfc_island_direct: {
    id: "bsfc_island_direct",
    updateMode: (ctx, prev) => directLikeModeUpdate(ctx, prev),
    command: (ctx, mode) => bsfcIslandDirectCommand(ctx, mode),
  },
  direct: {
    id: "direct",
    updateMode: (ctx, prev) => directLikeModeUpdate(ctx, prev),
    command: (ctx, mode) => directCommand(ctx, mode),
  },
};
