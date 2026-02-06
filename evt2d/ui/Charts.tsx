import React, { useEffect, useRef } from "react";

interface HistoryBuffer {
  t: number[];
  soc: number[];
  vBus: number[];
  rpm: number[];
  speedMph: number[];
  fuelGph: number[];
  mpg: number[];
  pGen: number[];
  pTrac: number[];
  pBatt: number[];
}

interface ChartsProps {
  history: HistoryBuffer;
  tick: number;
  tractionMaxKw: number;
  busMin: number;
  busMax: number;
}

const drawLine = (
  canvas: HTMLCanvasElement,
  values: number[],
  min: number,
  max: number,
  color: string,
  target?: number,
  hoverIndex?: number,
  band?: { min: number; max: number; color: string },
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(0, 0, w, h);
  if (band) {
    const t0 = (band.min - min) / Math.max(1e-6, max - min);
    const t1 = (band.max - min) / Math.max(1e-6, max - min);
    const y0 = h - Math.max(0, Math.min(1, t0)) * h;
    const y1 = h - Math.max(0, Math.min(1, t1)) * h;
    ctx.strokeStyle = band.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.moveTo(0, y1);
    ctx.lineTo(w, y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * w;
    const t = (v - min) / Math.max(1e-6, max - min);
    const y = h - t * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (typeof target === "number") {
    const t = (target - min) / Math.max(1e-6, max - min);
    const y = h - t * h;
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (typeof hoverIndex === "number" && hoverIndex >= 0 && values.length > 0) {
    const idx = Math.min(values.length - 1, Math.max(0, hoverIndex));
    const v = values[idx];
    const x = (idx / Math.max(1, values.length - 1)) * w;
    const t = (v - min) / Math.max(1e-6, max - min);
    const y = h - t * h;
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
};

const ChartCard: React.FC<{
  title: string;
  values?: number[];
  times?: number[];
  min?: number;
  max?: number;
  color: string;
  tick: number;
  target?: number;
  unit?: string;
  decimals?: number;
  band?: { min: number; max: number; color: string };
}> = ({
  title,
  values,
  times,
  min,
  max,
  color,
  tick,
  target,
  unit,
  decimals = 1,
  band,
}) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);
  const safeValues = values ?? [];
  const safeTimes = times ?? [];
  const lastValue = safeValues.length ? safeValues[safeValues.length - 1] : 0;
  const displayValue = `${lastValue.toFixed(decimals)}${unit ? ` ${unit}` : ""}`;
  const hoverValue =
    hoverIndex !== null && safeValues.length
      ? safeValues[Math.min(safeValues.length - 1, Math.max(0, hoverIndex))]
      : null;
  const hoverTime =
    hoverIndex !== null && safeTimes.length
      ? safeTimes[Math.min(safeTimes.length - 1, Math.max(0, hoverIndex))]
      : null;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    const dataMin = safeValues.length ? Math.min(...safeValues) : 0;
    const dataMax = safeValues.length ? Math.max(...safeValues) : 1;
    const pad = Math.max(1, (dataMax - dataMin) * 0.1);
    const resolvedMin = typeof min === "number" ? min : dataMin - pad;
    const resolvedMax = typeof max === "number" ? max : dataMax + pad;
    drawLine(
      canvas,
      safeValues,
      resolvedMin,
      resolvedMax,
      color,
      target,
      hoverIndex ?? undefined,
      band,
    );
  }, [safeValues, min, max, color, tick, target, hoverIndex, band]);

  return (
    <div>
      <div className="control-row" style={{ marginBottom: 4 }}>
        <label>
          {title} — {displayValue}
        </label>
        {hoverValue !== null && (
          <span className="badge">
            t={hoverTime?.toFixed(1) ?? "--"}s · {hoverValue.toFixed(decimals)}
            {unit ? ` ${unit}` : ""}
          </span>
        )}
      </div>
      <div
        className="chart"
        ref={containerRef}
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const ratio = Math.max(0, Math.min(1, x / rect.width));
          const idx = Math.round(ratio * Math.max(0, safeValues.length - 1));
          setHoverIndex(idx);
        }}
      >
        <canvas ref={ref} />
      </div>
    </div>
  );
};

const Charts: React.FC<ChartsProps> = ({
  history,
  tick,
  tractionMaxKw,
  busMin,
  busMax,
}) => {
  return (
    <>
      <ChartCard
        title="SOC"
        values={history.soc}
        times={history.t}
        min={0}
        max={1}
        color="#79f2c0"
        tick={tick}
        unit=""
        decimals={2}
      />
      <ChartCard
        title="Bus Voltage"
        values={history.vBus}
        times={history.t}
        min={Math.min(busMin - 30, 250)}
        max={Math.max(busMax + 30, 600)}
        color="#47b3ff"
        tick={tick}
        unit="V"
        decimals={0}
        band={{ min: busMin, max: busMax, color: "rgba(71,179,255,0.12)" }}
      />
      <ChartCard
        title="Engine RPM"
        values={history.rpm}
        times={history.t}
        min={600}
        max={6000}
        color="#ffb020"
        tick={tick}
        unit="rpm"
        decimals={0}
      />
      <ChartCard
        title="Vehicle Speed"
        values={history.speedMph}
        times={history.t}
        color="#79d2ff"
        tick={tick}
        unit="mph"
        decimals={1}
      />
      <ChartCard
        title="Fuel Rate"
        values={history.fuelGph}
        times={history.t}
        color="#ffb020"
        tick={tick}
        unit="gph"
        decimals={2}
      />
      <ChartCard
        title="MPG (Last 3s)"
        values={history.mpg}
        times={history.t}
        color="#a6ff9e"
        tick={tick}
        unit="mpg"
        decimals={1}
      />
      <ChartCard
        title="Generator Power (kW)"
        values={history.pGen}
        times={history.t}
        color="#47b3ff"
        tick={tick}
        unit="kW"
        decimals={1}
      />
      <ChartCard
        title="Traction Power (kW)"
        values={history.pTrac}
        times={history.t}
        color="#9aa4ff"
        tick={tick}
        target={tractionMaxKw}
        unit="kW"
        decimals={1}
      />
      <ChartCard
        title="Battery Power (kW)"
        values={history.pBatt}
        times={history.t}
        color="#ff6b6b"
        tick={tick}
        unit="kW"
        decimals={1}
      />
    </>
  );
};

export default Charts;
