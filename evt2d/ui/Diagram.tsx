import React, { useEffect, useMemo, useRef } from "react";
import type { SimConfig, SimState } from "../sim/types";
import type { BsfcFuel } from "../sim/bsfc";
import { bsfcValue, buildBsfcSpec } from "../sim/bsfc";

interface DiagramProps {
  state: SimState | null;
  config: SimConfig;
}

const toMph = (mps: number) => mps / 0.44704;

const flowWidth = (kw: number) => {
  const mag = Math.min(1, Math.abs(kw) / 200);
  return 2 + mag * 8;
};

const flowColor = (kw: number, positive: string, negative: string) =>
  kw >= 0 ? positive : negative;

const niceTicks = (min: number, max: number, desired = 6) => {
  if (!(max > min)) return [min];
  const span = max - min;
  const rawStep = span / Math.max(1, desired - 1);
  const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const steps = [1, 2, 2.5, 5, 10].map((k) => k * pow10);
  let step = steps[steps.length - 1];
  for (const s of steps) {
    if (rawStep <= s) {
      step = s;
      break;
    }
  }
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step * 0.5; v += step) out.push(v);
  return out;
};

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

const bsfcColormap = (u01: number) => {
  // u01 = (bsfc - min) / (max - min)
  // IMPORTANT: low BSFC (u=0) => deep red (highest efficiency)
  //            high BSFC (u=1) => deep blue/purple (lowest efficiency)
  const u = clamp01(u01);
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [120, 0, 0]], // deep red
    [0.16, [200, 20, 0]], // red-orange
    [0.33, [255, 150, 0]], // orange
    [0.5, [245, 235, 70]], // yellow
    [0.66, [75, 210, 120]], // green
    [0.82, [60, 190, 235]], // cyan
    [1.0, [70, 70, 190]], // blue/purple
  ];
  let i = 0;
  while (i < stops.length - 2 && u > stops[i + 1][0]) i += 1;
  const [u0, c0] = stops[i];
  const [u1, c1] = stops[i + 1];
  const t = (u - u0) / Math.max(1e-6, u1 - u0);
  const r = Math.round(lerp(c0[0], c1[0], t));
  const g = Math.round(lerp(c0[1], c1[1], t));
  const b = Math.round(lerp(c0[2], c1[2], t));
  return { r, g, b };
};

const gramsPerGallon = (fuel: BsfcFuel) => (fuel === "diesel" ? 3200 : 2800);

const rpmToOmega = (rpm: number) => (rpm * 2 * Math.PI) / 60;

