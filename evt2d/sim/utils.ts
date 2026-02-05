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
): number => {
  const mid = lerp(idle, redline, 0.55);
  const low = lerp(idle, redline, 0.25);
  const high = lerp(idle, redline, 0.85);
  if (rpm <= low) return lerp(0.3, 0.85, (rpm - idle) / (low - idle));
  if (rpm <= mid) return lerp(0.85, 1.0, (rpm - low) / (mid - low));
  if (rpm <= high) return lerp(1.0, 0.8, (rpm - mid) / (high - mid));
  if (rpm <= redline) return lerp(0.8, 0.55, (rpm - high) / (redline - high));
  return 0.45;
};

export const toMps = (mph: number) => mph * 0.44704;
export const toMph = (mps: number) => mps / 0.44704;

export const sign = (v: number) => (v < 0 ? -1 : 1);
