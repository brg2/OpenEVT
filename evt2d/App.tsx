import React, { useEffect, useMemo, useRef, useState } from "react";
import { defaultConfig, defaultInputs } from "./sim/defaults";
import type { ExportPayload, SimConfig, SimInputs, SimState } from "./sim/types";
import Controls from "./ui/Controls";
import Diagram from "./ui/Diagram";
import Charts from "./ui/Charts";
import Stats from "./ui/Stats";
import { EngineSound } from "./audio/engineSound";

const HISTORY_SECONDS = 120;
const SAMPLE_RATE = 20;
const HISTORY_MAX = HISTORY_SECONDS * SAMPLE_RATE;
const STORAGE_KEY = "openevt-2d-sim";
const AUDIO_DEFAULT_VOLUME = 0.4;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

interface HistoryBuffer {
  t: number[];
  soc: number[];
  vBus: number[];
  rpm: number[];
  motorRpm: number[];
  speedMph: number[];
  fuelGph: number[];
  mpg: number[];
  pGen: number[];
  pTrac: number[];
  pBatt: number[];
}

declare global {
  interface Window {
    __openevt2d?: {
      getConfig: () => SimConfig;
      getInputs: () => SimInputs;
      getState: () => SimState | null;
      getHistory: () => HistoryBuffer;
      exportHistoryCsv: () => string;
      downloadHistoryCsv: () => void;
    };
  }
}