const TractionTorqueBand: React.FC<{
  state: SimState | null;
  config: SimConfig;
}> = ({ state, config }) => {
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const dims = useMemo(() => {
    const w = 860;
    const h = 140;
    const padL = 58;
    const padR = 20;
    const padT = 18;
    const padB = 30;
    return { w, h, padL, padR, padT, padB };
  }, []);

  const model = useMemo(() => {
    const vehicle = config.vehicle;
    const overall = Math.max(1e-6, vehicle.tractionReduction * vehicle.diffRatio);
    const eff = clamp(vehicle.drivetrainEff, 0.01, 1);

    const rpmMax = Math.max(1000, vehicle.motorMaxRpm);
    const rpmMin = Math.min(900, Math.max(300, rpmMax * 0.06));

    const pCapKw = Math.max(
      0,
      state?.pTracCapKw ?? vehicle.motorPeakPowerKw,
    );

    const wheelTqFromPower = (pKw: number, motorRpm: number) => {
      const rpm = Math.max(rpmMin, Math.min(rpmMax, motorRpm));
      const omega = Math.max(1e-3, rpmToOmega(rpm));
      const motorTqNm = (pKw * 1000) / omega;
      return motorTqNm * overall * eff;
    };

    const markerRpm = clamp(state?.motorRpm ?? 0, rpmMin, rpmMax);
    const markerPkw = state?.pTracElecKw ?? 0;
    const markerWheelTq = clamp(wheelTqFromPower(markerPkw, markerRpm), 0, 1e9);

    const tqRef = wheelTqFromPower(Math.max(1, pCapKw), Math.max(rpmMin, 800));
    const yMax = clamp(
      Math.max(2000, tqRef * 1.15, Math.abs(markerWheelTq) * 1.25),
      2000,
      90000,
    );

    return {
      rpmMin,
      rpmMax,
      yMax,
      pCapKw,
      markerRpm,
      markerWheelTq,
      wheelTqFromPower,
    };
  }, [config.vehicle, state?.motorRpm, state?.pTracCapKw, state?.pTracElecKw]);

  useEffect(() => {
    const c = bgRef.current;
    if (!c) return;
    const { w, h, padL, padR, padT, padB } = dims;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0f1721";
    ctx.fillRect(0, 0, w, h);

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    const xTicks = niceTicks(model.rpmMin, model.rpmMax, 6);
    for (const rpm of xTicks) {
      const u = (rpm - model.rpmMin) / Math.max(1, model.rpmMax - model.rpmMin);
      const x = padL + u * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
    }
    const yTicks = niceTicks(0, model.yMax, 5);
    for (const tq of yTicks) {
      const u = tq / Math.max(1, model.yMax);
      const y = padT + plotH - u * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
    }

    // Header
    ctx.fillStyle = "#93a4b5";
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillText("Traction Torque Band (wheel)", padL, 14);
    ctx.fillText(`${Math.round(model.pCapKw)} kW cap`, padL + 210, 14);

    // X ticks
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    for (const rpm of xTicks) {
      const u = (rpm - model.rpmMin) / Math.max(1, model.rpmMax - model.rpmMin);
      const x = padL + u * plotW;
      ctx.fillText(`${Math.round(rpm)}`, x - 14, padT + plotH + 18);
    }
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText("motor rpm", padL + plotW - 56, padT + plotH + 18);

    // Y ticks
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    for (const tq of yTicks) {
      const u = tq / Math.max(1, model.yMax);
      const y = padT + plotH - u * plotH;
      ctx.fillText(`${Math.round(tq)}`, 8, y + 4);
    }
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText("Nm", 30, padT + 10);

    // Curve
    const n = 80;
    ctx.strokeStyle = "#9aa4ff";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const u = n <= 1 ? 0 : i / (n - 1);
      const rpm = model.rpmMin + (model.rpmMax - model.rpmMin) * u;
      const tq = model.wheelTqFromPower(model.pCapKw, rpm);
      const x = padL + u * plotW;
      const y = padT + plotH - (tq / Math.max(1, model.yMax)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.lineTo(padL, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = "rgba(154,164,255,0.10)";
    ctx.fill();
  }, [dims, model]);

  useEffect(() => {
    const c = overlayRef.current;
    if (!c) return;
    const { w, h, padL, padR, padT, padB } = dims;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const uX = (model.markerRpm - model.rpmMin) / Math.max(1, model.rpmMax - model.rpmMin);
    const x = padL + clamp01(uX) * plotW;
    const y = padT + plotH - (clamp(model.markerWheelTq, 0, model.yMax) / Math.max(1, model.yMax)) * plotH;

    // Crosshair
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    // Marker
    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Tag
    const tag = `${Math.round(model.markerRpm)} rpm · ${Math.round(model.markerWheelTq)} Nm`;
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    const m = ctx.measureText(tag);
    const tagW = m.width + 14;
    const tagH = 20;
    const tx = Math.min(w - 10 - tagW, Math.max(10, x + 10));
    const ty = Math.max(10, Math.min(h - tagH - 8, y - 28));
    ctx.fillStyle = "rgba(15,23,33,0.85)";
    ctx.fillRect(tx, ty, tagW, tagH);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.strokeRect(tx, ty, tagW, tagH);
    ctx.fillStyle = "#e6eef7";
    ctx.fillText(tag, tx + 7, ty + 14);
  }, [dims, model.markerRpm, model.markerWheelTq, model.rpmMin, model.rpmMax, model.yMax]);

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={bgRef}
        style={{ width: "100%", height: "140px", borderRadius: 12, display: "block" }}
      />
      <canvas
        ref={overlayRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "140px",
          borderRadius: 12,
          pointerEvents: "none",
        }}
      />
    </div>
  );
};

