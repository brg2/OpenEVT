import type { SimConfig } from "./types";

export type BsfcFuel = "gasoline" | "diesel";

export type BsfcProfile = {
  id: string;
  label: string;
  fuel: BsfcFuel;
  bsfcMinOverride?: number;
  bsfcMaxOverride?: number;
  islandTqFrac?: number;
  islandRpmBias?: number;
};

export const BSFC_PROFILES: Record<string, BsfcProfile> = {
  custom: { id: "custom", label: "Custom", fuel: "gasoline" },
  "7.4l-carb": {
    id: "7.4l-carb",
    label: "7.4L Carb",
    fuel: "gasoline",
    bsfcMinOverride: 280,
  },
  "7.4l-efi": { id: "7.4l-efi", label: "7.4L EFI", fuel: "gasoline", bsfcMinOverride: 255 },
  "lq4-6.0l": { id: "lq4-6.0l", label: "GM LQ4 6.0L", fuel: "gasoline", bsfcMinOverride: 255 },
  "5l": { id: "5l", label: "5.0L", fuel: "gasoline", bsfcMinOverride: 250 },
  "3l": { id: "3l", label: "3.0L", fuel: "gasoline", bsfcMinOverride: 240 },
  "2.5l": { id: "2.5l", label: "2.5L", fuel: "gasoline", bsfcMinOverride: 235 },
  "2l": { id: "2l", label: "2.0L", fuel: "gasoline", bsfcMinOverride: 230 },
  "1.5l": { id: "1.5l", label: "1.5L", fuel: "gasoline", bsfcMinOverride: 225 },
  "6bt-400kw": {
    id: "6bt-400kw",
    label: "Cummins 6BT",
    fuel: "diesel",
    bsfcMinOverride: 205,
    islandTqFrac: 0.72,
  },
  "cummins-l9-bus": {
    id: "cummins-l9-bus",
    label: "Cummins L9",
    fuel: "diesel",
    bsfcMinOverride: 200,
    islandTqFrac: 0.75,
    islandRpmBias: -0.05,
  },
};

export type BsfcSpec = {
  rpmMin: number;
  rpmMax: number;
  tqMax: number;
  bsfcMin: number;
  bsfcMax: number;
  islandRpm: number;
  islandTq: number;
  fuel: BsfcFuel;
  label: string;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const buildBsfcSpec = (engine: SimConfig["engine"]): BsfcSpec => {
  const rpmMin = Math.max(500, Math.min(engine.idleRpm, engine.redlineRpm * 0.5));
  const rpmMax = Math.max(rpmMin + 500, engine.redlineRpm);
  const effRpm = Math.max(
    engine.idleRpm,
    Math.min(engine.effRpm || (rpmMin + rpmMax) * 0.5, rpmMax),
  );
  // Use the configured island torque ceiling as the plotted/model torque axis max.
  // This keeps the BSFC surface aligned with the simulator's torque limits.
  const tqMaxFromEngine = Number.isFinite(engine.islandTqMaxNm) ? engine.islandTqMaxNm : 600;
  const tqMax = Math.max(150, Math.min(2600, tqMaxFromEngine));

  const id = engine.bsfcProfileId ?? "custom";
  const prof = BSFC_PROFILES[id] ?? BSFC_PROFILES.custom;

  const bsfcMinFromEff = 75 / Math.max(0.12, engine.engineEff); // ~250 g/kWh at 0.30
  const bsfcMin = Math.max(195, Math.min(310, prof.bsfcMinOverride ?? bsfcMinFromEff));
  const bsfcMax = Math.max(bsfcMin + 80, Math.min(520, prof.bsfcMaxOverride ?? (bsfcMin + 220)));

  const islandRpmBias = prof.islandRpmBias ?? 0;
  const islandRpm = Math.max(
    rpmMin + 200,
    Math.min(rpmMax - 200, effRpm * (1 + islandRpmBias)),
  );
  const islandTqFrac = prof.islandTqFrac ?? 0.62;
  const islandTq = Math.max(
    engine.islandTqMinNm,
    Math.min(tqMax * 0.95, tqMax * islandTqFrac),
  );

  return {
    rpmMin,
    rpmMax,
    tqMax,
    bsfcMin,
    bsfcMax,
    islandRpm,
    islandTq,
    fuel: prof.fuel,
    label: prof.label,
  };
};

export const bsfcValue = (spec: BsfcSpec, rpm: number, tq: number) => {
  const r = clamp01((rpm - spec.rpmMin) / Math.max(1, spec.rpmMax - spec.rpmMin));
  const t = clamp01(tq / Math.max(1, spec.tqMax));
  const rpmBias = spec.fuel === "diesel" ? 0.25 : 0.45;
  const rpmPenalty =
    Math.pow(Math.max(0, r - rpmBias), 1.6) * 110 +
    Math.pow(Math.max(0, rpmBias - r), 1.3) * 70;
  const lowLoadPenalty = Math.pow(Math.max(0, 0.22 - t) / 0.22, 1.8) * 220;
  const highLoadPenalty = Math.pow(Math.max(0, t - 0.92) / 0.08, 1.4) * 60;

  const dr = (rpm - spec.islandRpm) / Math.max(1, spec.rpmMax - spec.rpmMin);
  const dt = (tq - spec.islandTq) / Math.max(1, spec.tqMax);
  const islandPenalty = dr * dr * 220 + dt * dt * 360;

  const base = spec.bsfcMin + islandPenalty + rpmPenalty + lowLoadPenalty + highLoadPenalty;
  return Math.max(spec.bsfcMin, Math.min(spec.bsfcMax, base));
};

export const findBestRpmForTorque = (
  spec: BsfcSpec,
  tqNm: number,
  rpmMin: number,
  rpmMax: number,
  samples = 60,
) => {
  let bestRpm = Math.max(rpmMin, Math.min(rpmMax, spec.islandRpm));
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < samples; i += 1) {
    const u = samples <= 1 ? 0.5 : i / (samples - 1);
    const rpm = rpmMin + (rpmMax - rpmMin) * u;
    const v = bsfcValue(spec, rpm, tqNm);
    if (v < best) {
      best = v;
      bestRpm = rpm;
    }
  }
  return { rpm: bestRpm, bsfc: best };
};

export type BsfcBestPointForPower = {
  rpm: number;
  tq: number;
  pMechKw: number;
  bsfc: number;
};

export const findBestPointForPower = (
  spec: BsfcSpec,
  pMechKw: number,
  rpmMin: number,
  rpmMax: number,
  tqMin: number,
  tqMax: number,
  samples = 70,
): BsfcBestPointForPower | null => {
  if (!(rpmMax > rpmMin)) return null;
  const p = Math.max(0, pMechKw);
  let best: BsfcBestPointForPower | null = null;
  for (let i = 0; i < samples; i += 1) {
    const u = samples <= 1 ? 0.5 : i / (samples - 1);
    const rpm = rpmMin + (rpmMax - rpmMin) * u;
    const tqReq = (p * 9549) / Math.max(1, rpm);
    if (tqReq < tqMin || tqReq > tqMax) continue;
    const bsfc = bsfcValue(spec, rpm, tqReq);
    if (!best || bsfc < best.bsfc) {
      best = { rpm, tq: tqReq, pMechKw: p, bsfc };
    }
  }
  return best;
};