const createHistory = (): HistoryBuffer => ({
  t: [],
  soc: [],
  vBus: [],
  rpm: [],
  motorRpm: [],
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
  push(history.motorRpm, state.motorRpm);
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
  const mpgRaw = avgFuel > 1e-6 ? avgSpeed / avgFuel : 100;
  const mpg60 = Math.min(100, Math.max(0, mpgRaw));
  push(history.mpg, mpg60);
  push(history.pGen, state.pGenElecKw);
  push(history.pTrac, state.pTracElecKw);
  push(history.pBatt, state.pBattKw);
};

const historyToCsv = (history: HistoryBuffer): string => {
  const cols: Array<keyof HistoryBuffer> = [
    "t",
    "soc",
    "vBus",
    "rpm",
    "motorRpm",
    "speedMph",
    "fuelGph",
    "mpg",
    "pGen",
    "pTrac",
    "pBatt",
  ];
  const n = history.t.length;
  const header = cols.join(",");
  const lines: string[] = [header];
  for (let i = 0; i < n; i += 1) {
    lines.push(
      cols
        .map((c) => {
          const v = history[c][i];
          return Number.isFinite(v) ? String(v) : "";
        })
        .join(","),
    );
  }
  return lines.join("\n");
};

const downloadText = (filename: string, text: string, type = "text/plain") => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  downloadText(
    "openevt-2d-sim-export.json",
    JSON.stringify(payload, null, 2),
    "application/json",
  );
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
          if (!(merged.vehicle as any).tracRampKwPerS) (merged.vehicle as any).tracRampKwPerS = 300;
          if (!Number.isFinite((merged.vehicle as any).evAssistStrength))
            (merged.vehicle as any).evAssistStrength = 0.5;
          if (!(merged.engine as any).effRpm) merged.engine.effRpm = (merged.engine.idleRpm + merged.engine.redlineRpm) * 0.5;
          if (!(merged.engine as any).cylinders) merged.engine.cylinders = 8;
          if (!(merged.engine as any).controlMode) (merged.engine as any).controlMode = "bsfc_island";
          if (!(merged.engine as any).bsfcProfileId) (merged.engine as any).bsfcProfileId = "custom";
          if ((merged.engine as any).bsfcProfileId === "custom") {
            const e = merged.engine;
            const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
            const id = (() => {
              if (e.cylinders === 6 && e.redlineRpm <= 2600 && e.maxPowerKw >= 240) return "cummins-l9-bus";
              if (e.cylinders === 6 && e.redlineRpm <= 3500 && e.maxPowerKw >= 350) return "6bt-400kw";
              if (e.cylinders === 8 && near(e.redlineRpm, 5200) && near(e.maxPowerKw, 220)) return "7.4l-carb";
              if (e.cylinders === 8 && near(e.redlineRpm, 5200) && near(e.maxPowerKw, 230)) return "7.4l-efi";
              if (e.cylinders === 8 && near(e.redlineRpm, 6000) && near(e.maxPowerKw, 240)) return "lq4-6.0l";
              if (e.cylinders === 8 && near(e.redlineRpm, 5600) && near(e.maxPowerKw, 180)) return "5l";
              if (e.cylinders === 6 && near(e.redlineRpm, 6000) && near(e.maxPowerKw, 140)) return "3l";
              if (e.cylinders === 4 && near(e.redlineRpm, 6200) && near(e.maxPowerKw, 120)) return "2.5l";
              if (e.cylinders === 4 && near(e.redlineRpm, 6500) && near(e.maxPowerKw, 105)) return "2l";
              if (e.cylinders === 4 && near(e.redlineRpm, 6800) && near(e.maxPowerKw, 85)) return "1.5l";
              return null;
            })();
            if (id) (merged.engine as any).bsfcProfileId = id;
          }
          if ((merged.engine as any).controlMode === "auto_sport") {
            (merged.engine as any).controlMode = "bsfc_island";
          }
          if (!(merged.generator as any).controlMode) {
            (merged.generator as any).controlMode = (merged.engine as any).controlMode ?? "bsfc_island";
          }
          if (!(merged.generator as any).demandRampKwPerS) (merged.generator as any).demandRampKwPerS = 120;
          if ((merged.generator as any).controlMode === "auto_sport") {
            (merged.generator as any).controlMode = "bsfc_island";
          }
          if ((merged.engine as any).controlMode === "auto_standard") {
            (merged.engine as any).controlMode = "bsfc_island";
          }
          if ((merged.generator as any).controlMode === "auto_standard") {
            (merged.generator as any).controlMode = "bsfc_island";
          }
          if (!(merged.engine as any).apsOn) merged.engine.apsOn = 0.05;
          if (!(merged.engine as any).apsOff) merged.engine.apsOff = 0.03;
          if (!(merged.engine as any).islandRpmMin) merged.engine.islandRpmMin = Math.max(merged.engine.idleRpm, merged.engine.effRpm * 0.8);
          if (!(merged.engine as any).islandRpmMax) merged.engine.islandRpmMax = Math.min(merged.engine.redlineRpm, merged.engine.effRpm * 1.3);
          if (!(merged.engine as any).islandTqMinNm) merged.engine.islandTqMinNm = 200;
          if (!(merged.engine as any).islandTqMaxNm) merged.engine.islandTqMaxNm = 600;
          if (!(merged.engine as any).pEpsilonKw) merged.engine.pEpsilonKw = 2;
          if (!(merged.engine as any).minOnTimeSec) merged.engine.minOnTimeSec = 1.0;
          if (!(merged.engine as any).minOffTimeSec) merged.engine.minOffTimeSec = 1.0;
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
          const aps =
            typeof parsed.inputs.aps === "number"
              ? parsed.inputs.aps
              : (typeof parsed.inputs.tps === "number" ? parsed.inputs.tps : defaultInputs.aps);
          return { ...defaultInputs, ...parsed.inputs, aps: clamp01(aps), tps: clamp01(aps) };
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
  const [audioEnabled, setAudioEnabled] = useState(() => {
    // Default to ON and persist the preference. If the browser blocks autoplay,
    // we defer actually starting audio until the next user gesture.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { audioEnabled?: boolean };
        if (typeof parsed.audioEnabled === "boolean") return parsed.audioEnabled;
      }
    } catch {
      // ignore
    }
    return true;
  });
  const [audioVolume, setAudioVolume] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { audioVolume?: number };
        if (typeof parsed.audioVolume === "number") return clamp01(parsed.audioVolume);
      }
    } catch {
      // ignore
    }
    return AUDIO_DEFAULT_VOLUME;
  });
  const [recording, setRecording] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [renderTick, setRenderTick] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const soundRef = useRef<EngineSound | null>(null);
  const historyRef = useRef<HistoryBuffer>(createHistory());
  const lastHistoryTimeRef = useRef<number>(-Infinity);

  useEffect(() => {
    window.__openevt2d = {
      getConfig: () => structuredClone(config),
      getInputs: () => structuredClone(inputs),
      getState: () => (simState ? structuredClone(simState) : null),
      getHistory: () => structuredClone(historyRef.current),
      exportHistoryCsv: () => historyToCsv(historyRef.current),
      downloadHistoryCsv: () => {
        downloadText("openevt-2d-history.csv", historyToCsv(historyRef.current), "text/csv");
      },
    };
    return () => {
      delete window.__openevt2d;
    };
  }, [config, inputs, simState]);

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
          audioEnabled,
          audioVolume,
        }),
      );
    } catch {
      // ignore
    }
  }, [config, inputs, speed, audioEnabled, audioVolume]);

  useEffect(() => {
    const sound = soundRef.current;
    if (!sound) return;
    void sound.setEnabled(audioEnabled);
  }, [audioEnabled, audioVolume]);

  useEffect(() => {
    if (!audioEnabled) return;

    let armed = true;
    const ensureSound = () => {
      if (!soundRef.current) {
        soundRef.current = new EngineSound();
      }
      soundRef.current.setVolume(audioVolume);
      return soundRef.current;
    };
    const tryStart = async () => {
      if (!armed) return;
      const sound = ensureSound();
      const ok = await sound.setEnabled(true);
      if (!ok) return;
      armed = false;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
    const onGesture = () => {
      void tryStart();
    };

    // Start on next user gesture (avoids autoplay warnings while still defaulting to ON).
    window.addEventListener("pointerdown", onGesture, true);
    window.addEventListener("keydown", onGesture, true);

    return () => {
      armed = false;
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
  }, [audioEnabled, audioVolume]);

  useEffect(() => {
    if (!audioEnabled) return;
    if (!simState) return;
    const sound = soundRef.current;
    if (!sound) return;
    sound.update({
      rpm: simState.rpm,
      cylinders: config.engine.cylinders,
      mode: simState.engineMode,
      genKw: simState.pGenElecKw,
      genKwMax: config.generator.maxElecKw,
      tqNmMax: config.engine.islandTqMaxNm,
    });
  }, [
    audioEnabled,
    simState,
    config.engine.cylinders,
    config.engine.islandTqMaxNm,
    config.generator.maxElecKw,
  ]);

  useEffect(() => {
    const sound = soundRef.current;
    if (!sound) return;
    sound.setVolume(audioVolume);
  }, [audioVolume]);

  useEffect(() => {
    return () => {
      soundRef.current?.dispose();
      soundRef.current = null;
    };
  }, []);

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
          audioEnabled={audioEnabled}
          audioVolume={audioVolume}
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
          onAudioEnabled={setAudioEnabled}
          onAudioVolume={setAudioVolume}
        />
      </div>

      <div className="panel diagram">
        <Diagram state={simState} config={config} />
      </div>

      <div className="panel chart-grid">
        <Charts
          history={historyRef.current}
          tick={renderTick}
          busMin={config.bus.vMin}
          busMax={config.bus.vMax}
          socMin={config.battery.socMin}
          socMax={config.battery.socMax}
          socTarget={config.battery.socTarget}
          battMaxDischargeKw={config.battery.maxDischargeKw}
          battMaxChargeKw={config.battery.maxChargeKw}
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
