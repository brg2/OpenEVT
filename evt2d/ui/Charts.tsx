import React, { useEffect, useRef } from "react";

interface HistoryBuffer {
  t: number[];
  soc: number[];
  vBus: number[];
  rpm: number[];
  pGen: number[];
  pTrac: number[];
  pBatt: number[];
}

interface ChartsProps {
  history: HistoryBuffer;
  tick: number;
  tractionMaxKw: number;
}

const drawLine = (
  canvas: HTMLCanvasElement,
  values: number[],
  min: number,
  max: number,
  color: string,
  target?: number,
) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.02)";
  ctx.fillRect(0, 0, w, h);
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
};

const ChartCard: React.FC<{
  title: string;
  values: number[];
  min?: number;
  max?: number;
  color: string;
  tick: number;
  target?: number;
}> = ({ title, values, min, max, color, tick, target }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    const dataMin = values.length ? Math.min(...values) : 0;
    const dataMax = values.length ? Math.max(...values) : 1;
    const pad = Math.max(1, (dataMax - dataMin) * 0.1);
    const resolvedMin = typeof min === "number" ? min : dataMin - pad;
    const resolvedMax = typeof max === "number" ? max : dataMax + pad;
    drawLine(canvas, values, resolvedMin, resolvedMax, color, target);
  }, [values, min, max, color, tick, target]);

  return (
    <div>
      <div className="control-row" style={{ marginBottom: 6 }}>
        <label>{title}</label>
      </div>
      <div className="chart">
        <canvas ref={ref} />
      </div>
    </div>
  );
};

const Charts: React.FC<ChartsProps> = ({ history, tick, tractionMaxKw }) => {
  return (
    <>
      <ChartCard
        title="SOC"
        values={history.soc}
        min={0}
        max={1}
        color="#79f2c0"
        tick={tick}
      />
      <ChartCard
        title="Bus Voltage"
        values={history.vBus}
        min={450}
        max={800}
        color="#47b3ff"
        tick={tick}
      />
      <ChartCard
        title="Engine RPM"
        values={history.rpm}
        min={600}
        max={6000}
        color="#ffb020"
        tick={tick}
      />
      <ChartCard
        title="Generator Power (kW)"
        values={history.pGen}
        color="#47b3ff"
        tick={tick}
      />
      <ChartCard
        title="Traction Power (kW)"
        values={history.pTrac}
        color="#9aa4ff"
        tick={tick}
        target={tractionMaxKw}
      />
      <ChartCard
        title="Battery Power (kW)"
        values={history.pBatt}
        color="#ff6b6b"
        tick={tick}
      />
    </>
  );
};

export default Charts;
