import React, { useEffect, useMemo, useRef, useState } from "react";
import { defaultConfig, defaultInputs } from "./sim/defaults";
import type { ExportPayload, SimConfig, SimInputs, SimState } from "./sim/types";
import Controls from "./ui/Controls";
import Diagram from "./ui/Diagram";
import Charts from "./ui/Charts";
import Stats from "./ui/Stats";

const HISTORY_SECONDS = 120;
const SAMPLE_RATE = 20;
const HISTORY_MAX = HISTORY_SECONDS * SAMPLE_RATE;
const STORAGE_KEY = "openevt-2d-sim";
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

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

const createHistory = (): HistoryBuffer => ({
  t: [],
  soc: [],
  vBus: [],
  rpm: [],
  speedMph: [],
  fuelGph: [],
  mpg: [],
  pGen: [],
  pTrac: [],
  pBatt: [],
});

const pushHistory = (history: HistoryBuffer, state: SimState) => {
  // Hot reload can add new series fields; if series lengths get out of sync,
  // reset buffers so derived charts (like MPG) don't compute nonsense/zeros.
  if (
    !history.fuelGph ||
    !history.mpg ||
    history.fuelGph.length !== history.t.length ||
    history.mpg.length !== history.t.length
  ) {
    Object.assign(history, createHistory());
  }

  const push = (arr: number[] | undefined, value: number) => {
    if (!arr) return;
    arr.push(value);
    if (arr.length > HISTORY_MAX) arr.shift();
  };
  push(history.t, state.timeSec);
  push(history.soc, state.soc);
  push(history.vBus, state.vBus);
  push(history.rpm, state.rpm);
  push(history.speedMph, (state.vMps / 0.44704));
  push(history.fuelGph, state.fuelRateGph);

  // Moving average MPG based on fuel rate (last 3s): MPG ~= avgSpeedMph / avgFuelGph.
  const lookbackSec = 3;
  const t0 = state.timeSec - lookbackSec;
  let idx0 = 0;
  while (idx0 < history.t.length - 1 && history.t[idx0] < t0) idx0 += 1;
  const sSlice = history.speedMph.slice(idx0);
  const fSlice = history.fuelGph.slice(idx0);
  const avg = (arr: number[]) =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const avgSpeed = avg(sSlice);
  const avgFuel = avg(fSlice);
  const mpgRaw = avgFuel > 1e-6 ? avgSpeed / avgFuel : 1000;
  const mpg60 = Math.min(1000, Math.max(0, mpgRaw));
  push(history.mpg, mpg60);
  push(history.pGen, state.pGenElecKw);
  push(history.pTrac, state.pTracElecKw);
  push(history.pBatt, state.pBattKw);
};

const mergeConfig = (base: SimConfig, incoming?: Partial<SimConfig>): SimConfig => {
  if (!incoming) return structuredClone(base);
  return {
    ...base,
    ...incoming,
    vehicle: { ...base.vehicle, ...incoming.vehicle },
    battery: { ...base.battery, ...incoming.battery },
    engine: { ...base.engine, ...incoming.engine },
    generator: { ...base.generator, ...incoming.generator },
    bus: { ...base.bus, ...incoming.bus },
  };
};

const downloadJson = (payload: ExportPayload) => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "openevt-2d-sim-export.json";
  a.click();
  URL.revokeObjectURL(url);
};