const BsfcIslandMap: React.FC<{
  state: SimState | null;
  config: SimConfig;
}> = ({ state, config }) => {
  const spec = useMemo(() => buildBsfcSpec(config.engine), [config.engine]);
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  const dims = useMemo(() => {
    const w = 860;
    const h = 240;
    const padL = 56;
    const padR = 60;
    const padT = 18;
    const padB = 36;
    return { w, h, padL, padR, padT, padB };
  }, []);

  const marker = useMemo(() => {
    const rpm = state?.rpm ?? 0;
    const pEngMechKw = state?.pEngMechKw ?? 0;
    const tq = rpm > 10 ? (pEngMechKw * 9549) / rpm : 0;
    return { rpm, tq };
  }, [state?.rpm, state?.pEngMechKw]);

  const markerText = useMemo(() => {
    const rpm = marker.rpm;
    const tq = marker.tq;
    if (!state) return "—";
    if (state.engineMode !== "island" || state.pEngMechKw <= 0.5) return "battery-only / no gen load";
    const bsfc = bsfcValue(spec, rpm, tq);
    return `${Math.round(rpm)} rpm · ${Math.round(tq)} Nm · ${Math.round(bsfc)} g/kWh`;
  }, [marker.rpm, marker.tq, spec, state]);

  useEffect(() => {
    const c = bgRef.current;
    if (!c) return;
    const { w, h, padL, padR, padT, padB } = dims;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = "#0f1721";
    ctx.fillRect(0, 0, w, h);

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // Heatmap
    const nx = 120;
    const ny = 70;
    const cellW = plotW / nx;
    const cellH = plotH / ny;
    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const rpm = lerp(spec.rpmMin, spec.rpmMax, (ix + 0.5) / nx);
        const tq = lerp(0, spec.tqMax, 1 - (iy + 0.5) / ny);
        const bsfc = bsfcValue(spec, rpm, tq);
        const u = (bsfc - spec.bsfcMin) / Math.max(1e-6, spec.bsfcMax - spec.bsfcMin);
        const col = bsfcColormap(u);
        ctx.fillStyle = `rgb(${col.r},${col.g},${col.b})`;
        ctx.fillRect(padL + ix * cellW, padT + iy * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // Grid + axes
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(padL, padT, plotW, plotH);
    ctx.stroke();

    const xTicks = niceTicks(spec.rpmMin, spec.rpmMax, 7);
    const yTicks = niceTicks(0, spec.tqMax, 6);

    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = "#c9d4df";

    for (const xt of xTicks) {
      const x = padL + ((xt - spec.rpmMin) / (spec.rpmMax - spec.rpmMin)) * plotW;
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = "#aebdcb";
      ctx.fillText(String(Math.round(xt)), x - 14, padT + plotH + 20);
    }

    for (const yt of yTicks) {
      const y = padT + plotH - (yt / Math.max(1e-6, spec.tqMax)) * plotH;
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = "#aebdcb";
      ctx.fillText(String(Math.round(yt)), 10, y + 4);
    }

    // Axis labels
    ctx.fillStyle = "#d9e1ea";
    ctx.fillText("Engine Speed (rpm)", padL + plotW * 0.38, h - 10);
    ctx.save();
    ctx.translate(14, padT + plotH * 0.65);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Engine Torque (Nm)", 0, 0);
    ctx.restore();

    // Title + profile tag
    ctx.fillStyle = "#d9e1ea";
    ctx.fillText(`BSFC Map — ${spec.label}`, padL, 14);

    // Colorbar
    const barX = w - padR + 18;
    const barY = padT;
    const barW = 16;
    const barH = plotH;
    const grad = ctx.createLinearGradient(0, barY, 0, barY + barH);
    for (let i = 0; i <= 10; i += 1) {
      const p = i / 10; // 0=top, 1=bottom
      const col = bsfcColormap(1 - p);
      grad.addColorStop(p, `rgb(${col.r},${col.g},${col.b})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.fillStyle = "#aebdcb";
    ctx.fillText("g/kWh", barX - 2, barY - 6);
    const cbTicks = 5;
    for (let i = 0; i <= cbTicks; i += 1) {
      const u = i / cbTicks;
      const v = spec.bsfcMax - (spec.bsfcMax - spec.bsfcMin) * u;
      const y = barY + barH * u;
      ctx.fillText(String(Math.round(v)), barX + 22, y + 4);
    }
  }, [dims, spec]);

  useEffect(() => {
    const c = overlayRef.current;
    if (!c) return;
    const { w, h, padL, padR, padT, padB } = dims;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const rpm = Math.max(spec.rpmMin, Math.min(spec.rpmMax, marker.rpm));
    const tq = Math.max(0, Math.min(spec.tqMax, marker.tq));
    const x = padL + ((rpm - spec.rpmMin) / (spec.rpmMax - spec.rpmMin)) * plotW;
    const y = padT + plotH - (tq / Math.max(1e-6, spec.tqMax)) * plotH;

    // Crosshair + marker
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();

    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Small value tag
    const bsfcModel = bsfcValue(spec, rpm, tq);
    const bsfcActual =
      state && state.engineMode === "island" && state.pEngMechKw > 0.5
        ? (Math.max(0, state.fuelRateGph) * gramsPerGallon(spec.fuel)) /
          Math.max(1e-6, state.pEngMechKw)
        : null;
    const bsfcDisp = bsfcActual ?? bsfcModel;
    const tag = `${Math.round(rpm)} rpm · ${Math.round(tq)} Nm · ${Math.round(bsfcDisp)} g/kWh`;
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    const m = ctx.measureText(tag);
    const tagW = m.width + 14;
    const tagH = 20;
    const tx = Math.min(w - 10 - tagW, Math.max(10, x + 10));
    const ty = Math.max(10, y - 28);
    ctx.fillStyle = "rgba(15,23,33,0.85)";
    ctx.fillRect(tx, ty, tagW, tagH);
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.strokeRect(tx, ty, tagW, tagH);
    ctx.fillStyle = "#e6eef7";
    ctx.fillText(tag, tx + 7, ty + 14);
  }, [dims, marker.rpm, marker.tq, spec, state]);

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={bgRef}
        style={{ width: "100%", height: "240px", borderRadius: 12, display: "block" }}
      />
      <canvas
        ref={overlayRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "240px",
          borderRadius: 12,
          pointerEvents: "none",
        }}
      />
      <div className="control-row" style={{ marginTop: 6 }}>
        <label>BSFC Point</label>
        <span className="badge">{markerText}</span>
      </div>
    </div>
  );
};

const Diagram: React.FC<DiagramProps> = ({ state, config }) => {
  const pEng = state?.pEngMechKw ?? 0;
  const pGen = state?.pGenElecKw ?? 0;
  const pBatt = state?.pBattKw ?? 0;
  const pTrac = state?.pTracElecKw ?? 0;
  const pWheels = state?.pWheelsKw ?? 0;

  const limiter = state?.limiter;
  const motorRpm = state?.motorRpm ?? 0;
  const motorMaxRpm = config.vehicle.motorMaxRpm;
  const engineRpm = state?.rpm ?? 0;
  const engineRedline = config.engine.redlineRpm;
  const motorSoftStart = motorMaxRpm * 0.95;
  const motorRpmLimited = motorRpm >= motorSoftStart && motorMaxRpm > 0;
  const engineRedlineLimited = engineRpm >= engineRedline * 0.98 && engineRedline > 0;
  const tireM = (config.vehicle.tireDiameterIn * 0.0254) || 0.7;
  const wheelCirc = Math.max(0.01, Math.PI * tireM);
  const overall = Math.max(
    1e-6,
    config.vehicle.tractionReduction * config.vehicle.diffRatio,
  );
  const topMpsAtMotorLimit = ((motorMaxRpm / overall) / 60) * wheelCirc;
  const topMphAtMotorLimit = toMph(topMpsAtMotorLimit);

  return (
    <div style={{ height: "100%", position: "relative", display: "flex", flexDirection: "column", gap: 12 }}>
      <svg viewBox="0 0 900 520" role="img" style={{ width: "100%", height: "auto" }}>
        <defs>
          <linearGradient id="node" x1="0" x2="1">
            <stop offset="0%" stopColor="#1c2634" />
            <stop offset="100%" stopColor="#0f1721" />
          </linearGradient>
        </defs>

        <rect x="40" y="40" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="60" y="80" fill="#d9e1ea" fontSize="16">
          ICE Engine
        </text>
        <text x="60" y="105" fill="#7f92a6" fontSize="13">
          {state?.engineMode === "island" ? "ISLAND" : "IDLE"} · TPS {((state?.tpsCmd ?? 0) * 100).toFixed(0)}% · {Math.round((state?.rpm ?? 0))} rpm
        </text>

        <rect x="300" y="40" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="320" y="80" fill="#d9e1ea" fontSize="16">
          Generator
        </text>
        <text x="320" y="105" fill="#7f92a6" fontSize="13">
          Rectifier
        </text>

        <rect x="560" y="40" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="580" y="80" fill="#d9e1ea" fontSize="16">
          HV DC Bus
        </text>
        <text x="580" y="105" fill="#7f92a6" fontSize="13">
          {state ? state.vBus.toFixed(0) : "--"} V
        </text>

        <rect x="560" y="190" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="580" y="230" fill="#d9e1ea" fontSize="16">
          Battery
        </text>
        <text x="580" y="255" fill="#7f92a6" fontSize="13">
          SOC {(state?.soc ?? 0).toFixed(2)}
        </text>

        <rect x="300" y="330" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="320" y="370" fill="#d9e1ea" fontSize="16">
          Traction Inverter
        </text>
        <text x="320" y="395" fill="#7f92a6" fontSize="13">
          APS {Math.round((state?.pWheelsReqKw ?? 0))} kW req
        </text>

        <rect x="40" y="330" width="200" height="90" rx="16" fill="url(#node)" stroke="#2a3647" />
        <text x="60" y="370" fill="#d9e1ea" fontSize="16">
          Wheels
        </text>
        <text x="60" y="395" fill="#7f92a6" fontSize="13">
          {Math.round(pWheels)} kW
        </text>

        <line
          x1="240"
          y1="85"
          x2="300"
          y2="85"
          stroke={flowColor(pEng, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pEng)}
        />
        <text x="250" y="70" fill="#a6b6c6" fontSize="12">
          {pEng.toFixed(1)} kW
        </text>

        <line
          x1="500"
          y1="85"
          x2="560"
          y2="85"
          stroke={flowColor(pGen, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pGen)}
        />
        <text x="510" y="70" fill="#a6b6c6" fontSize="12">
          {pGen.toFixed(1)} kW
        </text>

        <line
          x1="660"
          y1="130"
          x2="660"
          y2="190"
          stroke={flowColor(-pBatt, "#79f2c0", "#ffb020")}
          strokeWidth={flowWidth(pBatt)}
        />
        <text x="672" y="165" fill="#a6b6c6" fontSize="12">
          {pBatt.toFixed(1)} kW
        </text>

        <line
          x1="560"
          y1="85"
          x2="500"
          y2="330"
          stroke={flowColor(pTrac, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pTrac)}
        />
        <text x="500" y="220" fill="#a6b6c6" fontSize="12">
          {pTrac.toFixed(1)} kW
        </text>

        <line
          x1="300"
          y1="375"
          x2="240"
          y2="375"
          stroke={flowColor(pWheels, "#47b3ff", "#79f2c0")}
          strokeWidth={flowWidth(pWheels)}
        />
        <text x="250" y="360" fill="#a6b6c6" fontSize="12">
          {pWheels.toFixed(1)} kW
        </text>
      </svg>

      <div style={{ position: "absolute", top: 16, right: 16, display: "grid", gap: 6 }}>
        {motorRpmLimited && (
          <span className="badge warn">
            Motor RPM Limit ({Math.round(motorRpm)}/{Math.round(motorMaxRpm)}) · ~{topMphAtMotorLimit.toFixed(0)} mph
          </span>
        )}
        {engineRedlineLimited && (
          <span className="badge warn">
            Engine Near Redline ({Math.round(engineRpm)}/{Math.round(engineRedline)})
          </span>
        )}
        {limiter?.battDischarge && (
          <span className="badge warn">Battery Discharge Limit</span>
        )}
        {limiter?.battCharge && (
          <span className="badge warn">Battery Charge Limit</span>
        )}
        {limiter?.busUv && <span className="badge danger">Bus Undervoltage</span>}
        {limiter?.busOv && <span className="badge danger">Bus Overvoltage</span>}
      </div>

      <BsfcIslandMap state={state} config={config} />
      <TractionTorqueBand state={state} config={config} />
    </div>
  );
};

export default Diagram;
