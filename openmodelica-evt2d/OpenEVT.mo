within ;

package OpenEVT
  constant Real RHO = 1.225;
  constant Real V_EPS = 1.0;
  constant Real PI = 3.141592653589793;

  function clamp
    input Real v;
    input Real vMin;
    input Real vMax;
    output Real y;
  algorithm
    y := max(vMin, min(vMax, v));
  end clamp;

  function rpmShape
    input Real rpm;
    input Real idle;
    input Real redline;
    input Real effRpm;
    output Real y;
  protected
    Real span;
    Real x;
    Real xEffRaw;
    Real xEff;
    Real xLow;
    Real xHigh;
    Real t;
    function lerp
      input Real a;
      input Real b;
      input Real u;
      output Real z;
    algorithm
      z := a + (b - a) * u;
    end lerp;
    function at
      input Real a;
      input Real b;
      input Real u;
      output Real z;
    algorithm
      z := lerp(a, b, clamp(u, 0, 1));
    end at;
  algorithm
    span := max(1, redline - idle);
    x := clamp((rpm - idle) / span, 0, 1.2);
    xEffRaw := (effRpm - idle) / span;
    xEff := clamp(xEffRaw, 0.15, 0.95);
    xLow := clamp(xEff * 0.55, 0.05, xEff - 0.01);
    xHigh := clamp(xEff + (1 - xEff) * 0.67, xEff + 0.01, 1.0);

    if x <= xLow then
      t := (x - 0) / max(1e-6, xLow - 0);
      y := at(0.3, 0.85, t);
    elseif x <= xEff then
      t := (x - xLow) / max(1e-6, xEff - xLow);
      y := at(0.85, 1.0, t);
    elseif x <= xHigh then
      t := (x - xEff) / max(1e-6, xHigh - xEff);
      y := at(1.0, 0.8, t);
    elseif x <= 1.0 then
      t := (x - xHigh) / max(1e-6, 1.0 - xHigh);
      y := at(0.8, 0.55, t);
    else
      y := 0.45;
    end if;
  end rpmShape;

  function absReal
    input Real x;
    output Real y;
  algorithm
    y := if x < 0 then -x else x;
  end absReal;

  model EVT2D_Basic
    parameter Real dt = 0.05 "Fixed-step sample (s)";

    // Inputs (kept as parameters for now; we can upgrade to time-varying later)
    parameter Real tps = 0.35 "Throttle/accelerator pedal [0..1]";
    parameter Real gradePct = 0 "Road grade percent";

    // Vehicle
    parameter Real massKg = 2400;
    parameter Real cdA = 0.9;
    parameter Real cr = 0.012;
    parameter Real drivetrainEff = 0.92;
    parameter Real tireDiameterIn = 31;
    parameter Real tractionReduction = 9.2;
    parameter Real diffRatio = 3.73;
    parameter Real motorPeakPowerKw = 240;
    parameter Real motorMaxRpm = 11000;
    parameter Real regenMaxKw = 80;
    parameter Real regenForceGain = 1.0;
    parameter Real regenMaxSoc = 0.9;

    // Battery
    parameter Real capacityKwh = 14;
    parameter Real initialSoc = 0.2;
    parameter Real vNom = 360;
    parameter Real rInt = 0.06;
    parameter Real maxDischargeKwNom = 180;
    parameter Real maxChargeKwNom = 120;
    parameter Real socMin = 0.08;
    parameter Real socMax = 0.94;
    parameter Real socTarget = 0.6;
    parameter Real socTargetBand = 0.08;

    // Engine
    parameter Real idleRpm = 900;
    parameter Real redlineRpm = 5200;
    parameter Real effRpm = 2400;
    parameter Real engineMaxPowerKw = 190;
    parameter Real rpmTimeConst = 0.6;
    parameter Real engineEff = 0.32;
    parameter Real fuelKwhPerGallon = 33.7;

    // Generator
    parameter Real genMaxElecKw = 165;
    parameter Real genEff = 0.92;
    parameter Real proRampKwPerS = 45;
    parameter Real responseTimeSec = 2.5;
    parameter Real stepUpRatio = 2.2;

    // Bus
    parameter Real vMin = 300;
    parameter Real vMax = 430;

    // State (discrete-time, aligned to the TS sim)
    discrete Real timeSec(start = 0);
    discrete Real vMps(start = 0);
    discrete Real aMps2(start = 0);
    discrete Real distanceM(start = 0);
    discrete Real rpm(start = idleRpm);
    discrete Real soc(start = initialSoc);

    // Outputs / telemetry
    discrete Real wheelRpm(start = 0);
    discrete Real motorRpm(start = 0);
    discrete Real genRpm(start = 0);
    discrete Real vBus(start = vNom);

    discrete Real pWheelsReqKw(start = 0);
    discrete Real pWheelsCmdKw(start = 0);
    discrete Real pWheelsKw(start = 0);
    discrete Real pTracElecKw(start = 0);
    discrete Real pGenElecKw(start = 0);
    discrete Real pBattKw(start = 0);
    discrete Real pEngAvailKw(start = 0);
    discrete Real pEngMechKw(start = 0);
    discrete Real fuelRateGph(start = 0);

    discrete Boolean regenActive(start = false);

    // Limiters (flags)
    discrete Boolean limTracPower(start = false);
    discrete Boolean limBattDischarge(start = false);
    discrete Boolean limBattCharge(start = false);
    discrete Boolean limBusUv(start = false);
    discrete Boolean limBusOv(start = false);

    // Limiter timer accumulation (seconds)
    discrete Real limTimeTracPower(start = 0);
    discrete Real limTimeBattDischarge(start = 0);
    discrete Real limTimeBattCharge(start = 0);
    discrete Real limTimeBusUv(start = 0);
    discrete Real limTimeBusOv(start = 0);

    // Energy counters (kWh, gallons)
    discrete Real eTracOutKwh(start = 0);
    discrete Real eGenKwh(start = 0);
    discrete Real eBattOutKwh(start = 0);
    discrete Real eBattInKwh(start = 0);
    discrete Real fuelGallons(start = 0);

  protected
    // Working vars (sampled)
    Real gradeRad;
    Real v;
    Real vEff;
    Real tireDiameterM;
    Real wheelCirc;
    Real fDrag;
    Real fRoll;
    Real fGrade;
    Real aps;
    Real tpsEff0;

    Real pWheelsCapKw;
    Real pWheelsPedalMaxKw;
    Real pWheelsReqKwN;
    Real pWheelsCmdKwN;
    Real pTracElecReqKw;

    Real regenSocMax;
    Real socHeadroom;
    Real speedFactor;
    Real tpsFactor;
    Real regenKw;

    Real rpmTargetBase;
    Real loadFracPrev;
    Real droopGain;
    Real rpmTarget;
    Real rpmNow;
    Real g;
    Real rpmNorm;
    Real parasiticKw;
    Real pEngAvailKwN;
    Real pEngNetAvailKw;

    Real wheelRpmNow;
    Real motorRpmNow;
    Real rpmLimit;
    Real rpmSoftStart;
    Real rpmScale;

    Real pGenMaxKw;
    Real socErrorFrac;
    Real socSpan;
    Real socDischargeFrac;
    Real socChargeFrac;
    Real maxDischargeKw;
    Real maxChargeKw;
    Real target;
    Real socScale;
    Real maxTracBySoc;
    Real chargeRequestKw;
    Real demand;
    Real pGenElecRawKw;
    Real genTau;
    Real alpha;
    Real rampKwPerS;
    Real maxDelta;
    Real pGenElecKwN;

    Real pBattKwN;
    Real iBatt;
    Real vBusTmp;
    Real iMaxDischarge;
    Real pBattMaxUv;
    Real iMaxCharge;
    Real pBattMinOv;
    Real pTracElecKwN;
    Real pWheelsKwN;

    Boolean isRegen;
    Real fTrac;
    Real regenForce;
    Real netForce;
    Real a;
    Real vNext;
    Real wheelRpmNext;
    Real dtHours;
    Real socNext;

  algorithm
    // Discrete-time loop aligned to the TS sim
    when sample(0, dt) then
      // Reset limiter flags each step
      limTracPower := false;
      limBattDischarge := false;
      limBattCharge := false;
      limBusUv := false;
      limBusOv := false;

      timeSec := pre(timeSec) + dt;

      gradeRad := atan(gradePct / 100);
      v := pre(vMps);
      vEff := max(v, V_EPS);

      tireDiameterM := (tireDiameterIn * 0.0254);
      if tireDiameterM <= 0 then
        tireDiameterM := 0.7;
      end if;
      wheelCirc := max(0.01, PI * tireDiameterM);

      fDrag := 0.5 * RHO * cdA * v * v;
      fRoll := cr * massKg * 9.81;
      fGrade := massKg * 9.81 * sin(gradeRad);

      // Pedal -> wheel power request (cap by motor)
      aps := clamp(tps, 0, 1);
      pWheelsCapKw := motorPeakPowerKw * drivetrainEff;
      pWheelsPedalMaxKw := engineMaxPowerKw * genEff * drivetrainEff;
      pWheelsReqKwN := clamp(aps * pWheelsPedalMaxKw, 0, pWheelsCapKw);

      // One-pedal regen
      regenActive := false;
      tpsEff0 := clamp(tps, 0, 1);
      regenSocMax := min(socMax, regenMaxSoc);
      socHeadroom := clamp((regenSocMax - pre(soc)) / max(0.01, regenSocMax - socMin), 0, 1);
      speedFactor := clamp(v / 15, 0, 1);
      tpsFactor := clamp(1 - tpsEff0, 0, 1);
      regenKw := regenMaxKw * tpsFactor * speedFactor * socHeadroom;
      if regenKw > 0 then
        pWheelsReqKwN := clamp(pWheelsReqKwN - regenKw, -regenMaxKw, pWheelsCapKw);
        regenActive := true;
      end if;

      pWheelsReqKw := pWheelsReqKwN;
      pWheelsCmdKwN := pWheelsReqKwN;
      pWheelsCmdKw := pWheelsCmdKwN;

      // Engine RPM governor toward eff RPM with load-induced droop (based on previous-step load)
      rpmTargetBase := clamp(idleRpm + tpsEff0 * (effRpm - idleRpm), idleRpm, redlineRpm);
      loadFracPrev := clamp(pre(pEngMechKw) / max(1, engineMaxPowerKw), 0, 1.5);
      droopGain := 0.35;
      rpmTarget := clamp(
        rpmTargetBase - (rpmTargetBase - idleRpm) * loadFracPrev * droopGain,
        idleRpm,
        redlineRpm
      );
      rpmNow := clamp(
        pre(rpm) + ((rpmTarget - pre(rpm)) * dt) / max(0.05, rpmTimeConst),
        idleRpm,
        redlineRpm
      );
      rpm := rpmNow;

      g := clamp(rpmShape(rpmNow, idleRpm, redlineRpm, effRpm), 0, 1.1);
      pEngAvailKwN := tpsEff0 * engineMaxPowerKw * g;
      pEngAvailKw := pEngAvailKwN;

      rpmNorm := clamp(rpmNow / max(1, redlineRpm), 0, 1.2);
      parasiticKw := engineMaxPowerKw * (0.03 + 0.12 * rpmNorm * rpmNorm);
      pEngNetAvailKw := max(0, pEngAvailKwN - parasiticKw);

      pTracElecReqKw := pWheelsCmdKwN / max(0.01, drivetrainEff);

      // Soft taper near motor max RPM
      wheelRpmNow := (v / wheelCirc) * 60;
      motorRpmNow := wheelRpmNow * tractionReduction * diffRatio;
      rpmLimit := max(1, motorMaxRpm);
      rpmSoftStart := rpmLimit * 0.95;
      if motorRpmNow > rpmSoftStart then
        rpmScale := clamp((rpmLimit - motorRpmNow) / max(1, rpmLimit - rpmSoftStart), 0, 1);
        if rpmScale < 1 then
          pTracElecReqKw := pTracElecReqKw * rpmScale;
          pWheelsReqKwN := pTracElecReqKw * drivetrainEff;
          pWheelsReqKw := pWheelsReqKwN;
          limTracPower := true;
        end if;
      end if;

      // Generator max electrical power is bounded by both generator and engine net mechanical availability
      pGenMaxKw := min(genMaxElecKw, pEngNetAvailKw * genEff);

      // SOC-based traction/charge behavior (Basic mode)
      socSpan := max(0.02, socMax - socMin);
      socDischargeFrac := clamp((pre(soc) - socMin) / socSpan, 0, 1);
      socChargeFrac := clamp((socMax - pre(soc)) / socSpan, 0, 1);
      maxDischargeKw := maxDischargeKwNom * socDischargeFrac;
      maxChargeKw := maxChargeKwNom * socChargeFrac;

      target := max(0.01, socTarget);
      socScale := clamp(pre(soc) / target, 0, 1.5);
      socErrorFrac := 1 - socScale;
      if absReal(socScale - 1) > 0.01 then
        limTracPower := true;
      end if;
      maxTracBySoc := pGenMaxKw * socScale;
      if pTracElecReqKw > maxTracBySoc then
        pTracElecReqKw := maxTracBySoc;
        pWheelsReqKwN := pTracElecReqKw * drivetrainEff;
        pWheelsReqKw := pWheelsReqKwN;
      end if;

      if socErrorFrac > 0 then
        chargeRequestKw := clamp(pGenMaxKw * socErrorFrac, 0, maxChargeKw);
      else
        chargeRequestKw := 0;
      end if;
      demand := pTracElecReqKw + chargeRequestKw;
      pGenElecRawKw := clamp(min(pGenMaxKw, demand), 0, pGenMaxKw);

      // Generator response (discrete 1st-order + ramp limit)
      genTau := clamp(responseTimeSec, 0, 10);
      if genTau > 1e-3 then
        alpha := clamp(dt / genTau, 0, 1);
        pGenElecKwN := pre(pGenElecKw) + (pGenElecRawKw - pre(pGenElecKw)) * alpha;
      else
        pGenElecKwN := pGenElecRawKw;
      end if;

      rampKwPerS := max(0, proRampKwPerS);
      if rampKwPerS > 0 then
        maxDelta := rampKwPerS * dt;
        pGenElecKwN := clamp(pGenElecKwN, pre(pGenElecKw) - maxDelta, pre(pGenElecKw) + maxDelta);
      end if;
      pGenElecKwN := clamp(pGenElecKwN, 0, pGenMaxKw);

      // Battery buffers: traction request minus generator output
      pBattKwN := pTracElecReqKw - pGenElecKwN;

      if pBattKwN > maxDischargeKw then
        pBattKwN := maxDischargeKw;
        limBattDischarge := true;
      end if;
      if pBattKwN < -maxChargeKw then
        pBattKwN := -maxChargeKw;
        limBattCharge := true;
      end if;

      iBatt := (pBattKwN * 1000) / max(1, vNom);
      vBusTmp := vNom - iBatt * rInt;

      iMaxDischarge := (vNom - vMin) / max(0.001, rInt);
      pBattMaxUv := (iMaxDischarge * vNom) / 1000;
      if pBattKwN > pBattMaxUv then
        pBattKwN := pBattMaxUv;
        limBusUv := true;
      end if;

      iMaxCharge := (vMax - vNom) / max(0.001, rInt);
      pBattMinOv := -(iMaxCharge * vNom) / 1000;
      if (pBattKwN < pBattMinOv) and (vBusTmp > vMax + 2) then
        pBattKwN := pBattMinOv;
        limBusOv := true;
      end if;

      // Final (raw) bus voltage after clamps; we also expose a clamped telemetry `vBus`.
      vBusTmp := vNom - ((pBattKwN * 1000) / max(1, vNom)) * rInt;
      vBus := clamp(vBusTmp, vMin, vMax);

      // Electrical traction actually delivered
      pTracElecKwN := pGenElecKwN + pBattKwN;
      if pTracElecKwN > pTracElecReqKw + 1e-6 then
        pGenElecKwN := max(0, pTracElecReqKw - pBattKwN);
        pTracElecKwN := pGenElecKwN + pBattKwN;
      end if;
      if (pTracElecKwN > pTracElecReqKw + 0.01) and (vBusTmp > vMax + 2) then
        pGenElecKwN := max(0, pTracElecReqKw - pBattKwN);
        pTracElecKwN := pGenElecKwN + pBattKwN;
        limBusOv := true;
      end if;

      pWheelsKwN := pTracElecKwN * drivetrainEff;

      pWheelsKw := pWheelsKwN;
      pTracElecKw := pTracElecKwN;
      pGenElecKw := max(0, pGenElecKwN);
      pBattKw := pBattKwN;

      pEngMechKw := pGenElecKw / max(0.01, genEff);
      fuelRateGph := (pEngMechKw / max(0.05, engineEff)) / max(1e-6, fuelKwhPerGallon);

      if pWheelsKwN < pWheelsReqKwN - 0.5 then
        limTracPower := true;
      end if;

      // Longitudinal dynamics
      isRegen := pWheelsKwN < 0;
      fTrac := (pWheelsKwN * 1000) / vEff;
      if isRegen then
        regenForce := absReal(fTrac) * regenForceGain;
      else
        regenForce := 0;
      end if;

      netForce := fTrac - (fDrag + fRoll + fGrade) - regenForce;
      a := netForce / massKg;
      vNext := max(0, v + a * dt);

      vMps := vNext;
      aMps2 := a;
      distanceM := pre(distanceM) + vNext * dt;

      wheelRpmNext := (vNext / wheelCirc) * 60;
      wheelRpm := wheelRpmNext;
      motorRpm := wheelRpmNext * tractionReduction * diffRatio;
      genRpm := rpmNow * stepUpRatio;

      // SOC
      dtHours := dt / 3600;
      socNext := clamp(pre(soc) - (pBattKwN * dtHours) / max(0.1, capacityKwh), socMin, socMax);
      soc := socNext;

      // Energy + fuel
      eTracOutKwh := pre(eTracOutKwh) + pTracElecKwN * dtHours;
      eGenKwh := pre(eGenKwh) + pGenElecKwN * dtHours;
      eBattOutKwh := pre(eBattOutKwh) + max(0, pBattKwN) * dtHours;
      eBattInKwh := pre(eBattInKwh) + max(0, -pBattKwN) * dtHours;
      fuelGallons := pre(fuelGallons) + (pEngMechKw / max(0.05, engineEff)) * (dtHours / fuelKwhPerGallon);

      // Limiter timers
      limTimeTracPower := pre(limTimeTracPower) + (if limTracPower then dt else 0);
      limTimeBattDischarge := pre(limTimeBattDischarge) + (if limBattDischarge then dt else 0);
      limTimeBattCharge := pre(limTimeBattCharge) + (if limBattCharge then dt else 0);
      limTimeBusUv := pre(limTimeBusUv) + (if limBusUv then dt else 0);
      limTimeBusOv := pre(limTimeBusOv) + (if limBusOv then dt else 0);
    end when;
  end EVT2D_Basic;

  model EVT2D_BasicTest
    parameter Real dt = 0.05;

    // Simple constant-input test (matches defaults.ts)
    parameter Real tps = 0.35;
    parameter Real gradePct = 0;

    EVT2D_Basic sim(dt = dt, tps = tps, gradePct = gradePct);
  equation
    annotation(experiment(StartTime = 0, StopTime = 120, Tolerance = 1e-6, Interval = 0.05));
  end EVT2D_BasicTest;

end OpenEVT;