const App: React.FC = () => {
  const [config, setConfig] = useState<SimConfig>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          config?: SimConfig;
          inputs?: SimInputs;
          speed?: number;
        };
        if (parsed?.config) {
          const merged = mergeConfig(defaultConfig, parsed.config);
          if ((merged as any).mode === "base" || (merged as any).mode === "pro") {
            merged.mode = "basic";
          }
          // Migrate older configs.
          if ((merged.vehicle as any).wheelPowerMaxKw && !merged.vehicle.motorPeakPowerKw) {
            const wheelPeak = Number((merged.vehicle as any).wheelPowerMaxKw);
            merged.vehicle.motorPeakPowerKw = wheelPeak / Math.max(0.01, merged.vehicle.drivetrainEff);
          }
          if (!merged.vehicle.motorMaxRpm) merged.vehicle.motorMaxRpm = 11000;
          if (!merged.vehicle.regenForceGain) merged.vehicle.regenForceGain = 1;
          if (!merged.vehicle.regenMaxSoc) merged.vehicle.regenMaxSoc = merged.battery.socMax;
          return merged;
        }
      }
    } catch {
      // ignore
    }
    return structuredClone(defaultConfig);
  });
  const [inputs, setInputs] = useState<SimInputs>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          config?: SimConfig;
          inputs?: SimInputs;
          speed?: number;
        };
        if (parsed?.inputs) {
          const tps = typeof parsed.inputs.tps === "number" ? parsed.inputs.tps : defaultInputs.tps;
          return { ...defaultInputs, ...parsed.inputs, aps: clamp01(tps) };
        }
      }
    } catch {
      // ignore
    }
    return structuredClone(defaultInputs);
  });
  const [simState, setSimState] = useState<SimState | null>(null);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { speed?: number };
        if (typeof parsed.speed === "number") return parsed.speed;
      }
    } catch {
      // ignore
    }
    return 1;
  });
  const [recording, setRecording] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [renderTick, setRenderTick] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const historyRef = useRef<HistoryBuffer>(createHistory());
  const lastHistoryTimeRef = useRef<number>(-Infinity);

  useEffect(() => {
    const worker = new Worker(new URL("./worker/simWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.postMessage({ type: "init", config, inputs });
    worker.postMessage({ type: "setSpeed", speed });

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "snapshot") {
        const nextState = data.state as SimState;
        setSimState(nextState);
        if (nextState.timeSec > lastHistoryTimeRef.current + 1e-6) {
          pushHistory(historyRef.current, nextState);
          lastHistoryTimeRef.current = nextState.timeSec;
        }
        setRenderTick((tick) => tick + 1);
      }
      if (data.type === "export") {
        downloadJson(data.payload as ExportPayload);
      }
    };

    return () => worker.terminate();
  }, []);

  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "setSpeed", speed });
    }
  }, [speed]);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          config,
          inputs,
          speed,
        }),
      );
    } catch {
      // ignore
    }
  }, [config, inputs, speed]);

  const mapTpsToAps = (tps: number) => clamp01(tps);

  const updateInputs = (patch: Partial<SimInputs>) => {
    setInputs((prev) => {
      let next = { ...prev, ...patch };
      if (typeof patch.tps === "number") {
        next = { ...next, aps: mapTpsToAps(patch.tps) };
      } else if (typeof patch.aps === "number") {
        next = { ...next, aps: mapTpsToAps(next.tps) };
      }
      workerRef.current?.postMessage({ type: "setInputs", inputs: next });
      return next;
    });
  };

  const updateConfig = (patch: Partial<SimConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch } as SimConfig;
      workerRef.current?.postMessage({ type: "setConfig", config: patch });
      return next;
    });
  };

  const handleToggleRun = () => {
    setRunning((prev) => {
      const next = !prev;
      workerRef.current?.postMessage({ type: "setRunning", running: next });
      return next;
    });
  };

  const handleReset = () => {
    workerRef.current?.postMessage({ type: "reset" });
    historyRef.current = createHistory();
    lastHistoryTimeRef.current = -Infinity;
  };

  const handleSpeed = (nextSpeed: number) => {
    setSpeed(nextSpeed);
    workerRef.current?.postMessage({ type: "setSpeed", speed: nextSpeed });
  };

  const handleRecord = () => {
    setRecording(true);
    workerRef.current?.postMessage({ type: "startRecording" });
  };

  const handleStopRecord = () => {
    setRecording(false);
    workerRef.current?.postMessage({ type: "stopRecording" });
  };

  const handleReplay = () => {
    setReplaying(true);
    workerRef.current?.postMessage({ type: "startReplay" });
  };

  const handleStopReplay = () => {
    setReplaying(false);
    workerRef.current?.postMessage({ type: "stopReplay" });
  };

  const handleExport = () => {
    workerRef.current?.postMessage({ type: "requestExport" });
  };

  const metrics = useMemo(() => {
    if (!simState) return null;
    const distanceMiles = simState.distanceM / 1609.34;
    const whPerMi =
      distanceMiles > 0 ? (simState.energy.eTracOutKwh * 1000) / distanceMiles : 0;
    const avgBusPower =
      simState.timeSec > 0 ? simState.energy.eTracOutKwh / (simState.timeSec / 3600) : 0;
    return {
      distanceMiles,
      whPerMi,
      avgBusPowerKw: avgBusPower,
    };
  }, [simState]);

  return (
    <div className="app">
      <div className="header">
        <div>
          <h1>OpenEVT 2D Real-Time System Simulator</h1>
          <div className="badge">t = {simState?.timeSec.toFixed(1) ?? "0.0"}s</div>
        </div>
        <div className="mode">
          <span className="badge">Mode</span>
          <span className="badge">Basic (Rectifier)</span>
        </div>
      </div>

      <div className="panel controls">
        <Controls
          inputs={inputs}
          config={config}
          running={running}
          speed={speed}
          recording={recording}
          replaying={replaying}
          onInputs={updateInputs}
          onConfig={updateConfig}
          onToggleRun={handleToggleRun}
          onReset={handleReset}
          onSpeed={handleSpeed}
          onRecord={handleRecord}
          onStopRecord={handleStopRecord}
          onReplay={handleReplay}
          onStopReplay={handleStopReplay}
          onExport={handleExport}
        />
      </div>

      <div className="panel diagram">
        <Diagram state={simState} config={config} />
      </div>

      <div className="panel chart-grid">
        <Charts
          history={historyRef.current}
          tick={renderTick}
          tractionMaxKw={config.vehicle.motorPeakPowerKw * config.vehicle.drivetrainEff}
          busMin={config.bus.vMin}
          busMax={config.bus.vMax}
        />
        <Stats
          state={simState}
          distanceMiles={metrics?.distanceMiles ?? 0}
          whPerMi={metrics?.whPerMi ?? 0}
          avgBusPowerKw={metrics?.avgBusPowerKw ?? 0}
        />
      </div>
    </div>
  );
};

export default App;
