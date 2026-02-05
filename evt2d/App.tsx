import React, { useEffect, useMemo, useRef, useState } from "react";
import { defaultConfig, defaultInputs } from "./sim/defaults";
import type {
  ExportPayload,
  ScriptedPoint,
  SimConfig,
  SimInputs,
  SimState,
} from "./sim/types";
import Controls from "./ui/Controls";
import Diagram from "./ui/Diagram";
import Charts from "./ui/Charts";
import Stats from "./ui/Stats";

const HISTORY_SECONDS = 180;
const SAMPLE_RATE = 20;
const HISTORY_MAX = HISTORY_SECONDS * SAMPLE_RATE;

interface HistoryBuffer {
  t: number[];
  soc: number[];
  vBus: number[];
  rpm: number[];
  pGen: number[];
  pTrac: number[];
  pBatt: number[];
}

const createHistory = (): HistoryBuffer => ({
  t: [],
  soc: [],
  vBus: [],
  rpm: [],
  pGen: [],
  pTrac: [],
  pBatt: [],
});

const pushHistory = (history: HistoryBuffer, state: SimState) => {
  const push = (arr: number[], value: number) => {
    arr.push(value);
    if (arr.length > HISTORY_MAX) arr.shift();
  };
  push(history.t, state.timeSec);
  push(history.soc, state.soc);
  push(history.vBus, state.vBus);
  push(history.rpm, state.rpm);
  push(history.pGen, state.pGenElecKw);
  push(history.pTrac, state.pTracElecKw);
  push(history.pBatt, state.pBattKw);
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
  const [config, setConfig] = useState<SimConfig>(() => structuredClone(defaultConfig));
  const [inputs, setInputs] = useState<SimInputs>(() => structuredClone(defaultInputs));
  const [simState, setSimState] = useState<SimState | null>(null);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [recording, setRecording] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [renderTick, setRenderTick] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const historyRef = useRef<HistoryBuffer>(createHistory());

  useEffect(() => {
    const worker = new Worker(new URL("./worker/simWorker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.postMessage({ type: "init", config, inputs });

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "snapshot") {
        const nextState = data.state as SimState;
        setSimState(nextState);
        pushHistory(historyRef.current, nextState);
        setRenderTick((tick) => tick + 1);
      }
      if (data.type === "export") {
        downloadJson(data.payload as ExportPayload);
      }
    };

    return () => worker.terminate();
  }, []);

  const updateInputs = (patch: Partial<SimInputs>) => {
    setInputs((prev) => {
      const next = { ...prev, ...patch };
      workerRef.current?.postMessage({ type: "setInputs", inputs: patch });
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

  const handleLoadScripted = (points: ScriptedPoint[]) => {
    workerRef.current?.postMessage({ type: "loadScriptedInputs", inputs: points });
    updateInputs({ scenario: "scripted" });
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
          <select
            value={config.mode}
            onChange={(e) => updateConfig({ mode: e.target.value as SimConfig["mode"] })}
          >
            <option value="base">Base (Rectifier)</option>
            <option value="pro">Pro (Dual Inverter)</option>
          </select>
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
          onLoadScripted={handleLoadScripted}
        />
      </div>

      <div className="panel diagram">
        <Diagram state={simState} config={config} />
      </div>

      <div className="panel chart-grid">
        <Charts
          history={historyRef.current}
          tick={renderTick}
          tractionMaxKw={config.vehicle.wheelPowerMaxKw}
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
