export const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export const rpmShape = (
  rpm: number,
  idle: number,
  redline: number,
  effRpm?: number,
): number => {
  const span = Math.max(1, redline - idle);
  const x = clamp((rpm - idle) / span, 0, 1.2);
  const xEffRaw =
    typeof effRpm === "number" && Number.isFinite(effRpm)
      ? (effRpm - idle) / span
      : 0.55;
  const xEff = clamp(xEffRaw, 0.15, 0.95);
  const xLow = clamp(xEff * 0.55, 0.05, xEff - 0.01);
  // For xEff=0.55, this yields xHigh≈0.85 (matching the old curve).
  const xHigh = clamp(xEff + (1 - xEff) * 0.67, xEff + 0.01, 1.0);

  const at = (a: number, b: number, t: number) => lerp(a, b, clamp(t, 0, 1));

  if (x <= xLow) return at(0.3, 0.85, (x - 0) / Math.max(1e-6, xLow - 0));
  if (x <= xEff) return at(0.85, 1.0, (x - xLow) / Math.max(1e-6, xEff - xLow));
  if (x <= xHigh) return at(1.0, 0.8, (x - xEff) / Math.max(1e-6, xHigh - xEff));
  if (x <= 1.0) return at(0.8, 0.55, (x - xHigh) / Math.max(1e-6, 1.0 - xHigh));
  return 0.45;
};

export const toMps = (mph: number) => mph * 0.44704;
export const toMph = (mps: number) => mps / 0.44704;

export const sign = (v: number) => (v < 0 ? -1 : 1);
